import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Schema } from "effect";
import { writeFileAtomically } from "./atomic-json-file";
import { isMissingFileError } from "./file-errors";

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

  constructor(root: string) {
    this.#root = root;
  }

  readonly save = Effect.fn("AgentApiKeys.save")(function* (
    this: AgentApiKeys,
    scope: string,
    name: string,
    value: string,
  ) {
    if (value === "" || Buffer.byteLength(value) > API_KEY_VALUE_LIMIT) return yield* Effect.fail(failed());
    const path = yield* this.#keyPath(scope, name);
    registerSecretValue(value);
    yield* writeFileAtomically(path, value, { createDirectory: true }).pipe(Effect.mapError(failed));
    return savedKey(scope, name, path);
  });

  readonly list = Effect.fn("AgentApiKeys.list")(function* (this: AgentApiKeys, scope: string) {
    const folder = yield* this.#scopeFolder(scope);
    const names = yield* Effect.tryPromise({ try: () => folderNames(folder), catch: failed });
    return names
      .filter((name) => API_KEY_NAME_PATTERN.test(name))
      .sort()
      .map((name) => savedKey(scope, name, join(folder, name)));
  });

  /** The keys an agent reads: its own, then the shared ones that it has no own key for. */
  readonly listForAgent = Effect.fn("AgentApiKeys.listForAgent")(function* (this: AgentApiKeys, agentId: string) {
    const own = yield* this.list(agentId);
    const shared = yield* this.list(SHARED_API_KEY_SCOPE);
    const names = new Set(own.map((key) => key.name));
    return [...own, ...shared.filter((key) => !names.has(key.name))];
  });

  /** Every key of the server, for the Secrets view: the shared ones and each agent's. */
  readonly listAll = Effect.fn("AgentApiKeys.listAll")(function* (this: AgentApiKeys) {
    const folders = yield* Effect.tryPromise({ try: () => folderNames(this.#root), catch: failed });
    const scopes = [
      SHARED_API_KEY_SCOPE,
      ...folders.filter((folder) => folder !== SHARED_FOLDER && AGENT_ID_PATTERN.test(folder)).sort(),
    ];
    const entries: ApiKeyEntry[] = [];
    for (const scope of scopes) {
      const keys = yield* this.list(scope);
      for (const key of keys) {
        const info = yield* Effect.promise(() => stat(key.path).catch(() => null));
        entries.push({ scope, name: key.name, updatedAt: Math.round(info?.mtimeMs ?? 0) });
      }
    }
    return entries;
  });

  /** The value of a key, for the server owner only. Null when there is no such key. */
  readonly read = Effect.fn("AgentApiKeys.read")(function* (this: AgentApiKeys, scope: string, name: string) {
    const path = yield* this.#keyPath(scope, name);
    return yield* Effect.tryPromise({
      try: () =>
        readFile(path, "utf8").then(
          (value) => value,
          (error: unknown) => (isMissingFileError(error) ? null : Promise.reject(error)),
        ),
      catch: failed,
    });
  });

  /** False when the scope has no key with that name. */
  readonly remove = Effect.fn("AgentApiKeys.remove")(function* (this: AgentApiKeys, scope: string, name: string) {
    const path = yield* this.#keyPath(scope, name);
    return yield* Effect.tryPromise({
      try: () =>
        rm(path).then(
          () => true,
          (error: unknown) => (isMissingFileError(error) ? false : Promise.reject(error)),
        ),
      catch: failed,
    });
  });

  /** Removes every key of a deleted agent. */
  readonly removeAgent = Effect.fn("AgentApiKeys.removeAgent")(function* (this: AgentApiKeys, agentId: string) {
    const folder = yield* this.#agentFolder(agentId);
    yield* Effect.tryPromise({ try: () => rm(folder, { recursive: true, force: true }), catch: failed });
  });

  /** Registers every saved value for redaction. A file that cannot be read is skipped. */
  readonly registerSaved = Effect.fn("AgentApiKeys.registerSaved")(function* (this: AgentApiKeys) {
    const agents = yield* Effect.promise(() => folderNames(this.#root).catch((): string[] => []));
    const scopes = [SHARED_API_KEY_SCOPE, ...agents.filter((id) => AGENT_ID_PATTERN.test(id))];
    for (const scope of scopes) {
      const keys = yield* this.list(scope).pipe(Effect.catch(() => Effect.succeed<SavedApiKey[]>([])));
      for (const key of keys) {
        const value = yield* Effect.promise(() => readFile(key.path, "utf8").catch(() => ""));
        registerSecretValue(value);
      }
    }
  });

  #agentFolder(agentId: string): Effect.Effect<string, AgentApiKeyFailed> {
    return AGENT_ID_PATTERN.test(agentId) ? Effect.succeed(join(this.#root, agentId)) : Effect.fail(failed());
  }

  /** The key in a file that an agent wrote, for `save_api_key`; see `readKeySourceFile`. */
  sourceFile(path: string, workspacePath: string | null) {
    return readKeySourceFile(path, workspacePath, this.#root);
  }

  #scopeFolder(scope: string): Effect.Effect<string, AgentApiKeyFailed> {
    return scope === SHARED_API_KEY_SCOPE ? Effect.succeed(join(this.#root, SHARED_FOLDER)) : this.#agentFolder(scope);
  }

  #keyPath(scope: string, name: string): Effect.Effect<string, AgentApiKeyFailed> {
    if (!API_KEY_NAME_PATTERN.test(name)) return Effect.fail(failed());
    return this.#scopeFolder(scope).pipe(Effect.map((folder) => join(folder, name)));
  }
}

function savedKey(scope: string, name: string, path: string): SavedApiKey {
  return scope === SHARED_API_KEY_SCOPE ? { name, path, shared: true } : { name, path };
}

/** The names in a folder; none when the folder is missing. */
async function folderNames(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
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
