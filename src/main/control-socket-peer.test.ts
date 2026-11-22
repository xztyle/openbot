import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostStatus } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { type ControlPeerReport, classifyControlPeer, parseControlPeerReport } from "./control-socket-peer";
import { ServerMode, type ServerModeOptions } from "./server-mode";

const SELF = { pid: 7, uid: 1000, cgroup: "0::/system.slice/openbot.service" };

function report(chain: [number, number][], extra: Partial<ControlPeerReport> = {}): ControlPeerReport {
  return { pid: chain[0]?.[0] ?? 0, uid: 1000, chain, cgroup: SELF.cgroup, alive: "yes", ...extra };
}

describe("classifyControlPeer", () => {
  it("refuses a process that descends from main", () => {
    expect(
      classifyControlPeer(
        report([
          [300, 200],
          [200, 7],
          [7, 1],
          [1, 0],
        ]),
        SELF,
      ),
    ).toBe("agent");
  });

  it("refuses an orphan of an agent that PID 1 adopted in the service's cgroup", () => {
    expect(
      classifyControlPeer(
        report([
          [300, 1],
          [1, 0],
        ]),
        SELF,
      ),
    ).toBe("agent");
  });

  it("accepts a process that docker exec put into the container", () => {
    expect(
      classifyControlPeer(
        report([
          [400, 399],
          [399, 0],
        ]),
        SELF,
      ),
    ).toBe("operator");
  });

  it("accepts an operator's login shell in a cgroup of its own", () => {
    const shell = report(
      [
        [500, 490],
        [490, 1],
        [1, 0],
      ],
      { cgroup: "0::/user.slice/user-1000.slice/session-3.scope" },
    );
    expect(classifyControlPeer(shell, SELF)).toBe("operator");
  });

  it("refuses a peer that exited, a broken chain, another user and an unreadable cgroup", () => {
    const outside: [number, number][] = [
      [400, 399],
      [399, 0],
    ];
    expect(classifyControlPeer(report(outside, { alive: "no" }), SELF)).toBe("agent");
    expect(classifyControlPeer(report(outside, { uid: 1001 }), SELF)).toBe("agent");
    expect(classifyControlPeer(report([[400, 399]]), SELF)).toBe("agent");
    expect(
      classifyControlPeer(
        report([
          [400, 399],
          [398, 0],
        ]),
        SELF,
      ),
    ).toBe("agent");
    expect(
      classifyControlPeer(
        report(
          [
            [300, 1],
            [1, 0],
          ],
          { cgroup: "" },
        ),
        SELF,
      ),
    ).toBe("agent");
    expect(classifyControlPeer(report(outside, { uid: 0 }), SELF)).toBe("operator");
  });
});

describe("parseControlPeerReport", () => {
  it("reads the helper's lines", () => {
    expect(parseControlPeerReport("peer 40 1000\nchain 40 39\nchain 39 0\ncgroup 0::/\nalive yes\n")).toEqual({
      pid: 40,
      uid: 1000,
      chain: [
        [40, 39],
        [39, 0],
      ],
      cgroup: "0::/",
      alive: "yes",
    });
    expect(parseControlPeerReport("chain 40 39\nalive yes\n")).toBeNull();
    expect(parseControlPeerReport("peer 40 1000\n")).toBeNull();
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function stubOptions(controlSocketPath: string): ServerModeOptions {
  const unused = () => Effect.die(new Error("not used in this test"));
  const status: HostStatus = {
    phase: "unconfigured",
    configured: false,
    enabledOnLaunch: false,
    serverId: null,
    serverName: null,
    apiUrl: null,
    logoUrl: null,
    apiOnline: false,
    remoteDesktopReady: false,
    remoteDesktopScreenRecordingDenied: false,
    remoteDesktopUnattended: false,
    remoteDesktopActiveSessions: 0,
    remoteDesktopMaxSessions: 0,
    message: null,
  };
  return {
    environment: { controlSocketPath },
    version: "test",
    centralAuth: {
      getState: () => ({ status: "signed_out" }),
      requestEmailCode: unused,
      verifyEmailCode: unused,
      canPersistSession: () => false,
      redeemServerClaim: unused,
      logout: () => Effect.succeed({ status: "signed_out" }),
      createMobileConnect: unused,
    },
    host: {
      getStatus: () => status,
      configure: unused,
      start: unused,
      updateIdentity: unused,
      getMobileConnectHost: () => null,
    },
    memory: null,
    onError: () => undefined,
    snapshot: (destination) => Effect.succeed({ path: destination, bytes: 1, schemaVersion: 1 }),
  };
}

function curl(socket: string, method: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["--silent", "--unix-socket", socket, "-X", method, "--write-out", "status=%{http_code}", `http://x${path}`],
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

describe.runIf(process.platform === "linux")("the control socket", () => {
  it("answers status to an agent and refuses it everything else", async () => {
    const directory = mkdtempSync(join(tmpdir(), "control-peer-"));
    const socket = join(directory, "control.sock");
    const server = new ServerMode(stubOptions(socket));
    await Effect.runPromise(server.listen());
    cleanups.push(() => {
      void Effect.runPromise(server.close());
      rmSync(directory, { recursive: true, force: true });
    });

    // curl is a child of this test process, so the socket takes it for an agent.
    expect(await curl(socket, "GET", "/v1/status")).toContain("status=200");
    expect(await curl(socket, "GET", "/v1/health")).toContain("status=200");
    for (const [method, path] of [
      ["POST", "/v1/mobile-connect"],
      ["POST", "/v1/logout"],
      ["POST", "/v1/backup"],
      ["POST", "/v1/agents/agent-a/message"],
      ["POST", "/v1/spaces/apply"],
      ["GET", "/v1/diagnostics"],
    ] as const) {
      const answer = await curl(socket, method, path);
      expect(answer).toContain("error=operator_only");
      expect(answer).toContain("status=403");
    }
  });

  it("answers an operator", async () => {
    const directory = mkdtempSync(join(tmpdir(), "control-peer-"));
    const socket = join(directory, "control.sock");
    const server = new ServerMode({ ...stubOptions(socket), caller: async () => "operator" });
    await Effect.runPromise(server.listen());
    cleanups.push(() => {
      void Effect.runPromise(server.close());
      rmSync(directory, { recursive: true, force: true });
    });
    expect(await curl(socket, "POST", "/v1/mobile-connect")).not.toContain("operator_only");
  });
});
