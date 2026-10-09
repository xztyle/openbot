/**
 * A self-hosted server: the packaged Linux build that `install-server.sh` installs on a computer
 * with no screen. systemd starts it with `OPENBOT_SERVER=1` under a virtual display, and it is a
 * normal Remote host after its owner signs in.
 *
 * Nobody can use the window, so the `openbot` terminal command (`scripts/hosting/openbot`) talks to
 * this process over a Unix socket in the runtime directory that systemd makes for the service user
 * (mode 0700). Only that user and root can connect. Agents run as the same user and already have
 * full access to its files, so the socket gives them nothing new. The socket answers a closed list
 * of requests: status, health, the email-code sign-in, the server name, sign-out, an operator-started
 * database snapshot, the sanitized diagnostics report and the analytics switch. It never sends the
 * session token or the sign-in code back.
 *
 * The protocol is HTTP with form bodies and `key=value` text lines, so the command needs only
 * `curl --unix-socket`.
 */

import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { parseHostedServerName } from "@openbot/contracts/hosted-servers";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { CentralAuthState } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Deferred, Effect } from "effect";
import type { DatabaseSnapshot, DatabaseSnapshotError } from "../backend/database-snapshot";
import { runCauseEffect } from "../backend/effect-boundary";
import type { CentralAuthManager } from "./central-auth-manager";
import type { HostService } from "./host-service";
import { readBodyWithin } from "./http-body";
import { RemoteWorkflowError, remoteCall } from "./remote-service-effects";
import type { ServerHealth } from "./server-health";

const CONTROL_SOCKET_FILE = "control.sock";
const MAX_BODY_BYTES = 4096;
const MAX_EMAIL_LENGTH = 254;
/** The name of a server whose owner signed in without one. The same default as a mobile connect. */
const DEFAULT_SERVER_NAME = "OpenBot";

export interface ServerModeEnvironment {
  controlSocketPath: string;
}

/** Returns null unless this process is a self-hosted server that systemd started. */
export function takeServerModeEnvironment(
  environment: NodeJS.ProcessEnv,
  isPackaged: boolean,
  platform: NodeJS.Platform,
): ServerModeEnvironment | null {
  if (!isPackaged || platform !== "linux" || environment.OPENBOT_SERVER !== "1") return null;
  // A hosted server signs in with its claim, not from a terminal.
  if (environment.OPENBOT_HOSTED_SERVER === "1") return null;
  const runtimeDirectory = environment.XDG_RUNTIME_DIR?.trim() ?? "";
  if (!isAbsolute(runtimeDirectory)) return null;
  return { controlSocketPath: join(runtimeDirectory, CONTROL_SOCKET_FILE) };
}

/** The analytics switch of this server. The environment can force it off for the whole run. */
export interface ServerModeAnalytics {
  /** True when the environment turns analytics off. A request cannot turn it on then. */
  lockedOff: boolean;
  set: (enabled: boolean) => Effect.Effect<void, { readonly cause: unknown }>;
}

export interface ServerModeOptions {
  environment: ServerModeEnvironment;
  version: string;
  centralAuth: Pick<CentralAuthManager, "getState" | "requestEmailCode" | "verifyEmailCode" | "logout">;
  host: Pick<HostService, "getStatus" | "configure" | "start" | "updateIdentity">;
  onError: (message: string, error: unknown) => void;
  /** Operator actions are logged, so `docker logs` shows that a snapshot or a switch happened. */
  log?: (message: string) => void;
  /** Reads the state of the server for `status` and `health`. Without it, `status` shows only the account and the host. */
  health?: () => ServerHealth;
  /** Writes a verified copy of the database. Only a request from the operator calls it. */
  snapshot?: (destination: string) => Effect.Effect<DatabaseSnapshot, DatabaseSnapshotError>;
  /** The sanitized diagnostics report, as JSON text. */
  diagnostics?: () => Effect.Effect<string, { readonly cause: unknown }>;
  analytics?: ServerModeAnalytics;
  /** Tests only. */
  uid?: number;
}

interface Answer {
  status: number;
  lines: Record<string, string | number | null>;
  /** A whole body instead of lines, for the report. */
  body?: string;
}

