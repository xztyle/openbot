import { randomUUID } from "node:crypto";
import type { McpOAuthStart, McpOAuthStatus } from "@openbot/contracts/team-protocol/mcp-oauth-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Exit, Fiber, Scope } from "effect";
import { mcpSync } from "../backend/mcp-effects";
import type { McpOAuth, McpSignIn } from "../backend/mcp-oauth-provider";
import { testMcpServer } from "../backend/mcp-probe";

export class RemoteMcpSignInError extends Error {}
interface Attempt {
  owner: string;
  resource: string;
  accountId: string;
  oauth: McpOAuth;
  expiresAt: number;
  authorizationUrl: string | null;
  state: string | null;
  signIn: McpSignIn;
  result: { toolCount: number; error: string | null } | null;
  fiber: Fiber.Fiber<unknown> | null;
  timer: ReturnType<typeof setTimeout>;
}
interface Options {
  oauth: McpOAuth;
  redirectUrl: string;
  timeoutMs?: number;
  probe?: typeof testMcpServer;
  isSaved?: (accountId: string) => boolean;
}

/** Owns remote attempts. The authenticated session is the only reader and writer of its grant. */
export class RemoteMcpSignIn {
  readonly #options: Options;
  readonly #attempts = new Map<string, Attempt>();
  readonly #scope = Scope.makeUnsafe();
  constructor(options: Options) {
    const callback = new URL(options.redirectUrl);
    if (
      callback.protocol !== "https:" ||
      callback.username ||
      callback.password ||
      callback.pathname !== "/mcp-auth" ||
      callback.search ||
      callback.hash
    )
      throw new Error("Invalid configured remote MCP callback.");
    this.#options = options;
  }

