// Drives the trust gate end to end below the providers: the real classifier, `TrustService` with its
// policy file and append-only audit files in a temporary folder, `TrustToolGate` with a recording
// client and attention double (the approval card and the decision card), and the trust-control-v1
// codecs. It needs no app and no provider: `bun scripts/trust-control-smoke.ts`.
// Writes .openbot-build/trust-control-smoke/report.json.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TRUST_CONTROL_CODECS, TRUST_CONTROL_ROUTES } from "@openbot/contracts/team-protocol/trust-control-v1";
import { DEFAULT_TRUST_POLICY, type TrustPolicy, trustAuditCsv } from "@openbot/contracts/trust-control";
import { Effect } from "effect";
import type { AppServerRequest } from "../src/backend/protocol";
import { TrustAuditLog } from "../src/backend/trust/trust-audit-log";
import { classifyCommand, classifyToolUse, TRUST_CHECK_METHOD } from "../src/backend/trust/trust-classifier";
import { TrustService } from "../src/backend/trust/trust-service";
import { type TrustAttention, type TrustClient, TrustToolGate } from "../src/backend/trust/trust-tool-gate";

const OUT = resolve(import.meta.dirname, "../.openbot-build/trust-control-smoke");
const dir = mkdtempSync(join(tmpdir(), "trust-smoke-"));
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
}

