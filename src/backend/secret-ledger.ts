import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  guessSecretKind,
  isSecretTag,
  normalizeSecretFolder,
  SECRET_ACTOR_KINDS,
  SECRET_AUDIT_ACTIONS,
  SECRET_KINDS,
  SECRET_TRASH_DAYS,
  SECRET_VAULT_LIMITS,
  type SecretAccess,
  type SecretActor,
  type SecretAuditAction,
  type SecretAuditRow,
  type SecretDetail,
  type SecretKind,
  type SecretSettings,
  type SecretSummary,
  type SecretVersion,
  secretFolderAncestors,
  secretScopeKind,
  type TrashedSecret,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { registerSecretValues } from "@openbot/logging";
import { parseStoredJson } from "./atomic-json-file";

/**
 * The keys and passwords of the agents, with what HashiCorp Vault gives a team: who may read each
 * key, every earlier value (encrypted), a history of who used or changed it, an expiry, a date to
 * rotate it by, a 30-day bin and an encrypted bundle to move them to another server.
 *
 * The ledger (`_vault/ledger.json`) is the source of truth. Every value in it is encrypted with the
 * key in `_vault/key`. The files that agents read are a projection of it, rebuilt by `project()`:
 *
 * - `<root>/<agentId>/<NAME>`: the agent's own key;
 * - `<root>/_shared/<NAME>`: a shared key that every agent reads;
 * - `<root>/_grants/<agentId>/<NAME>`: any other key the agent may read (a space's key, a shared key
 *   given to some agents only, another agent's key given to it).
 *
 * The agent jail lets an agent read only its own folder, `_shared` and its own `_grants` folder, so
 * the projection is the access policy: a key that is expired, deleted or not given to the agent has
 * no file the agent can open. `_vault` is never in reach of an agent.
 *
 * No value is ever written to the audit log, to a log line or to a summary.
 */

const DAY = 86_400_000;
const VAULT_FOLDER = "_vault";
const SHARED_FOLDER = "_shared";
const GRANTS_FOLDER = "_grants";
const LEDGER_FILE = "ledger.json";
const KEY_FILE = "key";
const AUDIT_FILE = "audit.jsonl";
const PROJECTION_FILE = "projection.json";
/** A larger audit log moves to `audit.1.jsonl`, and the one there before goes. */
const AUDIT_ROTATE_BYTES = 4 * 1024 * 1024;
/** One `used` line per key and agent at most this often. */
const USE_LOG_INTERVAL_MS = 10 * 60_000;
const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BUNDLE_FORMAT = "atelier-secrets";

export interface LedgerAgent {
  id: string;
  name?: string;
  spaceId?: string | null;
}

interface StoredValue {
  version: number;
  createdAt: number;
  by?: SecretActor;
  /** `v1:` and the base64 of iv, tag and ciphertext. */
  data: string;
}

interface Entry {
  scope: string;
  name: string;
  type?: SecretKind;
  label?: string;
  folder?: string;
  tags?: string[];
  note?: string;
  access: SecretAccess;
  createdAt: number;
  createdBy?: SecretActor;
  updatedAt: number;
  rotatedAt?: number;
  rotateBy?: number;
  rotateEveryDays?: number;
  expiresAt?: number;
  /** The reminder last posted, such as `rotate:<time>`, so it is posted once. */
  reminded?: string;
  /** Set once the expiry was written to the audit log. */
  expiredLogged?: boolean;
  lastUsedAt?: number;
  usedBy: Record<string, number>;
  /** Oldest first; the last one is the current value. */
  values: StoredValue[];
}

interface TrashEntry {
  entry: Entry;
  deletedAt: number;
  by?: SecretActor;
}

interface FolderAccess {
  agents: string[];
  spaces: string[];
}

interface LedgerFile {
  version: 1;
  secrets: Record<string, Entry>;
  trash: TrashEntry[];
  /** Who may use the keys under a folder path, besides each key's own readers. */
  folders?: Record<string, FolderAccess>;
}

interface ProjectedFile {
  key: string;
  version: number;
  size: number;
  mtimeMs: number;
  /** The read time last seen, so a later read by an agent counts as a use. */
  atimeMs: number;
}

interface ProjectionFile {
  version: 1;
  files: Record<string, ProjectedFile>;
}

export interface LedgerReminder {
  key: string;
  agentId: string | null;
  label: string;
  reason: "rotate" | "expiring" | "expired";
  at: number;
}

export class SecretLedgerError extends Error {}

const keyOf = (scope: string, name: string) => `${scope}/${name}`;

export class SecretLedger {
  readonly #root: string;
  readonly #now: () => number;
  #agents: () => readonly LedgerAgent[] = () => [];
  #state: LedgerFile | null = null;
  #key: Buffer | null = null;
  #projection: ProjectionFile | null = null;
  readonly #lastUseLog = new Map<string, number>();

  constructor(root: string, options: { now?: () => number } = {}) {
    this.#root = root;
    this.#now = options.now ?? Date.now;
  }

  get root(): string {
    return this.#root;
  }

  /** The agents of the server and their spaces: the readers of each key come from them. */
  setDirectory(agents: () => readonly LedgerAgent[]): void {
    this.#agents = agents;
  }

  // --- Storage -------------------------------------------------------------------------------------

  #vault(file: string): string {
    return join(this.#root, VAULT_FOLDER, file);
  }

