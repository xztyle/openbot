import { readFileSync } from "node:fs";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { SecretActor } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, registerSecretValue, toLogValue } from "@openbot/logging";
import { Effect, Option, Schema } from "effect";
import { writeJsonFileAtomically } from "./atomic-json-file";
import { SecretLedger } from "./secret-ledger";

const logger = createOpenBotLogger("agent-api-keys");

/** An environment variable name, which is also the file name of the key. */
export const API_KEY_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
// Agent ids are `agent-<uuid>` or an older short form; anything else must not name a folder.
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The scope of the keys that every agent of the server reads. Any other scope is an agent id. */
export const SHARED_API_KEY_SCOPE = "shared";
// The folder of the shared keys: no agent id starts with "_", so it never names an agent's folder.
const SHARED_FOLDER = "_shared";
/** The largest key, in bytes. A token, a key pair or a short JSON credential fits. */
export const API_KEY_VALUE_LIMIT = 16 * 1024;
// The sites where the owner let agents fill a key into a password field. It starts with "_", so it
// never names an agent's folder.
const FILL_SITES_FILE = "_fill-sites.json";

const FillSites = Schema.Struct({
  version: Schema.Literal(1),
  /** `<scope>/<NAME>` to the HTTPS origins where the key can be filled. */
  sites: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
const decodeFillSites = Schema.decodeUnknownOption(Schema.fromJsonString(FillSites));

export interface SavedApiKey {
  name: string;
  path: string;
  /** Present on a shared key, which every agent of the server reads. */
  shared?: true;
}

/** A key as the server owner sees it in the Secrets view. Never its value. */
export interface ApiKeyEntry {
  /** `shared` or the agent's id. */
  scope: string;
  name: string;
  updatedAt: number;
}

/** The cause stays private: it can hold a path. The message is what the user and the agent read. */
export class AgentApiKeyFailed extends Schema.TaggedError<AgentApiKeyFailed>()("AgentApiKeyFailed", {
  cause: Schema.Defect(),
}) {}

const failed = () => new AgentApiKeyFailed({ cause: new Error(sourceText("error.backend.apiKeySaveFailed")) });

/**
 * The API keys and other secrets of the agents: what the user entered through `request_api_key` or
 * the Secrets view, and what an agent saved from a file or a page. Each key is one file,
 * `<root>/<agentId>/<NAME>` for one agent or `<root>/_shared/<NAME>` for every agent, readable only by
 * the user, outside every workspace. The agent gets the path and reads the file in its own commands,
 * so the value never travels in a tool argument or a tool result. Each value is registered for
 * redaction when it is saved and when OpenBot starts. A scope is an agent id or `shared`.
 */
export class AgentApiKeys {
  readonly #root: string;
  /** The source of truth: values, versions, access, history. The key files are its projection. */
  readonly ledger: SecretLedger;

  constructor(root: string, options: { now?: () => number } = {}) {
    this.#root = root;
    this.ledger = new SecretLedger(root, options);
  }

  readonly save = Effect.fn("AgentApiKeys.save")(function* (
    this: AgentApiKeys,
    scope: string,
    name: string,
    value: string,
    actor: SecretActor = { kind: "host" },
  ) {
    if (value === "" || Buffer.byteLength(value) > API_KEY_VALUE_LIMIT) return yield* Effect.fail(failed());
    const path = yield* this.#keyPath(scope, name);
    registerSecretValue(value);
    const ledger = this.ledger;
    yield* Effect.try({ try: () => ledger.save(scope, name, value, actor), catch: failed });
    return savedKey(scope, name, scope === SHARED_API_KEY_SCOPE ? ledger.homePath(scope, name) : path);
  });

  /** The keys of one scope that are in force, with the file where their readers find them. */
  readonly list = Effect.fn("AgentApiKeys.list")(function* (this: AgentApiKeys, scope: string) {
    yield* this.#scopeFolder(scope);
    const ledger = this.ledger;
    const secrets = yield* Effect.try({ try: () => ledger.list(), catch: failed });
    return secrets
      .filter((secret) => secret.scope === scope)
      .map((secret) => savedKey(scope, secret.name, ledger.homePath(scope, secret.name)));
  });

  /** The keys an agent reads, one per name: its own, then one given to it, then a shared one. */
  readonly listForAgent = Effect.fn("AgentApiKeys.listForAgent")(function* (this: AgentApiKeys, agentId: string) {
    yield* this.#agentFolder(agentId);
    const ledger = this.ledger;
    const keys = yield* Effect.try({ try: () => ledger.keysFor(agentId), catch: failed });
    return keys.map((key): SavedApiKey => {
      const saved: SavedApiKey = { name: key.name, path: key.path };
      if (key.scope === SHARED_API_KEY_SCOPE) saved.shared = true;
      return saved;
    });
  });

  /** Every key of the server, for the Secrets view: the shared ones and each agent's. */
  readonly listAll = Effect.fn("AgentApiKeys.listAll")(function* (this: AgentApiKeys) {
    const ledger = this.ledger;
    const secrets = yield* Effect.try({ try: () => ledger.list(), catch: failed });
    return secrets.map(
      (secret): ApiKeyEntry => ({ scope: secret.scope, name: secret.name, updatedAt: secret.updatedAt }),
    );
  });

  /** The value of a key, for the server owner only, written to its history. Null when there is no such key. */
  readonly read = Effect.fn("AgentApiKeys.read")(function* (
    this: AgentApiKeys,
    scope: string,
    name: string,
    actor: SecretActor = { kind: "owner" },
  ) {
    yield* this.#keyPath(scope, name);
    const ledger = this.ledger;
    if (!ledger.has(scope, name)) return null;
    return yield* Effect.try({ try: () => ledger.reveal(scope, name, actor, "show"), catch: failed });
  });

  /** Moves the key to the bin, where it stays restorable for 30 days. False when there is none. */
  readonly remove = Effect.fn("AgentApiKeys.remove")(function* (
    this: AgentApiKeys,
    scope: string,
    name: string,
    actor: SecretActor = { kind: "host" },
  ) {
    yield* this.#keyPath(scope, name);
    yield* this.#changeFillSites((key) => key !== `${scope}/${name}`);
    const ledger = this.ledger;
    return yield* Effect.try({ try: () => ledger.remove(scope, name, actor), catch: failed });
  });

  /** Moves every key of a deleted agent to the bin. */
  readonly removeAgent = Effect.fn("AgentApiKeys.removeAgent")(function* (this: AgentApiKeys, agentId: string) {
    const folder = yield* this.#agentFolder(agentId);
    yield* this.#changeFillSites((key) => !key.startsWith(`${agentId}/`));
    const ledger = this.ledger;
    yield* Effect.try({ try: () => ledger.removeScope(agentId, { kind: "host" }), catch: failed });
    yield* Effect.tryPromise({ try: () => rm(folder, { recursive: true, force: true }), catch: failed });
    yield* Effect.tryPromise({
      try: () => rm(join(this.#root, "_grants", agentId), { recursive: true, force: true }),
      catch: failed,
    });
  });

  /**
   * Takes the key files into the ledger (a store from before it keeps every key), registers every
   * value for redaction, and rebuilds the files agents read. Runs before the first agent starts.
   */
  readonly registerSaved = Effect.fn("AgentApiKeys.registerSaved")(function* (this: AgentApiKeys) {
    const ledger = this.ledger;
    yield* Effect.sync(() => {
      try {
        ledger.migrate();
        ledger.registerForRedaction();
        ledger.project();
      } catch (error) {
        logger.warn("The keys store could not be prepared", { error: toLogValue(error) });
      }
    });
  });

  /**
   * One value now, for a connection that names a key: the agent's own key (`agent`), the shared one
   * when the agent may read it (`shared`), or the one the agent reads by that name (`any`). Without
   * an agent, the host's own helpers read the shared key. An expired key is null.
   */
  readNow(scope: "agent" | "shared" | "any", agentId: string | null, name: string, actor?: SecretActor): string | null {
    if (agentId !== null && !AGENT_ID_PATTERN.test(agentId)) return null;
    try {
      return this.ledger.resolveFor(scope, agentId, name, actor)?.value ?? null;
    } catch {
      return null;
    }
  }

  /** The key an agent reads by `name` now, as `readNow("any", …)`, and the scope it comes from. */
  resolveNow(agentId: string, name: string): { scope: string; value: string } | null {
    if (!AGENT_ID_PATTERN.test(agentId)) return null;
    try {
      return this.ledger.resolveFor("any", agentId, name);
    } catch {
      return null;
    }
  }

  /** Whether the owner let agents fill the key `name` of `scope` into a password field on `origin`. */
  fillApproved(scope: string, name: string, origin: string): boolean {
    return this.#readFillSites()[`${scope}/${name}`]?.includes(origin) === true;
  }

  /** Keeps the owner's approval to fill the key on `origin`. Removing the key removes it. */
  readonly approveFill = Effect.fn("AgentApiKeys.approveFill")(function* (
    this: AgentApiKeys,
    scope: string,
    name: string,
    origin: string,
  ) {
    yield* this.#keyPath(scope, name);
    const sites = this.#readFillSites();
    const key = `${scope}/${name}`;
    const origins = sites[key] ?? [];
    if (origins.includes(origin)) return;
    yield* this.#writeFillSites({ ...sites, [key]: [...origins, origin] });
  });

  #readFillSites(): Record<string, readonly string[]> {
    let text: string;
    try {
      text = readFileSync(join(this.#root, FILL_SITES_FILE), "utf8");
    } catch {
      return {};
    }
    return Option.match(decodeFillSites(text), { onNone: () => ({}), onSome: (file) => file.sites });
  }

  #changeFillSites(keep: (key: string) => boolean): Effect.Effect<void, AgentApiKeyFailed> {
    const sites = this.#readFillSites();
    const kept = Object.fromEntries(Object.entries(sites).filter(([key]) => keep(key)));
    return Object.keys(kept).length === Object.keys(sites).length ? Effect.void : this.#writeFillSites(kept);
  }

  #writeFillSites(sites: Record<string, readonly string[]>): Effect.Effect<void, AgentApiKeyFailed> {
    return writeJsonFileAtomically(
      join(this.#root, FILL_SITES_FILE),
      { version: 1, sites },
      { createDirectory: true },
    ).pipe(Effect.mapError(failed));
  }

  #agentFolder(agentId: string): Effect.Effect<string, AgentApiKeyFailed> {
    return AGENT_ID_PATTERN.test(agentId) ? Effect.succeed(join(this.#root, agentId)) : Effect.fail(failed());
  }

  /** The key in a file that an agent wrote, for `save_api_key`; see `readKeySourceFile`. */
  sourceFile(path: string, workspacePath: string | null) {
    return readKeySourceFile(path, workspacePath, this.#root);
  }

  #scopeFolder(scope: string): Effect.Effect<string, AgentApiKeyFailed> {
    if (scope === SHARED_API_KEY_SCOPE) return Effect.succeed(join(this.#root, SHARED_FOLDER));
    // A space's keys have no folder of their own: each agent of the space finds them in its grants.
    if (scope.startsWith("space:"))
      return AGENT_ID_PATTERN.test(scope.slice(6))
        ? Effect.succeed(join(this.#root, "_grants"))
        : Effect.fail(failed());
    return this.#agentFolder(scope);
  }

  #keyPath(scope: string, name: string): Effect.Effect<string, AgentApiKeyFailed> {
    if (!API_KEY_NAME_PATTERN.test(name)) return Effect.fail(failed());
    return this.#scopeFolder(scope).pipe(Effect.map((folder) => join(folder, name)));
  }
}

function savedKey(scope: string, name: string, path: string): SavedApiKey {
  return scope === SHARED_API_KEY_SCOPE ? { name, path, shared: true } : { name, path };
}

/**
 * The key in a file that an agent wrote, for `save_api_key`. The file must be a small regular file in
 * the agent's workspace or a temp folder, so an agent cannot copy another agent's key or a file of the
 * server into the store. The value is trimmed: a command's output ends with a line break.
 */
export const readKeySourceFile = Effect.fn("AgentApiKeys.readKeySourceFile")(function* (
  path: string,
  workspacePath: string | null,
  /** The key store: a file in it is never a source, whatever folder holds the store. */
  storeRoot: string,
) {
  const refuse = (message: string) => Effect.fail(new AgentApiKeyFailed({ cause: new Error(message) }));
  if (!isAbsolute(path)) return yield* refuse("Give the absolute path of the file that holds the key.");
  const resolved = yield* Effect.promise(() => realpath(path).catch(() => null));
  if (!resolved) return yield* refuse("OpenBot could not find that file. Write the key to it first.");
  const roots = yield* Effect.promise(() =>
    Promise.all([workspacePath, tmpdir(), "/tmp"].flatMap((root) => (root ? [realpath(root).catch(() => null)] : []))),
  );
  const within = (root: string | null) => {
    if (!root) return false;
    const rest = relative(root, resolved);
    return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
  };
  const store = yield* Effect.promise(() => realpath(storeRoot).catch(() => storeRoot));
  if (!roots.some(within) || within(store))
    return yield* refuse("The file must be in your workspace or the temp folder.");
  const info = yield* Effect.promise(() => stat(resolved).catch(() => null));
  if (!info?.isFile()) return yield* refuse("The path must be a regular file.");
  if (info.size > API_KEY_VALUE_LIMIT) return yield* refuse("The file is too large for a key: 16 KiB at most.");
  const value = (yield* Effect.tryPromise({ try: () => readFile(resolved, "utf8"), catch: failed })).trim();
  if (value === "") return yield* refuse("The file is empty. Write the key to it first.");
  return { path: resolved, value };
});

/** Deletes the agent's file once its key is in the store, so no copy stays in the workspace. */
export const removeKeySourceFile = (path: string) =>
  Effect.promise(() => rm(path, { force: true }).catch(() => undefined));