try {
  const agents = [
    { id: "lead-1", name: "Lia" },
    { id: "ana-1", name: "Ana", reportsToAgentId: "lead-1" },
  ];
  const trust = new TrustService({
    file: join(dir, "trust-policy.json"),
    audit: new TrustAuditLog(join(dir, "trust-audit")),
    directory: { agents: () => agents, spaceOf: () => "space-1" },
  });
  const policy: TrustPolicy = {
    ...DEFAULT_TRUST_POLICY,
    roles: { ...DEFAULT_TRUST_POLICY.roles, member: { ...DEFAULT_TRUST_POLICY.roles.member, launch_ads: "allow" } },
    agents: { "ana-1": { delete: "deny" } },
    // The defaults keep sandbox first off; the smoke turns it on for landings to drive the go-live.
    sandbox: { ...DEFAULT_TRUST_POLICY.sandbox, landings: true },
    budgets: [{ id: "meta-day", scope: "all", platform: "meta", perDay: 7, currency: "USD" }],
  };
  const defaults = DEFAULT_TRUST_POLICY.roles;
  check(
    "defaults ask only for money",
    (["lead", "member"] as const).every(
      (role) =>
        defaults[role].pay === "ask" &&
        defaults[role].launch_ads === "ask" &&
        (["publish", "email", "create_agent", "delete"] as const).every((action) => defaults[role][action] === "allow"),
    ) && !Object.values(DEFAULT_TRUST_POLICY.sandbox).some(Boolean),
  );
  await Effect.runPromise(trust.savePolicy(policy, { id: "owner", name: "Owner" }));
  check("policy file written 0600", (statSync(join(dir, "trust-policy.json")).mode & 0o777) === 0o600);

  // Budgets: 5 runs, then 3 asks (over 7/day) and a decline does not count.
  const subject = { agentId: "ana-1", threadId: "thread-1", turnId: "turn-1" };
  const meta = (amount: number) => classifyCommand(`M=/x/meta-ads.mjs\nnode "$M" set-budget 123 --daily ${amount}`);
  const first = meta(5);
  assert.ok(first);
  const cards: string[] = [];
  const answer = (value: "accept" | "decline") => (reason: string) => {
    cards.push(reason);
    return Effect.succeed(value);
  };
  check("under budget runs", (await Effect.runPromise(trust.gate(subject, first, answer("accept")))).allowed);
  check("no card under budget", cards.length === 0);
  const second = meta(3);
  assert.ok(second);
  const declined = await Effect.runPromise(trust.gate(subject, second, answer("decline")));
  check("over budget asks, decline refuses", !declined.allowed && cards.length === 1, cards[0]);
  const third = meta(2);
  assert.ok(third);
  check(
    "declined spend does not count",
    (await Effect.runPromise(trust.gate(subject, third, answer("accept")))).allowed && cards.length === 1,
  );

  // Deny and sandbox first.
  const del = classifyCommand("python3 /opt/appctl/appctl delete shop");
  assert.ok(del);
  const denied = await Effect.runPromise(trust.gate(subject, del, answer("accept")));
  check("agent deny refuses without a card", !denied.allowed && cards.length === 1);
  const publish = classifyCommand('R=/x/render-sites.mjs; node "$R" create promo --dir ./site');
  assert.ok(publish);
  const held = await Effect.runPromise(trust.gate(subject, publish, answer("accept")));
  check(
    "sandbox holds a landing without a preview",
    !held.allowed && !held.allowed && held.message.includes("request_decision"),
  );
  check(
    "staging copy runs",
    classifyCommand('R=/x/render-sites.mjs; node "$R" create promo-preview --dir ./site') === null,
  );

  // The decision card: an approved go-live opens the pass for the publish.
  const responses: unknown[] = [];
  const client: TrustClient = {
    running: true,
    respond: (_id, result) => {
      responses.push(result);
    },
  };
  const captured: { block?: Parameters<TrustAttention["surfaceUiBlock"]>[2] } = {};
  const attention: TrustAttention = {
    awaitToolApproval: () => Effect.succeed("accept"),
    surfaceUiBlock: (_client, _request, block) => {
      captured.block = block;
    },
  };
  const gate = new TrustToolGate({
    trust,
    attention,
    agentForThread: () => "ana-1",
    publicThreadId: (_agent, thread) => thread,
    listTabs: () => [],
    messagingThread: () => false,
  });
  const request = (method: string, params: unknown): AppServerRequest => ({ method, id: responses.length + 1, params });
  gate.requestDecision(client, request("item/tool/call", {}), {
    threadId: "thread-1",
    turnId: "turn-2",
    callId: "call-1",
    namespace: "openbot",
    tool: "request_decision",
    arguments: {
      title: "Publish the promo landing?",
      options: [{ label: "Publish", consequence: "promo.example.com goes live" }],
      previewUrl: "https://promo-preview.onrender.com",
      goLive: "landings",
      ticket: "UO-42",
    },
  });
  const block = captured.block;
  check("decision card surfaced as a card", block?.card === true && block.spec.type === "confirm", block?.spec);
  const result = block?.onAnswer?.(
    { actionId: "option1" },
    { privileged: true, sender: { id: "owner", name: "Owner" } },
  );
  check("approved go-live tells the agent", JSON.stringify(result).includes("approved"), result);
  check(
    "publish runs after go-live",
    (await Effect.runPromise(trust.gate(subject, publish, answer("accept")))).allowed,
  );

  // The Claude hook's request: check, then approve.
  const bash = { command: 'M=/x/meta-ads.mjs\nnode "$M" set-budget 9 --daily 4' };
  check("hook classifies Bash", classifyToolUse("Bash", bash) !== null);
  await Effect.runPromise(
    gate.handleTrustCheck(
      client,
      request(TRUST_CHECK_METHOD, {
        threadId: "thread-1",
        turnId: "t",
        toolName: "Bash",
        toolInput: bash,
        phase: "check",
      }),
    ),
  );
  check(
    "hook check answers ask over budget",
    JSON.stringify(responses.at(-1)) === '{"decision":"ask"}',
    responses.at(-1),
  );
  await Effect.runPromise(
    gate.handleTrustCheck(
      client,
      request(TRUST_CHECK_METHOD, {
        threadId: "thread-1",
        turnId: "t",
        toolName: "Bash",
        toolInput: bash,
        phase: "approve",
      }),
    ),
  );
  check(
    "hook approve answers allow after the card",
    JSON.stringify(responses.at(-1)) === '{"decision":"allow"}',
    responses.at(-1),
  );
  await Effect.runPromise(
    gate.handleTrustCheck(
      client,
      request(TRUST_CHECK_METHOD, {
        threadId: "thread-1",
        turnId: "t",
        toolName: "Bash",
        toolInput: { command: "ls -la" },
        phase: "check",
      }),
    ),
  );
  check("ordinary command is allowed with no row", JSON.stringify(responses.at(-1)) === '{"decision":"allow"}');

  // The audit trail: append-only files, redaction, query and CSV.
  trust.record({
    actor: { kind: "agent", id: "ana-1", name: "Ana" },
    category: "send",
    action: "resend API",
    summary: "curl -H 'Authorization: Bearer re_live_0123456789abcdefghij' https://api.resend.com/emails",
    outcome: "allowed",
    agentId: "ana-1",
  });
  const files = readdirSync(join(dir, "trust-audit"));
  const text = files.map((file) => readFileSync(join(dir, "trust-audit", file), "utf8")).join("");
  check(
    "audit file per month, 0600",
    files.length === 1 && (statSync(join(dir, "trust-audit", files[0] ?? "")).mode & 0o777) === 0o600,
  );
  check("audit redacts a bearer token", !text.includes("re_live_0123456789abcdefghij"));
  const spend = trust.audit.query({ category: "spend" });
  check("audit query filters", spend.length > 0 && spend.every((entry) => entry.category === "spend"), spend.length);
  const decisions = trust.audit.query({ text: "UO-42" });
  check("decision recorded with its ticket", decisions.length === 1 && decisions[0]?.outcome === "approved");
  const decision = decisions[0];
  assert.ok(decision);
  const csv = trustAuditCsv([{ ...decision, summary: "=HYPERLINK(1)" }]);
  check("CSV guards formulas", csv.includes("'=HYPERLINK(1)"));

  // The wire codecs accept what the host sends.
  const view = trust.view();
  const policyCodec = TRUST_CONTROL_CODECS.get(TRUST_CONTROL_ROUTES.policy);
  const auditCodec = TRUST_CONTROL_CODECS.get(TRUST_CONTROL_ROUTES.audit);
  check("policy view decodes", JSON.stringify(policyCodec?.response(200, view)) === JSON.stringify(view));
  check("audit page decodes", Boolean(auditCodec?.response(200, { entries: trust.audit.query({ limit: 50 }) })));
  check(
    "spend rows sum the counted spend",
    view.spend.some((row) => row.platform === "meta" && row.today === 11),
    view.spend,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const passed = checks.every((entry) => entry.ok);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
for (const entry of checks) process.stdout.write(`${entry.ok ? "ok  " : "FAIL"} ${entry.name}\n`);
if (!passed) process.exit(1);