/** The HTTP status of each way a snapshot can fail. The CLI turns the code into a sentence. */
const SNAPSHOT_FAILURE_STATUS: Record<DatabaseSnapshotError["code"], number> = {
  invalid_path: 400,
  no_directory: 400,
  exists: 409,
  no_space: 507,
  backup_failed: 500,
  verify_failed: 500,
  write_failed: 500,
};

export class ServerMode {
  readonly #options: ServerModeOptions;
  readonly #sockets = new Set<Socket>();
  #server: Server | null = null;
  #pendingName: string | null = null;
  /** Why the last publish failed. Nobody reads the journal, so `status` shows it. */
  #publishError: string | null = null;
  #publishing: Deferred.Deferred<void> | null = null;
  /** One snapshot at a time: two copies would compete for the disk and the main thread. */
  #snapshotRunning = false;

  constructor(options: ServerModeOptions) {
    this.#options = options;
  }

  /** Binds the control socket. It refuses a runtime directory that another user could enter. */
  readonly listen = Effect.fn("ServerMode.listen")(function* (this: ServerMode) {
    const path = this.#options.environment.controlSocketPath;
    const directory = yield* remoteCall(() => lstat(dirname(path)));
    const uid = this.#options.uid ?? process.getuid?.();
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) {
      return yield* new RemoteWorkflowError({
        cause: new Error("The server runtime directory must be a private directory of the service user."),
      });
    }
    // A socket from the last run stays after a crash. Anything else at that path is not ours.
    const existing = yield* remoteCall(() =>
      lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    );
    if (existing && !existing.isSocket()) {
      return yield* new RemoteWorkflowError({ cause: new Error("The control socket path holds another file.") });
    }
    if (existing) yield* remoteCall(() => unlink(path));

    const server = createServer((request, response) => void this.#handle(request, response));
    server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
    yield* remoteCall(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(path, () => {
            server.removeListener("error", reject);
            resolve();
          });
        }),
    );
    this.#server = server;
    yield* remoteCall(() => chmod(path, 0o600));
  }).bind(this);

  readonly close = Effect.fn("ServerMode.close")(function* (this: ServerMode) {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    yield* Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    });
  }).bind(this);

  /**
   * Names and starts the host of the signed-in account. The entry point calls this after each
   * sign-in and at the start, and the start retry calls it after a failure. Calls run one at a time,
   * so two callers never name two hosts.
   */
  readonly publish = Effect.fn("ServerMode.publish")(function* (this: ServerMode) {
    const previous = this.#publishing;
    const completed = Deferred.makeUnsafe<void>();
    this.#publishing = completed;
    return yield* Effect.gen({ self: this }, function* () {
      if (previous) yield* Deferred.await(previous);
      this.#publishError = null;
      if (this.#options.centralAuth.getState().status !== "signed_in") return;
      const { host } = this.#options;
      const serverName = this.#pendingName;
      // Only the owner supplies a name; it also renames the account's existing host.
      if (!host.getStatus().configured) yield* host.configure({ serverName: serverName ?? DEFAULT_SERVER_NAME });
      else if (serverName && host.getStatus().serverName !== serverName) yield* host.updateIdentity({ serverName });
      this.#pendingName = null;
      yield* host.start();
    }).pipe(
      Effect.tapError(({ cause }) =>
        Effect.sync(() => {
          this.#publishError = cause instanceof Error ? cause.message : sourceText("error.host.publishFailed");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (this.#publishing === completed) this.#publishing = null;
          Deferred.doneUnsafe(completed, Effect.void);
        }),
      ),
    );
  }, Effect.uninterruptible).bind(this);

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let answer: Answer;
    try {
      const body = await readBody(request);
      answer = body === null ? failure(413, "too_large") : await this.#route(request.method, request.url, body);
    } catch (error) {
      this.#options.onError("A server control request failed.", error);
      // The messages of the account and host services are the ones the app shows. They name no secret.
      answer = failure(400, "failed", error instanceof Error ? error.message : null);
    }
    response
      .writeHead(answer.status, {
        "content-type": answer.body === undefined ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(answer.body ?? formatLines(answer.lines));
  }

  async #route(method: string | undefined, url: string | undefined, body: URLSearchParams): Promise<Answer> {
    const path = url?.split("?")[0] ?? "";
    const route = `${method ?? ""} ${path}`;
    switch (route) {
      case "GET /v1/status":
        return this.#status();
      case "POST /v1/login/start":
        return runCauseEffect(this.#startLogin(body.get("email") ?? "", body.get("name")));
      case "POST /v1/login/verify":
        return runCauseEffect(this.#verifyLogin(body.get("challenge") ?? "", body.get("code") ?? "", body.get("name")));
      case "POST /v1/name":
        return runCauseEffect(this.#rename(body.get("name") ?? ""));
      case "GET /v1/health":
        return this.#health();
      case "GET /v1/diagnostics":
        return runCauseEffect(this.#diagnostics());
      case "POST /v1/backup":
        return runCauseEffect(this.#backup(body.get("path") ?? ""));
      case "POST /v1/analytics":
        return runCauseEffect(this.#setAnalytics(body.get("enabled") ?? ""));
      case "POST /v1/logout":
        await runCauseEffect(
          this.#options.centralAuth.logout().pipe(Effect.mapError(({ cause }) => new RemoteWorkflowError({ cause }))),
        );
        return this.#status();
      default:
        return failure(404, "not_found");
    }
  }

  #status(): Answer {
    const account = this.#options.centralAuth.getState();
    const host = this.#options.host.getStatus();
    return {
      status: 200,
      lines: {
        version: this.#options.version,
        account: account.status,
        email: account.status === "signed_in" ? account.user.email : null,
        account_message: account.status === "error" ? account.issue.message : null,
        server: host.phase,
        server_name: host.serverName ?? this.#pendingName,
        server_message: this.#publishError ?? host.message,
        ...this.#options.health?.().lines,
      },
    };
  }

  /** 200 when the server can work, 503 when not. A Docker health check reads only the status code. */
  #health(): Answer {
    const health = this.#options.health?.();
    if (!health) return { status: 200, lines: { healthy: "yes" } };
    const { lines } = health;
    return {
      status: health.healthy ? 200 : 503,
      lines: {
        healthy: health.healthy ? "yes" : "no",
        health_problems: lines.health_problems ?? null,
        agent_init: lines.agent_init ?? null,
        agent_init_message: lines.agent_init_message ?? null,
        schema_version: lines.schema_version ?? null,
        uptime_s: lines.uptime_s ?? null,
      },
    };
  }

  readonly #diagnostics = Effect.fn("ServerMode.diagnostics")(function* (
    this: ServerMode,
  ): Effect.fn.Return<Answer, { readonly cause: unknown }> {
    const { diagnostics } = this.#options;
    if (!diagnostics) return failure(501, "unavailable");
    return { status: 200, lines: {}, body: yield* diagnostics() };
  });

  readonly #backup = Effect.fn("ServerMode.backup")(function* (
    this: ServerMode,
    path: string,
  ): Effect.fn.Return<Answer, never> {
    const { snapshot } = this.#options;
    if (!snapshot) return failure(501, "unavailable");
    if (!path.trim()) return failure(400, "invalid_path");
    if (this.#snapshotRunning) return failure(409, "backup_running");
    this.#snapshotRunning = true;
    return yield* snapshot(path).pipe(
      Effect.map((result): Answer => {
        this.#options.log?.(`A database snapshot was written (${result.bytes} bytes, schema ${result.schemaVersion}).`);
        return {
          status: 200,
          lines: { path: result.path, bytes: result.bytes, schema_version: result.schemaVersion, integrity: "ok" },
        };
      }),
      Effect.catch((error) => {
        this.#options.onError("A database snapshot failed.", error.cause ?? error.code);
        return Effect.succeed(failure(SNAPSHOT_FAILURE_STATUS[error.code], error.code));
      }),
      Effect.ensuring(
        Effect.sync(() => {
          this.#snapshotRunning = false;
        }),
      ),
    );
  });

  readonly #setAnalytics = Effect.fn("ServerMode.setAnalytics")(function* (
    this: ServerMode,
    value: string,
  ): Effect.fn.Return<Answer, { readonly cause: unknown }> {
    const { analytics } = this.#options;
    if (!analytics) return failure(501, "unavailable");
    const requested = ANALYTICS_SWITCH[value.trim().toLowerCase()];
    if (requested === undefined) return failure(400, "invalid_request");
    if (requested && analytics.lockedOff) return failure(409, "disabled_by_environment");
    yield* analytics.set(requested);
    this.#options.log?.(`Product analytics were turned ${requested ? "on" : "off"} by the operator.`);
    return this.#status();
  });

  readonly #startLogin = Effect.fn("ServerMode.startLogin")(function* (
    this: ServerMode,
    email: string,
    name: string | null,
  ): Effect.fn.Return<Answer, RemoteWorkflowError> {
    const normalized = email.trim();
    if (!normalized.includes("@") || normalized.length > MAX_EMAIL_LENGTH) return failure(400, "invalid_email");
    // The name is stored only at the code check. A check here refuses it before an email is sent.
    if (name !== null && !parseHostedServerName(name)) return nameFailure(name);
    if (this.#options.centralAuth.getState().status === "signed_in") return failure(409, "signed_in");
    const state = yield* this.#options.centralAuth
      .requestEmailCode(normalized)
      .pipe(Effect.mapError(({ cause }) => new RemoteWorkflowError({ cause })));
    if (state.status === "code_sent" && !state.issue) {
      return { status: 200, lines: { challenge: state.challengeId, expires_at: state.expiresAt } };
    }
    return issueFailure(state);
  });

  readonly #verifyLogin = Effect.fn("ServerMode.verifyLogin")(function* (
    this: ServerMode,
    challenge: string,
    code: string,
    name: string | null,
  ): Effect.fn.Return<Answer, RemoteWorkflowError> {
    if (!challenge.trim() || !code.trim()) return failure(400, "invalid_request");
    if (name !== null) {
      // The host refuses such a name only when it publishes, after the sign-in.
      const serverName = parseHostedServerName(name);
      if (!serverName) return nameFailure(name);
      this.#pendingName = serverName;
    }
    const state = yield* this.#options.centralAuth
      .verifyEmailCode(challenge.trim(), code.trim())
      .pipe(Effect.mapError(({ cause }) => new RemoteWorkflowError({ cause })));
    // The entry point publishes the host when the account change is applied. `status` shows it.
    if (state.status === "signed_in") return this.#status();
    return issueFailure(state);
  });

  readonly #rename = Effect.fn("ServerMode.rename")(function* (
    this: ServerMode,
    name: string,
  ): Effect.fn.Return<Answer, RemoteWorkflowError> {
    const serverName = parseHostedServerName(name);
    if (!serverName) return nameFailure(name);
    const { host } = this.#options;
    if (host.getStatus().configured) {
      yield* host.updateIdentity({ serverName });
    } else {
      this.#pendingName = serverName;
      yield* this.publish();
    }
    return this.#status();
  });
}