  readonly start = Effect.fn("RemoteMcpSignIn.start")(function* (
    this: RemoteMcpSignIn,
    owner: string,
    input: { url: string; redirectUrl: string; accountId: string },
    sessionExpiresAt: string,
  ) {
    const created = yield* mcpSync(() => this.#create(owner, input, sessionExpiresAt));
    const { id, entry } = created;
    const operation = this.#probe(entry).pipe(
      Effect.timeoutOrElse({
        duration: Math.max(1, entry.expiresAt - Date.now()),
        orElse: () => Effect.succeed({ toolCount: 0, error: sourceText("error.team.mcpOAuthExpired") }),
      }),
      Effect.catch(() => Effect.succeed({ toolCount: 0, error: sourceText("error.team.mcpOAuthFailed") })),
      Effect.tap((result) =>
        Effect.sync(() => {
          entry.result = result;
          entry.authorizationUrl = null;
          entry.state = null;
        }),
      ),
      Effect.ensuring(Effect.sync(() => entry.signIn.abandon())),
    );
    entry.fiber = yield* Effect.forkIn(operation, this.#scope, { startImmediately: true });
    return { attemptId: id, expiresAt: entry.expiresAt } satisfies McpOAuthStart;
  }).bind(this);

  #create(owner: string, input: { url: string; redirectUrl: string; accountId: string }, sessionExpiresAt: string) {
    if (input.redirectUrl !== this.#options.redirectUrl) this.#refuse("error.team.mcpOAuthCallback");
    if (!/^mcpacct-[a-f0-9-]{36}$/.test(input.accountId)) this.#refuse("error.team.mcpOAuthResource");
    let resource: URL;
    try {
      resource = new URL(input.url);
    } catch {
      this.#refuse("error.team.mcpOAuthResource");
    }
    if (resource.protocol !== "https:" || resource.username || resource.password || resource.hash)
      this.#refuse("error.team.mcpOAuthResource");
    if (
      this.#attempts.size >= 16 ||
      [...this.#attempts.values()].some((entry) => entry.accountId === input.accountId && !entry.result)
    )
      this.#refuse("error.team.mcpOAuthBusy");
    const id = randomUUID();
    const expiresAt = Math.min(Date.now() + (this.#options.timeoutMs ?? 300_000), Date.parse(sessionExpiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) this.#refuse("error.team.mcpOAuthExpired");
    const oauth = this.#options.oauth.forConnection(input.accountId);
    const signIn = oauth.remoteSignIn(resource.href, {
      redirectUrl: this.#options.redirectUrl,
      openExternal: async (url) => this.#publish(id, url),
    });
    if (!signIn) this.#refuse("error.team.mcpOAuthResource");
    const entry: Attempt = {
      owner,
      resource: resource.href,
      accountId: input.accountId,
      oauth,
      expiresAt,
      signIn,
      authorizationUrl: null,
      state: null,
      result: null,
      fiber: null,
      timer: setTimeout(() => Effect.runFork(this.#remove(id)), Math.max(1, expiresAt - Date.now())),
    };
    entry.timer.unref();
    this.#attempts.set(id, entry);
    return { id, entry };
  }

  #publish(id: string, url: string): void {
    const entry = this.#attempts.get(id);
    if (!entry || entry.expiresAt <= Date.now() || entry.result) return;
    const address = new URL(url);
    const state = address.searchParams.get("state");
    if (
      address.protocol !== "https:" ||
      !state ||
      address.searchParams.get("redirect_uri") !== this.#options.redirectUrl
    )
      this.#refuse("error.team.mcpOAuthCallback");
    entry.authorizationUrl = address.href;
    entry.state = state;
  }

  #probe(entry: Attempt) {
    const oauth = entry.oauth;
    return (this.#options.probe ?? testMcpServer)(
      {
        id: "",
        name: "MCP",
        transport: "http",
        enabled: true,
        command: "",
        args: [],
        env: [],
        envPassthrough: [],
        workingDirectory: "",
        url: entry.resource,
        headers: [],
      },
      undefined,
      undefined,
      {
        accessToken: oauth.accessToken,
        forget: oauth.forget,
        signIn: () => entry.signIn,
      },
    );
  }

  status(owner: string, id: string): McpOAuthStatus {
    const entry = this.#owned(owner, id);
    return entry.result
      ? { kind: "complete", ...entry.result }
      : {
          kind: "waiting",
          authorizationUrl: entry.authorizationUrl,
          state: entry.state,
          expiresAt: entry.expiresAt,
        };
  }

  complete(owner: string, input: { attemptId: string; state: string; code: string }): void {
    const entry = this.#owned(owner, input.attemptId);
    if (!input.code.trim() || input.code.length > 4096 || !entry.state || entry.state !== input.state || entry.result)
      this.#refuse("error.team.mcpOAuthInvalidReturn");
    if (!entry.oauth.receiveAuthorizationCode(input.state, input.code))
      this.#refuse("error.team.mcpOAuthInvalidReturn");
    entry.state = null;
    entry.authorizationUrl = null;
  }

  readonly cancel = Effect.fn("RemoteMcpSignIn.cancel")(function* (this: RemoteMcpSignIn, owner: string, id: string) {
    const entry = this.#attempts.get(id);
    if (!entry) return;
    this.#owned(owner, id);
    // The browser closes the attempt before saving. Keep successful drafts until the save deadline.
    if (entry.result && !entry.result.error) return;
    yield* this.#remove(id);
  });

  #owned(owner: string, id: string): Attempt {
    const entry = this.#attempts.get(id);
    if (!entry || entry.owner !== owner || entry.expiresAt <= Date.now()) this.#refuse("error.team.mcpOAuthExpired");
    return entry;
  }

  readonly #remove = Effect.fn("RemoteMcpSignIn.remove")(function* (this: RemoteMcpSignIn, id: string) {
    const entry = this.#attempts.get(id);
    if (!entry) return;
    entry.signIn.abandon();
    if (entry.fiber) yield* Fiber.interrupt(entry.fiber);
    clearTimeout(entry.timer);
    this.#attempts.delete(id);
    if (!this.#options.isSaved?.(entry.accountId)) yield* entry.oauth.forget(entry.resource);
  });

  #refuse(
    key:
      | "error.team.mcpOAuthCallback"
      | "error.team.mcpOAuthResource"
      | "error.team.mcpOAuthBusy"
      | "error.team.mcpOAuthExpired"
      | "error.team.mcpOAuthInvalidReturn",
  ): never {
    throw new RemoteMcpSignInError(sourceText(key));
  }

  readonly close = Effect.fn("RemoteMcpSignIn.close")(function* (this: RemoteMcpSignIn) {
    yield* Effect.forEach([...this.#attempts.keys()], (id) => this.#remove(id));
    yield* Scope.close(this.#scope, Exit.void);
  });
}
