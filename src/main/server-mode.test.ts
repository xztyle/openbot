import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CentralAuthState, HostStatus } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeDatabaseSnapshot } from "../backend/database-snapshot";
import { runCauseEffect } from "../backend/effect-boundary";
import { RemoteWorkflowError, remoteCall } from "./remote-service-effects";
import type { ServerHealth } from "./server-health";
import { ServerMode, type ServerModeOptions, takeServerModeEnvironment } from "./server-mode";

const SESSION_TOKEN = "session-token-that-must-stay-in-main";

let directory: string;
let server: ServerMode | null = null;

beforeEach(async () => {
  // Short: a Unix socket path holds at most 103 characters on macOS.
  directory = await mkdtemp(join(tmpdir(), "ob-"));
  await chmod(directory, 0o700);
});

afterEach(async () => {
  if (server) await Effect.runPromise(server.close());
  server = null;
  await rm(directory, { recursive: true, force: true });
});

function fixture(extra: Partial<ServerModeOptions> = {}) {
  let state: CentralAuthState = { status: "signed_out" };
  let hostStatus: HostStatus = {
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
  const centralAuth = {
    getState: () => state,
    requestEmailCode: vi.fn((email: string) =>
      Effect.sync(() => {
        state = { status: "code_sent", challengeId: "challenge-1", email, expiresAt: 1, resendAvailableAt: 1 };
        return state;
      }),
    ),
    verifyEmailCode: vi.fn(() =>
      Effect.sync(() => {
        state = { status: "signed_in", user: { id: "u1", email: "owner@example.com", name: null, avatarUrl: null } };
        // The real manager keeps the token to itself; a leak would come from echoing what it holds.
        const held = { ...state, sessionToken: SESSION_TOKEN };
        return held;
      }),
    ),
    logout: vi.fn(() =>
      Effect.sync(() => {
        state = { status: "signed_out" };
        return state;
      }),
    ),
  };
  const host = {
    getStatus: () => hostStatus,
    configure: vi.fn(({ serverName }: { serverName: string }) =>
      remoteCall(async () => {
        await Promise.resolve();
        hostStatus = { ...hostStatus, phase: "idle", configured: true, serverName };
        return hostStatus;
      }),
    ),
    start: vi.fn(() =>
      remoteCall(async () => {
        hostStatus = { ...hostStatus, phase: "online" };
        return hostStatus;
      }),
    ),
    updateIdentity: vi.fn(({ serverName }: { serverName?: string }) =>
      remoteCall(async () => {
        hostStatus = { ...hostStatus, serverName: serverName ?? null };
        return hostStatus;
      }),
    ),
  };
  const mode = new ServerMode({
    environment: { controlSocketPath: join(directory, "control.sock") },
    version: "9.9.9",
    centralAuth,
    host,
    onError: () => undefined,
    ...extra,
  });
  return { mode, centralAuth, host };
}

function send(method: string, path: string, body = ""): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        socketPath: join(directory, "control.sock"),
        method,
        path,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

describe("takeServerModeEnvironment", () => {
  it("is off outside a packaged Linux server and on a hosted server", () => {
    const environment = { OPENBOT_SERVER: "1", XDG_RUNTIME_DIR: "/run/openbot" };
    expect(takeServerModeEnvironment(environment, true, "linux")).toEqual({
      controlSocketPath: "/run/openbot/control.sock",
    });
    expect(takeServerModeEnvironment(environment, false, "linux")).toBeNull();
    expect(takeServerModeEnvironment(environment, true, "darwin")).toBeNull();
    expect(takeServerModeEnvironment({ ...environment, OPENBOT_HOSTED_SERVER: "1" }, true, "linux")).toBeNull();
    expect(takeServerModeEnvironment({ ...environment, XDG_RUNTIME_DIR: "run" }, true, "linux")).toBeNull();
  });
});

describe("ServerMode control socket", () => {
  it("refuses a runtime directory that another user can enter", async () => {
    await chmod(directory, 0o750);
    server = fixture().mode;
    await expect(runCauseEffect(server.listen())).rejects.toThrow("private directory");
  });

  it("keeps a file at the socket path that is not a socket", async () => {
    await writeFile(join(directory, "control.sock"), "not ours");
    server = fixture().mode;
    await expect(runCauseEffect(server.listen())).rejects.toThrow("another file");
    expect((await stat(join(directory, "control.sock"))).isFile()).toBe(true);
  });

  it("makes a socket that only its owner can open", async () => {
    server = fixture().mode;
    await runCauseEffect(server.listen());
    expect((await stat(join(directory, "control.sock"))).mode & 0o777).toBe(0o600);
  });

  it("signs in with an email code, never sends the session back, and publishes once", async () => {
    const { mode, host, centralAuth } = fixture();
    server = mode;
    await runCauseEffect(server.listen());

    const started = await send("POST", "/v1/login/start", "email=owner%40example.com");
    expect(started).toEqual({ status: 200, text: "challenge=challenge-1\nexpires_at=1\n" });

    // The host refuses this name only when it publishes, after the sign-in. Nothing then says why.
    const short = await send("POST", "/v1/login/verify", "challenge=challenge-1&code=123456&name=Lab");
    expect(short).toEqual({
      status: 400,
      text: "error=invalid_name\nmessage=Server name must contain 6 to 32 characters.\n",
    });
    expect(centralAuth.verifyEmailCode).not.toHaveBeenCalled();

    const verified = await send("POST", "/v1/login/verify", "challenge=challenge-1&code=123456&name=Lab%20Server");
    expect(verified.status).toBe(200);
    expect(verified.text).not.toContain(SESSION_TOKEN);
    expect(verified.text).not.toContain("123456");
    expect(verified.text).toContain("account=signed_in\n");

    // The entry point and the start retry can both call this at the same time.
    await Promise.all([runCauseEffect(mode.publish()), runCauseEffect(mode.publish())]);
    expect(host.configure).toHaveBeenCalledOnce();
    const status = await send("GET", "/v1/status");
    expect(status.text).toContain("server=online\nserver_name=Lab Server\n");
  });

  it("shows why publishing failed, on one line", async () => {
    const { mode, host } = fixture();
    server = mode;
    await runCauseEffect(server.listen());
    await send("POST", "/v1/login/verify", "challenge=challenge-1&code=123456");
    host.configure.mockReturnValueOnce(
      Effect.fail(new RemoteWorkflowError({ cause: new Error("Refused.\naccount=x") })),
    );
    await expect(runCauseEffect(mode.publish())).rejects.toThrow("Refused.");

    // A message with a line break stays one line, so it cannot add a key.
    const status = await send("GET", "/v1/status");
    expect(status.text).toContain("server=unconfigured\nserver_message=Refused. account=x\n");
    expect(status.text.match(/^account=/gmu)).toHaveLength(1);
  });

  it("refuses a body that is too large and an unknown request", async () => {
    const { mode, centralAuth } = fixture();
    server = mode;
    await runCauseEffect(server.listen());
    const large = await send("POST", "/v1/login/start", `email=${"a".repeat(5000)}%40example.com`);
    expect(large).toEqual({ status: 413, text: "error=too_large\n" });
    expect(centralAuth.requestEmailCode).not.toHaveBeenCalled();
    expect((await send("DELETE", "/v1/status")).status).toBe(404);
  });
});

describe("ServerMode operator commands", () => {
  const healthy: ServerHealth = {
    healthy: true,
    problems: [],
    lines: {
      health: "ok",
      agent_init: "ok",
      schema_version: 31,
      uptime_s: 5,
      safe_to_restart: "no",
      busy: "agent-turn",
    },
  };

  it("adds the health lines to status and keeps the keys that scripts read", async () => {
    const { mode } = fixture({ health: () => healthy });
    server = mode;
    await runCauseEffect(server.listen());
    const status = await send("GET", "/v1/status");
    expect(status.status).toBe(200);
    expect(status.text).toMatch(/^version=9\.9\.9\naccount=signed_out\n/u);
    expect(status.text).toContain("server=unconfigured\n");
    expect(status.text).toContain("safe_to_restart=no\nbusy=agent-turn\n");
  });

  it("answers health with 200 when it works and 503 when it does not", async () => {
    let current = healthy;
    const { mode } = fixture({ health: () => current });
    server = mode;
    await runCauseEffect(server.listen());
    expect((await send("GET", "/v1/health")).status).toBe(200);
    current = {
      healthy: false,
      problems: ["agent_init_failed"],
      lines: { ...healthy.lines, health: "unhealthy", health_problems: "agent_init_failed", agent_init: "failed" },
    };
    const unhealthy = await send("GET", "/v1/health");
    expect(unhealthy.status).toBe(503);
    expect(unhealthy.text).toContain("healthy=no\nhealth_problems=agent_init_failed\nagent_init=failed\n");
  });

  it("writes a verified, private copy of the database and never replaces a file", async () => {
    const live = new DatabaseSync(join(directory, "openbot.db"));
    live.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    live.exec("INSERT INTO schema_migrations VALUES (31, 'now')");
    live.exec("CREATE TABLE notes (body TEXT)");
    live.exec("INSERT INTO notes VALUES ('kept')");
    try {
      const { mode } = fixture({ snapshot: (destination) => writeDatabaseSnapshot(live, destination) });
      server = mode;
      await runCauseEffect(server.listen());
      const target = join(directory, "snapshot.db");

      const written = await send("POST", "/v1/backup", `path=${encodeURIComponent(target)}`);
      expect(written.status).toBe(200);
      expect(written.text).toContain(`path=${target}\n`);
      expect(written.text).toContain("schema_version=31\nintegrity=ok\n");
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      const copy = new DatabaseSync(target, { readOnly: true });
      expect(copy.prepare("SELECT body FROM notes").all()).toEqual([{ body: "kept" }]);
      copy.close();

      const again = await send("POST", "/v1/backup", `path=${encodeURIComponent(target)}`);
      expect(again).toEqual({ status: 409, text: "error=exists\n" });
      expect((await send("POST", "/v1/backup", "path=relative.db")).text).toBe("error=invalid_path\n");
      expect((await send("POST", "/v1/backup", "path=")).status).toBe(400);
    } finally {
      live.close();
    }
  });

  it("runs one backup at a time", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { mode } = fixture({
      snapshot: (destination) =>
        Effect.promise(async () => {
          started?.();
          await gate;
          return { path: destination, bytes: 1, schemaVersion: 1 };
        }),
    });
    server = mode;
    await runCauseEffect(server.listen());
    const first = send("POST", "/v1/backup", "path=%2Ftmp%2Fa.db");
    await arrived;
    expect(await send("POST", "/v1/backup", "path=%2Ftmp%2Fb.db")).toEqual({
      status: 409,
      text: "error=backup_running\n",
    });
    release?.();
    expect((await first).status).toBe(200);
    // The slot is free again after the first one ends.
    expect((await send("POST", "/v1/backup", "path=%2Ftmp%2Fc.db")).status).toBe(200);
  });

  it("sends the diagnostics report as JSON", async () => {
    const { mode } = fixture({ diagnostics: () => Effect.succeed('{"schemaVersion":3}\n') });
    server = mode;
    await runCauseEffect(server.listen());
    expect(await send("GET", "/v1/diagnostics")).toEqual({ status: 200, text: '{"schemaVersion":3}\n' });
  });

  it("turns analytics off and on, and refuses on when the environment locks it off", async () => {
    const set = vi.fn(() => Effect.void);
    const open = fixture({ analytics: { lockedOff: false, set } });
    server = open.mode;
    await runCauseEffect(server.listen());
    expect((await send("POST", "/v1/analytics", "enabled=off")).status).toBe(200);
    expect(set).toHaveBeenLastCalledWith(false);
    expect((await send("POST", "/v1/analytics", "enabled=maybe")).status).toBe(400);
    await Effect.runPromise(server.close());

    const locked = fixture({ analytics: { lockedOff: true, set } });
    server = locked.mode;
    await runCauseEffect(server.listen());
    set.mockClear();
    expect(await send("POST", "/v1/analytics", "enabled=on")).toEqual({
      status: 409,
      text: "error=disabled_by_environment\n",
    });
    expect(set).not.toHaveBeenCalled();
  });

  it("answers 501 for an operator command that this server does not have", async () => {
    server = fixture().mode;
    await runCauseEffect(server.listen());
    for (const [method, path] of [
      ["POST", "/v1/backup"],
      ["GET", "/v1/diagnostics"],
      ["POST", "/v1/analytics"],
    ] as const) {
      expect((await send(method, path, method === "POST" ? "path=%2Ftmp%2Fx.db&enabled=off" : "")).status).toBe(501);
    }
  });
});