  #ensureVault(): void {
    mkdirSync(join(this.#root, VAULT_FOLDER), { recursive: true, mode: 0o700 });
  }

  #cipherKey(): Buffer {
    if (this.#key) return this.#key;
    this.#ensureVault();
    const path = this.#vault(KEY_FILE);
    try {
      const stored = readFileSync(path);
      if (stored.length === 32) {
        this.#key = stored;
        return stored;
      }
    } catch {
      // A new store makes its key below.
    }
    if (existsSync(path) && this.#state && Object.keys(this.#state.secrets).length > 0)
      throw new SecretLedgerError("The key of the secrets store is damaged.");
    const key = randomBytes(32);
    writeAtomically(path, key);
    this.#key = key;
    return key;
  }

  #encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#cipherKey(), iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
  }

  #decrypt(stored: string): string {
    if (!stored.startsWith("v1:")) throw new SecretLedgerError("Unknown value format.");
    const bytes = Buffer.from(stored.slice(3), "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.#cipherKey(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }

  #load(): LedgerFile {
    if (this.#state) return this.#state;
    let state: LedgerFile = { version: 1, secrets: {}, trash: [] };
    try {
      const path = this.#vault(LEDGER_FILE);
      state = parseStoredJson(path, readFileSync(path, "utf8"), ledgerFile);
    } catch {
      // No ledger yet: `migrate` fills it from the key files. A damaged one is kept aside for
      // diagnosis, never overwritten: the key files still hold every current value.
      const path = this.#vault(LEDGER_FILE);
      if (existsSync(path)) renameSync(path, `${path}.corrupt-${this.#now()}`);
    }
    this.#state = state;
    return state;
  }

  #save(): void {
    this.#ensureVault();
    writeAtomically(this.#vault(LEDGER_FILE), JSON.stringify(this.#load()));
  }

  #loadProjection(): ProjectionFile {
    if (this.#projection) return this.#projection;
    let projection: ProjectionFile = { version: 1, files: {} };
    try {
      const path = this.#vault(PROJECTION_FILE);
      projection = parseStoredJson(path, readFileSync(path, "utf8"), projectionFile);
    } catch {
      // Rebuilt by the next projection.
    }
    this.#projection = projection;
    return projection;
  }

  #saveProjection(): void {
    this.#ensureVault();
    writeAtomically(this.#vault(PROJECTION_FILE), JSON.stringify(this.#loadProjection()));
  }

  // --- Audit ---------------------------------------------------------------------------------------

  /** One line of a key's history: who did what, when. Never a value. */
  audit(key: string, action: SecretAuditAction, actor: SecretActor, detail?: string): void {
    this.#ensureVault();
    const path = this.#vault(AUDIT_FILE);
    try {
      if (statSync(path).size > AUDIT_ROTATE_BYTES) renameSync(path, this.#vault("audit.1.jsonl"));
    } catch {
      // No log yet.
    }
    const row = {
      at: this.#now(),
      key,
      action,
      actor: cleanActor(actor),
      ...(detail ? { detail: clip(detail, 300) } : {}),
    };
    appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }

  #auditRows(key: string): SecretAuditRow[] {
    const rows: SecretAuditRow[] = [];
    for (const file of ["audit.1.jsonl", AUDIT_FILE]) {
      let text = "";
      try {
        text = readFileSync(this.#vault(file), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.includes(`"key":${JSON.stringify(key)}`)) continue;
        try {
          const row = parseStoredJson(AUDIT_FILE, line, auditLine);
          if (row.key !== key) continue;
          rows.push({
            at: row.at,
            action: row.action,
            actor: row.actor,
            ...(row.detail ? { detail: row.detail } : {}),
          });
        } catch {
          // A torn line from a crash.
        }
      }
    }
    return rows.reverse().slice(0, SECRET_VAULT_LIMITS.audit);
  }

  // --- Migration -----------------------------------------------------------------------------------

  /**
   * Takes every key file into the ledger. A file that the ledger does not know, or whose value
   * differs from the ledger's (a copy put back from a backup, a store from before the ledger), is
   * kept as the current value, so no key is ever lost. Runs at start, before the first agent.
   */
  migrate(): { imported: number } {
    const state = this.#load();
    let imported = 0;
    const scopes: { scope: string; folder: string }[] = [{ scope: "shared", folder: SHARED_FOLDER }];
    for (const folder of folderNames(this.#root))
      if (!folder.startsWith("_") && AGENT_ID_PATTERN.test(folder)) scopes.push({ scope: folder, folder });
    const projection = this.#loadProjection();
    for (const { scope, folder } of scopes) {
      for (const name of folderNames(join(this.#root, folder))) {
        if (!NAME_PATTERN.test(name)) continue;
        const path = join(this.#root, folder, name);
        const relative = `${folder}/${name}`;
        let info: Stats;
        try {
          info = statSync(path);
        } catch {
          continue;
        }
        if (!info.isFile()) continue;
        const known = projection.files[relative];
        const key = keyOf(scope, name);
        const entry = state.secrets[key];
        if (entry && known && known.size === info.size && Math.abs(known.mtimeMs - info.mtimeMs) < 1) continue;
        const value = readFileSync(path, "utf8");
        if (value === "") continue;
        if (entry && this.#currentValue(entry) === value) {
          projection.files[relative] = projected(key, entry, info);
          continue;
        }
        const at = Math.round(info.mtimeMs);
        if (entry) {
          this.#pushValue(entry, value, { kind: "host" }, at);
          this.audit(key, "changed", { kind: "host" }, "restored file");
          projection.files[relative] = projected(key, entry, info);
        } else {
          const created = newEntry(scope, name, at, { kind: "host" });
          state.secrets[key] = created;
          this.#pushValue(created, value, { kind: "host" }, at);
          // A key from before the ledger has no history, only its last save.
          this.audit(key, "created", { kind: "host" }, "existing key");
          projection.files[relative] = projected(key, created, info);
        }
        imported += 1;
      }
    }
    if (imported > 0) this.#save();
    this.#saveProjection();
    return { imported };
  }

  // --- Values --------------------------------------------------------------------------------------

  #currentValue(entry: Entry): string | null {
    const current = entry.values.at(-1);
    if (!current) return null;
    try {
      return this.#decrypt(current.data);
    } catch {
      return null;
    }
  }

  #pushValue(entry: Entry, value: string, by: SecretActor, at = this.#now()): void {
    const previous = entry.values.at(-1);
    const version = (previous?.version ?? 0) + 1;
    entry.values.push({ version, createdAt: at, by: cleanActor(by), data: this.#encrypt(value) });
    if (entry.values.length > SECRET_VAULT_LIMITS.versions + 1)
      entry.values.splice(0, entry.values.length - SECRET_VAULT_LIMITS.versions - 1);
    entry.updatedAt = at;
    if (previous) entry.rotatedAt = at;
    if (entry.rotateEveryDays) entry.rotateBy = at + entry.rotateEveryDays * DAY;
    else if (previous && entry.rotateBy !== undefined && entry.rotateBy <= at + 14 * DAY) delete entry.rotateBy;
    delete entry.reminded;
  }

  /** Every value the store holds, current and earlier, for the log redaction at start. */
  registerForRedaction(): void {
    const values: string[] = [];
    const state = this.#load();
    const entries = [...Object.values(state.secrets), ...state.trash.map((item) => item.entry)];
    for (const entry of entries)
      for (const stored of entry.values) {
        try {
          values.push(this.#decrypt(stored.data));
        } catch {
          // A value this key cannot open is not one the logs can hold.
        }
      }
    registerSecretValues(values);
  }

  has(scope: string, name: string): boolean {
    return Boolean(this.#load().secrets[keyOf(scope, name)]);
  }

  /** The path of a key's home file, where its scope's readers find it. */
  homePath(scope: string, name: string): string {
    const kind = secretScopeKind(scope);
    if (kind === "agent") return join(this.#root, scope, name);
    return join(this.#root, SHARED_FOLDER, name);
  }

  /** Saves a value: a new key, or a new version of one. Earlier values stay, encrypted. */
  save(scope: string, name: string, value: string, actor: SecretActor, settings: SecretSettings = {}): void {
    this.#validRef(scope, name);
    const state = this.#load();
    const key = keyOf(scope, name);
    let entry = state.secrets[key];
    registerSecretValues([value]);
    if (!entry) {
      // A key from the bin comes back under the same name with its history.
      const trashed = state.trash.findIndex((item) => keyOf(item.entry.scope, item.entry.name) === key);
      const [item] = trashed >= 0 ? state.trash.splice(trashed, 1) : [];
      if (item) {
        entry = item.entry;
        state.secrets[key] = entry;
      } else {
        entry = newEntry(scope, name, this.#now(), actor);
        state.secrets[key] = entry;
      }
      applySettings(entry, settings);
      this.#pushValue(entry, value, actor);
      this.audit(key, "created", actor);
    } else {
      applySettings(entry, settings);
      if (this.#currentValue(entry) === value) {
        this.#save();
        return;
      }
      this.#pushValue(entry, value, actor);
      this.audit(key, "changed", actor, `version ${entry.values.at(-1)?.version}`);
    }
    this.#save();
    this.project();
  }

  update(
    scope: string,
    name: string,
    change: SecretSettings & {
      rotateBy?: number | null;
      rotateEveryDays?: number | null;
      expiresAt?: number | null;
      access?: SecretAccess;
    },
    actor: SecretActor,
  ): void {
    const entry = this.#entry(scope, name);
    const key = keyOf(scope, name);
    const changed: string[] = [];
    const before = JSON.stringify(settingsOf(entry));
    applySettings(entry, change);
    if (JSON.stringify(settingsOf(entry)) !== before) changed.push("details");
    if (change.rotateEveryDays !== undefined) {
      if (change.rotateEveryDays === null) delete entry.rotateEveryDays;
      else {
        entry.rotateEveryDays = change.rotateEveryDays;
        if (change.rotateBy === undefined)
          entry.rotateBy = (entry.rotatedAt ?? entry.createdAt) + change.rotateEveryDays * DAY;
      }
      changed.push("rotation");
    }
    if (change.rotateBy !== undefined) {
      if (change.rotateBy === null) delete entry.rotateBy;
      else entry.rotateBy = change.rotateBy;
      delete entry.reminded;
      if (!changed.includes("rotation")) changed.push("rotation");
    }
    if (change.expiresAt !== undefined) {
      if (change.expiresAt === null) delete entry.expiresAt;
      else entry.expiresAt = change.expiresAt;
      delete entry.expiredLogged;
      delete entry.reminded;
      changed.push("expiry");
    }
    if (change.access) {
      const access: SecretAccess = {
        everyone: secretScopeKind(scope) === "shared" ? change.access.everyone : false,
        agents: [...new Set(change.access.agents)].filter((id) => id !== scope).sort(),
        spaces: [...new Set(change.access.spaces)].sort(),
      };
      if (JSON.stringify(access) !== JSON.stringify(entry.access)) {
        entry.access = access;
        this.audit(key, "access-changed", actor, accessDetail(access));
      }
    }
    if (changed.length) this.audit(key, "settings-changed", actor, changed.join(", "));
    this.#save();
    this.project();
  }

  /** The value of a key for the owner: the current one, or an earlier version. */
  reveal(scope: string, name: string, actor: SecretActor, purpose: "show" | "copy", version?: number): string {
    const entry = this.#entry(scope, name);
    const stored = version === undefined ? entry.values.at(-1) : entry.values.find((item) => item.version === version);
    if (!stored) throw new SecretLedgerError("That version is gone.");
    const value = this.#decrypt(stored.data);
    this.audit(
      keyOf(scope, name),
      purpose === "copy" ? "copied" : "revealed",
      actor,
      version === undefined ? undefined : `version ${version}`,
    );
    return value;
  }

  /** Makes an earlier value the current one again, as a new version: history only grows. */
  rollback(scope: string, name: string, version: number, actor: SecretActor): void {
    const entry = this.#entry(scope, name);
    const stored = entry.values.find((item) => item.version === version);
    if (!stored || stored === entry.values.at(-1)) throw new SecretLedgerError("That version is gone.");
    this.#pushValue(entry, this.#decrypt(stored.data), actor);
    this.audit(keyOf(scope, name), "rolled-back", actor, `version ${version}`);
    this.#save();
    this.project();
  }

  /** Moves a key to the bin: agents stop reading it at once; it can come back for 30 days. */
  remove(scope: string, name: string, actor: SecretActor): boolean {
    const state = this.#load();
    const key = keyOf(scope, name);
    const entry = state.secrets[key];
    if (!entry) return false;
    delete state.secrets[key];
    state.trash = state.trash.filter((item) => keyOf(item.entry.scope, item.entry.name) !== key);
    state.trash.push({ entry, deletedAt: this.#now(), by: cleanActor(actor) });
    if (state.trash.length > SECRET_VAULT_LIMITS.trash) state.trash.shift();
    this.audit(key, "deleted", actor);
    this.#save();
    this.project();
    return true;
  }

  restore(scope: string, name: string, actor: SecretActor): void {
    const state = this.#load();
    const key = keyOf(scope, name);
    if (state.secrets[key]) throw new SecretLedgerError("A key with that name exists.");
    const index = state.trash.findIndex((item) => keyOf(item.entry.scope, item.entry.name) === key);
    if (index < 0) throw new SecretLedgerError("That key is no longer in the bin.");
    if (secretScopeKind(scope) === "agent" && !this.#agents().some((agent) => agent.id === scope))
      throw new SecretLedgerError("The agent of that key is gone.");
    const [item] = state.trash.splice(index, 1);
    if (!item) throw new SecretLedgerError("That key is no longer in the bin.");
    state.secrets[key] = item.entry;
    this.audit(key, "restored", actor);
    this.#save();
    this.project();
  }

  /** Deletes a key from the bin for good: its values are gone; its history stays. */
  purge(scope: string, name: string, actor: SecretActor): void {
    const state = this.#load();
    const key = keyOf(scope, name);
    const before = state.trash.length;
    state.trash = state.trash.filter((item) => keyOf(item.entry.scope, item.entry.name) !== key);
    if (state.trash.length === before) throw new SecretLedgerError("That key is no longer in the bin.");
    this.audit(key, "purged", actor);
    this.#save();
  }

  /** Every key of a deleted agent goes to the bin. */
  removeScope(scope: string, actor: SecretActor): void {
    for (const entry of Object.values(this.#load().secrets))
      if (entry.scope === scope) this.remove(entry.scope, entry.name, actor);
  }

  #entry(scope: string, name: string): Entry {
    const entry = this.#load().secrets[keyOf(scope, name)];
    if (!entry) throw new SecretLedgerError("There is no such key.");
    return entry;
  }

  #validRef(scope: string, name: string): void {
    if (!NAME_PATTERN.test(name)) throw new SecretLedgerError("Invalid key name.");
    const kind = secretScopeKind(scope);
    if (kind === "agent" && !AGENT_ID_PATTERN.test(scope)) throw new SecretLedgerError("Invalid scope.");
    if (kind === "space" && !AGENT_ID_PATTERN.test(scope.slice("space:".length)))
      throw new SecretLedgerError("Invalid scope.");
  }

  // --- Access --------------------------------------------------------------------------------------

  #expired(entry: Entry, now = this.#now()): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= now;
  }

  /**
   * Whether `agentId` may read the key, whatever its expiry: its scope, the key's own list, or the
   * list of a folder the key sits in (a folder's access reaches every key under it).
   */
  #allowed(entry: Entry, agentId: string): boolean {
    const kind = secretScopeKind(entry.scope);
    if (kind === "agent" && entry.scope === agentId) return true;
    if (kind === "shared" && entry.access.everyone) return true;
    const space = this.#agents().find((agent) => agent.id === agentId)?.spaceId ?? null;
    const folders = this.#load().folders ?? {};
    const lists = [entry.access, ...secretFolderAncestors(entry.folder).flatMap((path) => folders[path] ?? [])];
    if (lists.some((list) => list.agents.includes(agentId))) return true;
    if (!space) return false;
    if (kind === "space" && entry.scope === `space:${space}`) return true;
    return lists.some((list) => list.spaces.includes(space));
  }

  /** The folders with an access of their own. */
  folders(): { path: string; agents: string[]; spaces: string[] }[] {
    return Object.entries(this.#load().folders ?? {})
      .map(([path, access]) => ({ path, agents: access.agents, spaces: access.spaces }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  /** Sets who may use every key under `path`. Empty lists remove the folder's access. */
  setFolderAccess(path: string, agents: readonly string[], spaces: readonly string[], actor: SecretActor): void {
    const state = this.#load();
    const folders = { ...(state.folders ?? {}) };
    const access = { agents: [...new Set(agents)].sort(), spaces: [...new Set(spaces)].sort() };
    if (access.agents.length === 0 && access.spaces.length === 0) delete folders[path];
    else folders[path] = access;
    state.folders = folders;
    for (const entry of Object.values(state.secrets))
      if (secretFolderAncestors(entry.folder).includes(path))
        this.audit(keyOf(entry.scope, entry.name), "access-changed", actor, `folder ${path}`);
    this.#save();
    this.project();
  }

  /** Where agent `agentId` finds the key, when it may read it now: its own, a grant, or the shared folder. */
  #agentPath(entry: Entry, agentId: string): string | null {
    if (this.#expired(entry) || !this.#allowed(entry, agentId)) return null;
    const kind = secretScopeKind(entry.scope);
    if (kind === "agent" && entry.scope === agentId) return join(this.#root, agentId, entry.name);
    if (kind === "shared" && entry.access.everyone) {
      // An own key or a grant of the same name comes first, as in `resolveFor`.
      return join(this.#root, SHARED_FOLDER, entry.name);
    }
    return join(this.#root, GRANTS_FOLDER, agentId, entry.name);
  }

  /** The keys agent `agentId` reads, one per name: its own, then a grant, then a shared one. */
  keysFor(agentId: string): { name: string; path: string; scope: string }[] {
    const byName = new Map<string, { name: string; path: string; scope: string; rank: number }>();
    for (const entry of Object.values(this.#load().secrets)) {
      const path = this.#agentPath(entry, agentId);
      if (!path) continue;
      const rank = rankFor(entry, agentId);
      const known = byName.get(entry.name);
      if (!known || rank < known.rank) byName.set(entry.name, { name: entry.name, path, scope: entry.scope, rank });
    }
    return [...byName.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, path, scope }) => ({ name, path, scope }));
  }

  /**
   * The value an agent gets for `name` now, or null: `agent` its own key only, `shared` the shared
   * one when it may read it, `any` the one `keysFor` lists. A refusal and a use go to the key's log.
   */
  resolveFor(
    mode: "agent" | "shared" | "any",
    agentId: string | null,
    name: string,
    actor?: SecretActor,
  ): { scope: string; value: string } | null {
    if (!NAME_PATTERN.test(name)) return null;
    const state = this.#load();
    if (agentId === null) {
      // The host's own helpers: the shared key, while it is in force.
      const entry = mode === "agent" ? undefined : state.secrets[keyOf("shared", name)];
      if (!entry || this.#expired(entry)) return null;
      const value = this.#currentValue(entry);
      if (value !== null && actor) this.#noteUse(entry, actor);
      return value === null ? null : { scope: "shared", value };
    }
    let candidates = Object.values(state.secrets).filter((entry) => entry.name === name);
    if (mode === "agent") candidates = candidates.filter((entry) => entry.scope === agentId);
    if (mode === "shared") candidates = candidates.filter((entry) => entry.scope === "shared");
    candidates.sort((left, right) => rankFor(left, agentId) - rankFor(right, agentId));
    const user = actor ?? { kind: "agent" as const, id: agentId, name: this.#agentName(agentId) };
    for (const entry of candidates) {
      if (this.#agentPath(entry, agentId) === null) {
        this.#noteRefusal(entry, user, this.#expired(entry) ? "expired" : "not allowed");
        continue;
      }
      const value = this.#currentValue(entry);
      if (value === null) continue;
      this.#noteUse(entry, user, agentId);
      return { scope: entry.scope, value };
    }
    return null;
  }

  #agentName(agentId: string): string | undefined {
    return this.#agents().find((agent) => agent.id === agentId)?.name;
  }

  #noteUse(entry: Entry, actor: SecretActor, agentId?: string): void {
    const now = this.#now();
    const key = keyOf(entry.scope, entry.name);
    const logKey = `${key}|${actor.kind}|${actor.id ?? ""}`;
    if (now - (this.#lastUseLog.get(logKey) ?? 0) < USE_LOG_INTERVAL_MS) return;
    this.#lastUseLog.set(logKey, now);
    entry.lastUsedAt = now;
    if (agentId) entry.usedBy[agentId] = now;
    this.audit(key, "used", actor);
    this.#save();
  }

  #noteRefusal(entry: Entry, actor: SecretActor, why: string): void {
    const now = this.#now();
    const key = keyOf(entry.scope, entry.name);
    const logKey = `${key}|blocked|${actor.id ?? ""}`;
    if (now - (this.#lastUseLog.get(logKey) ?? 0) < USE_LOG_INTERVAL_MS) return;
    this.#lastUseLog.set(logKey, now);
    this.audit(key, "blocked", actor, why);
  }

  /** A use the host saw elsewhere, such as a fill on a site. */
  noteUse(scope: string, name: string, actor: SecretActor, agentId?: string, detail?: string): void {
    const entry = this.#load().secrets[keyOf(scope, name)];
    if (!entry) return;
    if (detail) {
      entry.lastUsedAt = this.#now();
      if (agentId) entry.usedBy[agentId] = entry.lastUsedAt;
      this.audit(keyOf(scope, name), "used", actor, detail);
      this.#save();
      return;
    }
    this.#noteUse(entry, actor, agentId);
  }

  /** An agent asked the owner for this key. */
  noteRequested(scope: string, name: string, actor: SecretActor): void {
    this.audit(keyOf(scope, name), "requested", actor);
  }

  // --- Projection ----------------------------------------------------------------------------------

  /**
   * Makes the files agents read match the ledger: a file for each key each agent may read now, and
   * none for a key that is expired, deleted or not given to it. Only the files this store wrote are
   * removed; a file that changed since is read into the ledger first by `migrate`.
   */
  project(): void {
    const state = this.#load();
    const projection = this.#loadProjection();
    const wanted = new Map<string, { key: string; entry: Entry }>();
    const now = this.#now();
    const agents = this.#agents();
    for (const entry of Object.values(state.secrets)) {
      if (this.#expired(entry, now)) continue;
      const key = keyOf(entry.scope, entry.name);
      const kind = secretScopeKind(entry.scope);
      if (kind === "agent") wanted.set(`${entry.scope}/${entry.name}`, { key, entry });
      if (kind === "shared" && entry.access.everyone) wanted.set(`${SHARED_FOLDER}/${entry.name}`, { key, entry });
    }
    for (const agent of agents) {
      if (!AGENT_ID_PATTERN.test(agent.id)) continue;
      for (const { name, path, scope } of this.keysFor(agent.id)) {
        if (!path.startsWith(join(this.#root, GRANTS_FOLDER))) continue;
        const entry = state.secrets[keyOf(scope, name)];
        if (entry) wanted.set(`${GRANTS_FOLDER}/${agent.id}/${name}`, { key: keyOf(scope, name), entry });
      }
    }
    // Files this store wrote that no key wants any more.
    for (const relative of Object.keys(projection.files)) {
      if (wanted.has(relative)) continue;
      rmSync(join(this.#root, relative), { force: true });
      delete projection.files[relative];
    }
    // Key files from before the ledger that no key wants (expired, deleted): `migrate` took them in.
    for (const folder of [SHARED_FOLDER, ...agents.map((agent) => agent.id)]) {
      if (!AGENT_ID_PATTERN.test(folder) && folder !== SHARED_FOLDER) continue;
      for (const name of folderNames(join(this.#root, folder)))
        if (NAME_PATTERN.test(name) && !wanted.has(`${folder}/${name}`)) {
          const scope = folder === SHARED_FOLDER ? "shared" : folder;
          if (
            state.secrets[keyOf(scope, name)] ||
            state.trash.some((item) => keyOf(item.entry.scope, item.entry.name) === keyOf(scope, name))
          )
            rmSync(join(this.#root, folder, name), { force: true });
        }
    }
    for (const folder of folderNames(join(this.#root, GRANTS_FOLDER)))
      for (const name of folderNames(join(this.#root, GRANTS_FOLDER, folder)))
        if (!wanted.has(`${GRANTS_FOLDER}/${folder}/${name}`))
          rmSync(join(this.#root, GRANTS_FOLDER, folder, name), { force: true });
    for (const [relative, { key, entry }] of wanted) {
      const current = entry.values.at(-1);
      if (!current) continue;
      const path = join(this.#root, relative);
      const known = projection.files[relative];
      let info: Stats | null = null;
      try {
        info = statSync(path);
      } catch {
        info = null;
      }
      if (
        known &&
        info &&
        known.key === key &&
        known.version === current.version &&
        known.size === info.size &&
        Math.abs(known.mtimeMs - info.mtimeMs) < 1
      )
        continue;
      const value = this.#currentValue(entry);
      if (value === null) continue;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeAtomically(path, value);
      projection.files[relative] = projected(key, entry, statSync(path));
    }
    this.#saveProjection();
  }

  /** Reads by agents of the files: a file read after it was written marks a use. Daily at the finest. */
  #observeReads(): void {
    const projection = this.#loadProjection();
    const state = this.#load();
    let changed = false;
    for (const [relative, file] of Object.entries(projection.files)) {
      let info: Stats;
      try {
        info = statSync(join(this.#root, relative));
      } catch {
        continue;
      }
      if (info.atimeMs <= file.atimeMs + 1000) continue;
      file.atimeMs = info.atimeMs;
      changed = true;
      const entry = state.secrets[file.key];
      if (!entry) continue;
      const at = Math.min(Math.round(info.atimeMs), this.#now());
      entry.lastUsedAt = Math.max(entry.lastUsedAt ?? 0, at);
      const parts = relative.split("/");
      const agentId = parts[0] === GRANTS_FOLDER ? parts[1] : parts[0] === SHARED_FOLDER ? undefined : parts[0];
      if (agentId) entry.usedBy[agentId] = Math.max(entry.usedBy[agentId] ?? 0, at);
    }
    if (changed) {
      this.#save();
      this.#saveProjection();
    }
  }

  // --- Upkeep --------------------------------------------------------------------------------------

  /**
   * The periodic upkeep: an expired key leaves the agents' files, the bin forgets keys older than 30
   * days, and the reminders that are due come back for the owner's list.
   */
  sweep(): LedgerReminder[] {
    const now = this.#now();
    const state = this.#load();
    const reminders: LedgerReminder[] = [];
    let changed = false;
    const before = state.trash.length;
    state.trash = state.trash.filter((item) => {
      const keep = now - item.deletedAt < SECRET_TRASH_DAYS * DAY;
      if (!keep) this.audit(keyOf(item.entry.scope, item.entry.name), "purged", { kind: "host" }, "after 30 days");
      return keep;
    });
    if (state.trash.length !== before) changed = true;
    for (const entry of Object.values(state.secrets)) {
      const key = keyOf(entry.scope, entry.name);
      if (this.#expired(entry, now) && !entry.expiredLogged) {
        entry.expiredLogged = true;
        changed = true;
        this.audit(key, "expired", { kind: "host" });
      }
      const due = reminderFor(entry, now);
      if (due && entry.reminded !== due.id) {
        entry.reminded = due.id;
        changed = true;
        this.audit(key, "reminded", { kind: "host" }, due.reason);
        reminders.push({
          key,
          agentId: this.#reminderAgent(entry),
          label: entry.label || entry.name,
          reason: due.reason,
          at: due.at,
        });
      }
    }
    if (changed) this.#save();
    this.project();
    return reminders;
  }

  #reminderAgent(entry: Entry): string | null {
    if (secretScopeKind(entry.scope) === "agent") return entry.scope;
    const used = Object.entries(entry.usedBy).sort((left, right) => right[1] - left[1])[0];
    if (used && this.#agents().some((agent) => agent.id === used[0])) return used[0];
    return this.#agents()[0]?.id ?? null;
  }

  /** The time of the next expiry, so the host can take the key away right then. */
  nextExpiry(): number | null {
    const now = this.#now();
    let next: number | null = null;
    for (const entry of Object.values(this.#load().secrets))
      if (entry.expiresAt !== undefined && entry.expiresAt > now && (next === null || entry.expiresAt < next))
        next = entry.expiresAt;
    return next;
  }

  // --- Views ---------------------------------------------------------------------------------------

  #summary(entry: Entry): SecretSummary {
    const current = entry.values.at(-1);
    return {
      scope: entry.scope,
      name: entry.name,
      type: entry.type ?? guessSecretKind(entry.name),
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.folder ? { folder: entry.folder } : {}),
      tags: entry.tags ?? [],
      ...(entry.note ? { note: entry.note } : {}),
      access: entry.access,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(entry.rotatedAt !== undefined ? { rotatedAt: entry.rotatedAt } : {}),
      ...(entry.rotateBy !== undefined ? { rotateBy: entry.rotateBy } : {}),
      ...(entry.rotateEveryDays !== undefined ? { rotateEveryDays: entry.rotateEveryDays } : {}),
      ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
      ...(entry.lastUsedAt !== undefined ? { lastUsedAt: entry.lastUsedAt } : {}),
      usedBy: Object.entries(entry.usedBy)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 50)
        .map(([agentId, at]) => ({ agentId, at })),
      version: current?.version ?? 1,
    };
  }

  list(): SecretSummary[] {
    this.#observeReads();
    return (
      Object.values(this.#load().secrets)
        .map((entry) => this.#summary(entry))
        // The shared keys first, then the spaces' and each agent's, as the store's folders were listed.
        .sort(
          (left, right) =>
            scopeOrder(left.scope) - scopeOrder(right.scope) ||
            left.scope.localeCompare(right.scope) ||
            left.name.localeCompare(right.name),
        )
        .slice(0, SECRET_VAULT_LIMITS.secrets)
    );
  }

  trash(): TrashedSecret[] {
    return this.#load()
      .trash.map((item) => ({
        scope: item.entry.scope,
        name: item.entry.name,
        ...(item.entry.label ? { label: item.entry.label } : {}),
        deletedAt: item.deletedAt,
        ...(item.by ? { by: item.by } : {}),
      }))
      .reverse();
  }

  detail(scope: string, name: string): SecretDetail {
    this.#observeReads();
    const entry = this.#entry(scope, name);
    const current = entry.values.at(-1);
    const versions: SecretVersion[] = entry.values
      .map((item) => ({
        version: item.version,
        createdAt: item.createdAt,
        ...(item.by ? { by: item.by } : {}),
        current: item === current,
      }))
      .reverse();
    return { secret: this.#summary(entry), versions, audit: this.#auditRows(keyOf(scope, name)) };
  }

  // --- Moving to another server --------------------------------------------------------------------

  /** Every key in force, with its details, in a bundle only the passphrase opens (scrypt, AES-256-GCM). */
  exportBundle(passphrase: string, actor: SecretActor): { bundle: string; count: number } {
    const entries = Object.values(this.#load().secrets);
    const secrets = entries.flatMap((entry) => {
      const value = this.#currentValue(entry);
      if (value === null) return [];
      return [
        {
          scope: entry.scope,
          name: entry.name,
          value,
          settings: settingsOf(entry),
          ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
          ...(entry.rotateBy !== undefined ? { rotateBy: entry.rotateBy } : {}),
          ...(entry.rotateEveryDays !== undefined ? { rotateEveryDays: entry.rotateEveryDays } : {}),
          access: entry.access,
        },
      ];
    });
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ secrets }), "utf8"), cipher.final()]);
    const bundle = Buffer.from(
      JSON.stringify({
        format: BUNDLE_FORMAT,
        version: 1,
        kdf: "scrypt-n15-r8-p1",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      }),
    ).toString("base64");
    for (const entry of entries) this.audit(keyOf(entry.scope, entry.name), "exported", actor);
    return { bundle, count: secrets.length };
  }

  /**
   * Opens a bundle and saves its keys: a new key is added, a changed one gets a new version. A key of
   * an agent this server does not have comes in as a shared key that no agent reads yet.
   */
  importBundle(
    bundle: string,
    passphrase: string,
    actor: SecretActor,
  ): { added: number; updated: number; unchanged: number } {
    const secrets = openBundle(bundle, passphrase);
    const result = { added: 0, updated: 0, unchanged: 0 };
    const agents = new Set(this.#agents().map((agent) => agent.id));
    for (const item of secrets) {
      let scope = item.scope;
      let access = item.access;
      const kind = secretScopeKind(scope);
      if (kind === "agent" && !agents.has(scope)) {
        scope = "shared";
        access = { everyone: false, agents: [], spaces: [] };
      }
      if (!NAME_PATTERN.test(item.name)) continue;
      const key = keyOf(scope, item.name);
      const existing = this.#load().secrets[key];
      if (existing && this.#currentValue(existing) === item.value) {
        result.unchanged += 1;
        continue;
      }
      if (existing) result.updated += 1;
      else result.added += 1;
      this.save(scope, item.name, item.value, actor, item.settings);
      const entry = this.#entry(scope, item.name);
      if (!existing) {
        entry.access = {
          everyone: secretScopeKind(scope) === "shared" ? access.everyone : false,
          agents: access.agents.filter((id) => agents.has(id)),
          spaces: access.spaces,
        };
        if (item.expiresAt !== undefined) entry.expiresAt = item.expiresAt;
        if (item.rotateBy !== undefined) entry.rotateBy = item.rotateBy;
        if (item.rotateEveryDays !== undefined) entry.rotateEveryDays = item.rotateEveryDays;
      }
      this.audit(key, "imported", actor);
    }
    this.#save();
    this.project();
    return result;
  }
}

interface BundleSecret {
  scope: string;
  name: string;
  value: string;
  settings: SecretSettings;
  access: SecretAccess;
  expiresAt?: number;
  rotateBy?: number;
  rotateEveryDays?: number;
}

function openBundle(bundle: string, passphrase: string): BundleSecret[] {
  let envelope: DynamicRecord;
  try {
    envelope = parseStoredJson("bundle", Buffer.from(bundle.trim(), "base64").toString("utf8"), bundleEnvelope);
  } catch {
    throw new SecretLedgerError("This is not a keys bundle.");
  }
  let text: string;
  try {
    const key = scryptSync(passphrase, Buffer.from(String(envelope.salt), "base64"), 32, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(String(envelope.iv), "base64"));
    decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64"));
    text = Buffer.concat([decipher.update(Buffer.from(String(envelope.data), "base64")), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new SecretLedgerError("The passphrase does not open this bundle.");
  }
  try {
    return parseStoredJson("bundle", text, bundleSecrets);
  } catch {
    throw new SecretLedgerError("This is not a keys bundle.");
  }
}

// --- Stored shapes, checked when read ----------------------------------------------------------------

function fail(): never {
  throw new Error("Damaged keys store file.");
}

const isActor = (value: unknown): value is SecretActor =>
  isDynamicRecord(value) &&
  SECRET_ACTOR_KINDS.some((kind) => kind === value.kind) &&
  (value.id === undefined || typeof value.id === "string") &&
  (value.name === undefined || typeof value.name === "string");

const isNumberRecord = (value: unknown): value is Record<string, number> =>
  isDynamicRecord(value) && Object.values(value).every((item) => typeof item === "number");

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function isAccess(value: unknown): value is SecretAccess {
  return (
    isDynamicRecord(value) &&
    typeof value.everyone === "boolean" &&
    isStringList(value.agents) &&
    isStringList(value.spaces)
  );
}

function isStoredValue(value: unknown): value is StoredValue {
  return (
    isDynamicRecord(value) &&
    typeof value.version === "number" &&
    typeof value.createdAt === "number" &&
    typeof value.data === "string" &&
    (value.by === undefined || isActor(value.by))
  );
}

function isEntry(value: unknown): value is Entry {
  return (
    isDynamicRecord(value) &&
    typeof value.scope === "string" &&
    typeof value.name === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    isAccess(value.access) &&
    isNumberRecord(value.usedBy) &&
    Array.isArray(value.values) &&
    value.values.every(isStoredValue) &&
    (value.tags === undefined || isStringList(value.tags))
  );
}

function isTrashEntry(value: unknown): value is TrashEntry {
  return isDynamicRecord(value) && typeof value.deletedAt === "number" && isEntry(value.entry);
}

function ledgerFile(value: unknown): LedgerFile {
  if (!isDynamicRecord(value) || value.version !== 1 || !isDynamicRecord(value.secrets)) fail();
  if (!Array.isArray(value.trash) || !value.trash.every(isTrashEntry)) fail();
  const secrets: Record<string, Entry> = {};
  for (const [key, entry] of Object.entries(value.secrets)) if (isEntry(entry)) secrets[key] = entry;
  const folders: Record<string, FolderAccess> = {};
  if (isDynamicRecord(value.folders))
    for (const [path, access] of Object.entries(value.folders))
      if (isDynamicRecord(access) && isStringList(access.agents) && isStringList(access.spaces))
        folders[path] = { agents: access.agents, spaces: access.spaces };
  return { version: 1, secrets, trash: value.trash, folders };
}

function isProjectedFile(value: unknown): value is ProjectedFile {
  return (
    isDynamicRecord(value) &&
    typeof value.key === "string" &&
    typeof value.version === "number" &&
    typeof value.size === "number" &&
    typeof value.mtimeMs === "number" &&
    typeof value.atimeMs === "number"
  );
}

function projectionFile(value: unknown): ProjectionFile {
  if (!isDynamicRecord(value) || value.version !== 1 || !isDynamicRecord(value.files)) fail();
  const files: Record<string, ProjectedFile> = {};
  for (const [path, file] of Object.entries(value.files)) if (isProjectedFile(file)) files[path] = file;
  return { version: 1, files };
}

function auditLine(value: unknown): SecretAuditRow & { key: string } {
  if (!isDynamicRecord(value) || typeof value.key !== "string" || typeof value.at !== "number") fail();
  const action = SECRET_AUDIT_ACTIONS.find((candidate) => candidate === value.action);
  if (!action || !isActor(value.actor)) fail();
  return {
    key: value.key,
    at: value.at,
    action,
    actor: value.actor,
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
  };
}

function bundleEnvelope(value: unknown): DynamicRecord {
  if (!isDynamicRecord(value) || value.format !== BUNDLE_FORMAT || value.version !== 1) fail();
  return value;
}

function bundleSecrets(value: unknown): BundleSecret[] {
  if (!isDynamicRecord(value) || !Array.isArray(value.secrets)) fail();
  return value.secrets.flatMap((item): BundleSecret[] => {
    if (!isDynamicRecord(item) || typeof item.scope !== "string" || typeof item.name !== "string") return [];
    if (typeof item.value !== "string" || item.value === "") return [];
    const settings = isDynamicRecord(item.settings) ? bundleSettings(item.settings) : {};
    const access = isAccess(item.access) ? item.access : { everyone: true, agents: [], spaces: [] };
    return [
      {
        scope: item.scope,
        name: item.name,
        value: item.value,
        settings,
        access,
        ...(typeof item.expiresAt === "number" ? { expiresAt: item.expiresAt } : {}),
        ...(typeof item.rotateBy === "number" ? { rotateBy: item.rotateBy } : {}),
        ...(typeof item.rotateEveryDays === "number" ? { rotateEveryDays: item.rotateEveryDays } : {}),
      },
    ];
  });
}

function bundleSettings(value: DynamicRecord): SecretSettings {
  const type = SECRET_KINDS.find((kind) => kind === value.type);
  return {
    ...(type ? { type } : {}),
    ...(typeof value.label === "string" ? { label: value.label.slice(0, 80) } : {}),
    ...(typeof value.folder === "string" ? { folder: normalizeSecretFolder(value.folder) ?? "" } : {}),
    ...(isStringList(value.tags) ? { tags: value.tags.filter(isSecretTag).slice(0, 12) } : {}),
    ...(typeof value.note === "string" ? { note: value.note.slice(0, 500) } : {}),
  };
}

function reminderFor(entry: Entry, now: number): { id: string; reason: LedgerReminder["reason"]; at: number } | null {
  if (entry.expiresAt !== undefined) {
    if (entry.expiresAt <= now) return { id: `expired:${entry.expiresAt}`, reason: "expired", at: entry.expiresAt };
    if (entry.expiresAt - now <= 3 * DAY)
      return { id: `expiring:${entry.expiresAt}`, reason: "expiring", at: entry.expiresAt };
  }
  if (entry.rotateBy !== undefined && entry.rotateBy <= now)
    return { id: `rotate:${entry.rotateBy}`, reason: "rotate", at: entry.rotateBy };
  return null;
}

/** Lower first: the agent's own key, another agent's given to it, a space's, a shared one. */
function rankFor(entry: Entry, agentId: string) {
  const kind = secretScopeKind(entry.scope);
  if (kind === "agent") return entry.scope === agentId ? 0 : 1;
  if (kind === "space") return 2;
  return entry.access.everyone ? 4 : 3;
}

function scopeOrder(scope: string) {
  const kind = secretScopeKind(scope);
  return kind === "shared" ? 0 : kind === "space" ? 1 : 2;
}

function newEntry(scope: string, name: string, at: number, actor: SecretActor): Entry {
  return {
    scope,
    name,
    access: { everyone: secretScopeKind(scope) === "shared", agents: [], spaces: [] },
    createdAt: at,
    createdBy: cleanActor(actor),
    updatedAt: at,
    usedBy: {},
    values: [],
  };
}

function applySettings(entry: Entry, settings: SecretSettings): void {
  if (settings.type !== undefined) entry.type = settings.type;
  for (const field of ["label", "folder", "note"] as const) {
    const value = settings[field];
    if (value === undefined) continue;
    if (value === "") delete entry[field];
    else entry[field] = value;
  }
  if (settings.tags !== undefined) {
    if (settings.tags.length) entry.tags = settings.tags;
    else delete entry.tags;
  }
}

function settingsOf(entry: Entry): SecretSettings {
  return {
    ...(entry.type ? { type: entry.type } : {}),
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.folder ? { folder: entry.folder } : {}),
    ...(entry.tags?.length ? { tags: entry.tags } : {}),
    ...(entry.note ? { note: entry.note } : {}),
  };
}

function accessDetail(access: SecretAccess): string {
  const parts = [
    ...(access.everyone ? ["everyone"] : []),
    ...(access.agents.length ? [`${access.agents.length} agents`] : []),
    ...(access.spaces.length ? [`${access.spaces.length} spaces`] : []),
  ];
  return parts.join(", ") || "scope only";
}

function projected(key: string, entry: Entry, info: Stats): ProjectedFile {
  return {
    key,
    version: entry.values.at(-1)?.version ?? 1,
    size: info.size,
    mtimeMs: info.mtimeMs,
    atimeMs: Math.max(info.atimeMs, info.mtimeMs),
  };
}

function cleanActor(actor: SecretActor): SecretActor {
  return {
    kind: actor.kind,
    ...(actor.id ? { id: clip(actor.id, 128) } : {}),
    ...(actor.name ? { name: clip(actor.name, 120) } : {}),
  };
}

function clip(text: string, maximum: number): string {
  return text.length > maximum ? text.slice(0, maximum) : text;
}

function folderNames(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

/** Writes beside the target and renames over it, readable by this user only. */
function writeAtomically(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, path);
}