const ANALYTICS_SWITCH: Record<string, boolean | undefined> = {
  on: true,
  true: true,
  "1": true,
  off: false,
  false: false,
  "0": false,
};

/** The form body, or null when it is larger than a control request can be. */
async function readBody(request: IncomingMessage): Promise<URLSearchParams | null> {
  const body = await readBodyWithin(request, MAX_BODY_BYTES);
  return body === null ? null : new URLSearchParams(body.toString("utf8"));
}

function failure(status: number, error: string, message: string | null = null): Answer {
  return { status, lines: { error, message } };
}

/** The message of the team store for a name that it refuses. */
function nameFailure(name: string): Answer {
  const length = name.trim().length;
  const message =
    length < INPUT_LIMITS.serverNameMin || length > INPUT_LIMITS.serverName
      ? sourceText("error.team.serverNameLength", { min: INPUT_LIMITS.serverNameMin, max: INPUT_LIMITS.serverName })
      : sourceText("error.team.serverNameHostname");
  return failure(400, "invalid_name", message);
}

function issueFailure(state: CentralAuthState): Answer {
  if ((state.status === "code_sent" || state.status === "error") && state.issue) {
    return failure(state.status === "error" ? 502 : 400, state.issue.code, state.issue.message);
  }
  return failure(409, `account_${state.status}`);
}

/** One `key=value` line for each value. A value never breaks its line. */
function formatLines(lines: Answer["lines"]): string {
  return Object.entries(lines)
    .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/gu, " ")}\n`)
    .join("");
}
