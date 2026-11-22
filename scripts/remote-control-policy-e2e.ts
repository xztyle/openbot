// Checks who may control this computer through remote desktop (upstream f9ca3ddda, S14). Runs the
// real remote-screen route on a local HTTP server, for each role and each access level, on a host
// with no remote desktop runtime, as the server is. A refused role gets 403 with the policy text
// before the route looks for the runtime; an allowed role reaches it and gets `host_unavailable`.
// The policy file of the real store is read for each case, with Atelier's default when it is missing.
// Run: `bun scripts/remote-control-policy-e2e.ts`. Writes .openbot-build/remote-control-policy-e2e/report.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RemoteControlAccess, TeamRole } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { createRemoteControlPolicyStore, type RemoteControlPolicyStore } from "../src/main/remote-control-policy-store";
import { RemoteScreenError } from "../src/main/remote-screen-gateway";
import { HttpError } from "../src/main/team-api/http-error";
import { routeRemoteScreen } from "../src/main/team-api/route-remote-screen";

const OUT = resolve(import.meta.dirname, "../.openbot-build/remote-control-policy-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-remote-control-policy-"));
const policyPath = join(root, "openbot-remote-control-policy-v1.json");

interface CaseResult {
  access: RemoteControlAccess | "default";
  role: TeamRole;
  status: number;
  message: string;
  expected: "refused" | "allowed";
  passed: boolean;
}

let role: TeamRole = "member";
let policy: RemoteControlPolicyStore = createRemoteControlPolicyStore(policyPath);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const reply = (status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ message }));
    return "handled" as const;
  };
  routeRemoteScreen(
    {
      request: req,
      response: res,
      method: req.method ?? "GET",
      url,
      protocol: 4,
      capabilities: new Set(),
      member: { id: `member-${role}`, username: role, email: null, name: role, role, createdAt: "", disabled: false },
      token: "token",
      sessionId: "session",
      sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      agentLevel: () => "manage",
      json: (status) => reply(status, "ok"),
      encodedJson: (status) => reply(status, "ok"),
      responseRoute: () => {
        throw new Error("Not used.");
      },
      empty: (status) => reply(status, ""),
    },
    { store: { getIdentity: () => null }, remoteControlAccess: () => policy.get().access },
  ).catch((error: unknown) => {
    if (error instanceof HttpError || error instanceof RemoteScreenError) reply(error.status, error.message);
    else reply(500, String(error));
  });
});
await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("The test server has no port.");
const { port } = address;

function post(path: string): Promise<{ status: number; message: string }> {
  return new Promise((done, fail) => {
    const call = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const parsed: { message?: unknown } = JSON.parse(body);
          done({ status: res.statusCode ?? 0, message: typeof parsed.message === "string" ? parsed.message : "" });
        });
      },
    );
    call.on("error", fail);
    call.end("{}");
  });
}

const refusal = sourceText("error.remote.controlNotAllowed");
const allows: Record<RemoteControlAccess | "default", TeamRole[]> = {
  default: ["owner", "admin"],
  owner: ["owner"],
  admins: ["owner", "admin"],
  members: ["owner", "admin", "member"],
};
const results: CaseResult[] = [];
try {
  for (const access of ["default", "owner", "admins", "members"] as const) {
    if (access === "default") await rm(policyPath, { force: true });
    else await writeFile(policyPath, JSON.stringify({ version: 1, access, askOnHost: false }));
    policy = createRemoteControlPolicyStore(policyPath);
    await Effect.runPromise(policy.load());
    for (const nextRole of ["owner", "admin", "member"] as const) {
      role = nextRole;
      const answer = await post(TEAM_API_ROUTES.remoteScreen.sessions);
      const expected = allows[access].includes(nextRole) ? "allowed" : "refused";
      const passed =
        expected === "refused" ? answer.status === 403 && answer.message === refusal : answer.status === 503;
      results.push({ access, role: nextRole, ...answer, expected, passed });
    }
  }
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
const report = { passed: results.every((result) => result.passed), results };
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.passed ? 0 : 1);
