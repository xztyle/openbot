// The keys and passwords screen ("Claves y contraseñas"): one call with a `kind`, on the desktop
// IPC (`agent:workspace:vault`) and the Team API (`POST /v1/workspace/vault`). A value travels to a
// client only in the answer to the owner's `reveal`; every other answer holds names and metadata.

import { integerInRange, isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { WORKSPACE_SECRET_NAME_PATTERN, WORKSPACE_SECRET_VALUE_LIMIT } from "./ipc-workspace-fleet";
import { type DynamicRecord, isDynamicRecord, isString } from "./runtime-values";

export const SECRET_KINDS = ["key", "password", "token", "code", "other"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

/** A space's keys: every agent of the space reads them. */
export const SECRET_SPACE_SCOPE_PREFIX = "space:";

export const SECRET_VAULT_LIMITS = {
  secrets: 2000,
  label: 80,
  folder: 160,
  tags: 12,
  tag: 32,
  note: 500,
  agents: 500,
  spaces: 200,
  versions: 50,
  audit: 300,
  trash: 500,
  requests: 200,
  detail: 300,
  passphraseMin: 8,
  passphrase: 256,
  bundle: 8 * 1024 * 1024,
} as const;

/** Days a deleted key stays restorable. */
export const SECRET_TRASH_DAYS = 30;
/** Days without a use after which a key counts as unused. */
export const SECRET_UNUSED_DAYS = 30;
/** Days before a rotation or an expiry date at which a key shows as due soon. */
export const SECRET_SOON_DAYS = 14;

const DAY = 86_400_000;
const FOLDER_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,47}(?:\/[\p{L}\p{N}][\p{L}\p{N} ._-]{0,47}){0,5}$/u;
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u;

export type SecretActorKind = "owner" | "person" | "agent" | "routine" | "host";
export const SECRET_ACTOR_KINDS: readonly SecretActorKind[] = ["owner", "person", "agent", "routine", "host"];

/** Who did something to a key: a person, an agent, a routine, or the host by itself. */
export interface SecretActor {
  kind: SecretActorKind;
  id?: string;
  name?: string;
}

/**
 * Who may read a key beyond its scope. A shared key reaches every agent while `everyone` is true;
 * with it false only the listed agents and spaces read it. An agent's key always reaches that
 * agent, a space's key every agent of the space; the lists add readers. A new key has empty lists.
 */
export interface SecretAccess {
  everyone: boolean;
  agents: string[];
  spaces: string[];
}

/** A key as the screen lists it: never its value. */
export interface SecretSummary {
  /** `shared`, `space:<id>` or an agent id. */
  scope: string;
  name: string;
  type: SecretKind;
  label?: string;
  /** A path of folders such as `universidad-online/meta`. */
  folder?: string;
  tags: string[];
  note?: string;
  access: SecretAccess;
  createdAt: number;
  updatedAt: number;
  /** When a new value last replaced an older one. Absent: never rotated. */
  rotatedAt?: number;
  /** The date the owner wants a new value by. */
  rotateBy?: number;
  /** Each new value moves `rotateBy` this many days ahead. */
  rotateEveryDays?: number;
  /** After this the host stops serving the key to agents. */
  expiresAt?: number;
  lastUsedAt?: number;
  /** The agents that used it, newest first. */
  usedBy: { agentId: string; at: number }[];
  /** The number of the current value: 1 for a key never changed. */
  version: number;
}

export type SecretAuditAction =
  | "created"
  | "changed"
  | "rolled-back"
  | "revealed"
  | "copied"
  | "used"
  | "blocked"
  | "access-changed"
  | "settings-changed"
  | "deleted"
  | "restored"
  | "purged"
  | "expired"
  | "exported"
  | "imported"
  | "requested"
  | "reminded";
export const SECRET_AUDIT_ACTIONS: readonly SecretAuditAction[] = [
  "created",
  "changed",
  "rolled-back",
  "revealed",
  "copied",
  "used",
  "blocked",
  "access-changed",
  "settings-changed",
  "deleted",
  "restored",
  "purged",
  "expired",
  "exported",
  "imported",
  "requested",
  "reminded",
];

/** One line of a key's history. Metadata only: never a value. */
export interface SecretAuditRow {
  at: number;
  action: SecretAuditAction;
  actor: SecretActor;
  /** A version number, a site, or what changed, in a few words. */
  detail?: string;
}

export interface SecretVersion {
  version: number;
  createdAt: number;
  by?: SecretActor;
  current: boolean;
}

export interface SecretDetail {
  secret: SecretSummary;
  versions: SecretVersion[];
  audit: SecretAuditRow[];
}

export interface TrashedSecret {
  scope: string;
  name: string;
  label?: string;
  deletedAt: number;
  by?: SecretActor;
}

/** What an agent waits for: a key to type in (`fill`) or the owner's yes to fill a saved one on a site. */
export type SecretRequest =
  | { kind: "fill"; requestId: string; agentId: string; name: string; shared: boolean; createdAt: number }
  | { kind: "approve"; requestId: string; agentId: string; name: string; site: string; createdAt: number };

export interface SecretOverview {
  secrets: SecretSummary[];
  trash: TrashedSecret[];
  requests: SecretRequest[];
}

export interface SecretRef {
  scope: string;
  name: string;
}

export interface SecretSettings {
  type?: SecretKind;
  /** An empty text clears it. */
  label?: string;
  folder?: string;
  tags?: string[];
  note?: string;
}

export type SecretVaultCall =
  | { kind: "overview" }
  | ({ kind: "detail" } & SecretRef)
  | ({ kind: "save"; value: string } & SecretRef & SecretSettings)
  | ({
      kind: "update";
      rotateBy?: number | null;
      rotateEveryDays?: number | null;
      expiresAt?: number | null;
      access?: SecretAccess;
    } & SecretRef &
      SecretSettings)
  | ({ kind: "reveal"; purpose: "show" | "copy"; version?: number } & SecretRef)
  | ({ kind: "rollback"; version: number } & SecretRef)
  | ({ kind: "delete" } & SecretRef)
  | ({ kind: "restore" } & SecretRef)
  | ({ kind: "purge" } & SecretRef)
  | { kind: "export"; passphrase: string }
  | { kind: "import"; bundle: string; passphrase: string }
  | { kind: "fill"; requestId: string; value: string }
  | { kind: "approve"; requestId: string; decision: "accept" | "decline" };

export type SecretVaultResult =
  | ({ kind: "overview" } & SecretOverview)
  | { kind: "detail"; detail: SecretDetail }
  | { kind: "value"; value: string }
  | { kind: "bundle"; bundle: string; count: number }
  | { kind: "imported"; added: number; updated: number; unchanged: number }
  | { kind: "done" };

/** The calls only the server's owner may make: values, access, and what cannot be undone. */
export function secretVaultCallIsOwnerOnly(call: SecretVaultCall): boolean {
  switch (call.kind) {
    case "reveal":
    case "export":
    case "import":
    case "purge":
    case "approve":
      return true;
    case "update":
      return call.access !== undefined;
    default:
      return false;
  }
}

export type SecretScopeKind = "shared" | "space" | "agent";

export function secretScopeKind(scope: string): SecretScopeKind {
  if (scope === "shared") return "shared";
  return scope.startsWith(SECRET_SPACE_SCOPE_PREFIX) ? "space" : "agent";
}

export function secretSpaceScope(spaceId: string): string {
  return `${SECRET_SPACE_SCOPE_PREFIX}${spaceId}`;
}

/** A best guess of the kind of a key from its name, for a key saved before kinds existed. */
export function guessSecretKind(name: string): SecretKind {
  if (/PASSWORD|PASSWD|_PASS$|PIN$/.test(name)) return "password";
  if (/TOTP|2FA|MFA|OTP/.test(name)) return "code";
  if (/TOKEN|BEARER|SESSION|COOKIE/.test(name)) return "token";
  if (/KEY|SECRET/.test(name)) return "key";
  return "other";
}

export type SecretHealth = "expired" | "expiring" | "rotate-due" | "rotate-soon" | "unused" | "ok";

/** The one state a row shows, the most urgent first. */
export function secretHealth(secret: SecretSummary, now: number): SecretHealth {
  if (secret.expiresAt !== undefined && secret.expiresAt <= now) return "expired";
  if (secret.expiresAt !== undefined && secret.expiresAt - now <= SECRET_SOON_DAYS * DAY) return "expiring";
  if (secret.rotateBy !== undefined && secret.rotateBy <= now) return "rotate-due";
  if (secret.rotateBy !== undefined && secret.rotateBy - now <= SECRET_SOON_DAYS * DAY) return "rotate-soon";
  if (secretUnused(secret, now)) return "unused";
  return "ok";
}

export function secretUnused(secret: SecretSummary, now: number): boolean {
  const since = secret.lastUsedAt ?? secret.createdAt;
  return now - since > SECRET_UNUSED_DAYS * DAY;
}

// --- Parsing --------------------------------------------------------------------------------------

const isSecretKind = (value: unknown): value is SecretKind => SECRET_KINDS.some((kind) => kind === value);
const isActorKind = (value: unknown): value is SecretActorKind => SECRET_ACTOR_KINDS.some((kind) => kind === value);
const isAuditAction = (value: unknown): value is SecretAuditAction =>
  SECRET_AUDIT_ACTIONS.some((action) => action === value);

const isScope = (value: unknown): value is string =>
  value === "shared" ||
  (isString(value) &&
    value.startsWith(SECRET_SPACE_SCOPE_PREFIX) &&
    isIdentifier(value.slice(SECRET_SPACE_SCOPE_PREFIX.length))) ||
  (isIdentifier(value) && !String(value).includes(":"));
const isName = (value: unknown): value is string => isString(value) && WORKSPACE_SECRET_NAME_PATTERN.test(value);
const isTime = (value: unknown): value is number => integerInRange(value, 0, 8_640_000_000_000_000);
const isValue = (value: unknown): value is string =>
  isString(value) && value.trim() !== "" && new TextEncoder().encode(value).length <= WORKSPACE_SECRET_VALUE_LIMIT;

function fail(): never {
  throw new Error("Invalid keys and passwords request.");
}

function ref(value: DynamicRecord): SecretRef {
  if (!isScope(value.scope) || !isName(value.name)) fail();
  return { scope: value.scope, name: value.name };
}

function idList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every(isIdentifier)) fail();
  return [...new Set(value)];
}

export function parseSecretAccess(value: unknown): SecretAccess {
  if (!isDynamicRecord(value) || typeof value.everyone !== "boolean") fail();
  return {
    everyone: value.everyone,
    agents: idList(value.agents, SECRET_VAULT_LIMITS.agents),
    spaces: idList(value.spaces, SECRET_VAULT_LIMITS.spaces),
  };
}

function settings(value: DynamicRecord): SecretSettings {
  const result: SecretSettings = {};
  if (value.type !== undefined) {
    if (!isSecretKind(value.type)) fail();
    result.type = value.type;
  }
  if (value.label !== undefined) {
    if (!isBoundedString(value.label, SECRET_VAULT_LIMITS.label)) fail();
    result.label = value.label.trim();
  }
  if (value.folder !== undefined) {
    if (!isBoundedString(value.folder, SECRET_VAULT_LIMITS.folder)) fail();
    const folder = normalizeSecretFolder(value.folder);
    if (folder === null) fail();
    result.folder = folder;
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > SECRET_VAULT_LIMITS.tags) fail();
    const tags = value.tags.map((tag) => (isString(tag) ? tag.trim() : ""));
    if (!tags.every((tag) => TAG_PATTERN.test(tag))) fail();
    result.tags = [...new Set(tags)];
  }
  if (value.note !== undefined) {
    if (!isBoundedString(value.note, SECRET_VAULT_LIMITS.note)) fail();
    result.note = value.note.trim();
  }
  return result;
}

/** A folder path with clean separators, `""` for none, or null when it is not a folder path. */
export function normalizeSecretFolder(text: string): string | null {
  const folder = text
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
  if (folder === "") return "";
  return FOLDER_PATTERN.test(folder) ? folder : null;
}

export function isSecretTag(text: string): boolean {
  return TAG_PATTERN.test(text);
}

const nullableTime = (value: unknown): number | null => {
  if (value === null) return null;
  if (!isTime(value)) fail();
  return value;
};

export function parseSecretVaultCall(value: unknown): SecretVaultCall {
  if (!isDynamicRecord(value) || !isString(value.kind)) fail();
  switch (value.kind) {
    case "overview":
      return { kind: "overview" };
    case "detail":
    case "delete":
    case "restore":
    case "purge":
      return { kind: value.kind, ...ref(value) };
    case "save":
      if (!isValue(value.value)) fail();
      return { kind: "save", ...ref(value), value: value.value, ...settings(value) };
    case "update": {
      const call: Extract<SecretVaultCall, { kind: "update" }> = { kind: "update", ...ref(value), ...settings(value) };
      if (value.rotateBy !== undefined) call.rotateBy = nullableTime(value.rotateBy);
      if (value.expiresAt !== undefined) call.expiresAt = nullableTime(value.expiresAt);
      if (value.rotateEveryDays !== undefined) {
        if (value.rotateEveryDays !== null && !integerInRange(value.rotateEveryDays, 1, 3650)) fail();
        call.rotateEveryDays = value.rotateEveryDays;
      }
      if (value.access !== undefined) call.access = parseSecretAccess(value.access);
      return call;
    }
    case "reveal": {
      if (value.purpose !== "show" && value.purpose !== "copy") fail();
      const call: Extract<SecretVaultCall, { kind: "reveal" }> = {
        kind: "reveal",
        ...ref(value),
        purpose: value.purpose,
      };
      if (value.version !== undefined) {
        if (!integerInRange(value.version, 1, 1_000_000)) fail();
        call.version = value.version;
      }
      return call;
    }
    case "rollback":
      if (!integerInRange(value.version, 1, 1_000_000)) fail();
      return { kind: "rollback", ...ref(value), version: value.version };
    case "export":
      if (!isPassphrase(value.passphrase)) fail();
      return { kind: "export", passphrase: value.passphrase };
    case "import":
      if (!isPassphrase(value.passphrase) || !isBoundedString(value.bundle, SECRET_VAULT_LIMITS.bundle)) fail();
      return { kind: "import", bundle: value.bundle, passphrase: value.passphrase };
    case "fill":
      if (!isIdentifier(value.requestId) || !isValue(value.value)) fail();
      return { kind: "fill", requestId: value.requestId, value: value.value };
    case "approve":
      if (!isIdentifier(value.requestId) || (value.decision !== "accept" && value.decision !== "decline")) fail();
      return { kind: "approve", requestId: value.requestId, decision: value.decision };
    default:
      return fail();
  }
}

function isPassphrase(value: unknown): value is string {
  return (
    isString(value) &&
    value.length >= SECRET_VAULT_LIMITS.passphraseMin &&
    value.length <= SECRET_VAULT_LIMITS.passphrase
  );
}

// --- Decoding answers -----------------------------------------------------------------------------

function invalid(): never {
  throw new Error("Invalid keys and passwords answer.");
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (!isBoundedString(value, max)) invalid();
  return value;
}

function optionalTime(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isTime(value)) invalid();
  return value;
}

/** `{ [key]: value }` for a present value, `{}` for an absent one. */
function present<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  if (value === undefined) return {};
  const entry: Partial<Record<K, V>> = {};
  entry[key] = value;
  return entry;
}

function decodeActor(value: unknown): SecretActor {
  if (!isDynamicRecord(value) || !isActorKind(value.kind)) invalid();
  return {
    kind: value.kind,
    ...present("id", optionalText(value.id, 128)),
    ...present("name", optionalText(value.name, 120)),
  };
}

function decodeSummary(value: unknown): SecretSummary {
  if (!isDynamicRecord(value) || !isScope(value.scope) || !isName(value.name) || !isSecretKind(value.type)) invalid();
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => isBoundedString(tag, SECRET_VAULT_LIMITS.tag)))
    invalid();
  if (!isTime(value.createdAt) || !isTime(value.updatedAt) || !integerInRange(value.version, 1, 1_000_000)) invalid();
  if (!Array.isArray(value.usedBy)) invalid();
  const usedBy = value.usedBy.map((entry) => {
    if (!isDynamicRecord(entry) || !isIdentifier(entry.agentId) || !isTime(entry.at)) invalid();
    return { agentId: entry.agentId, at: entry.at };
  });
  let access: SecretAccess;
  try {
    access = parseSecretAccess(value.access);
  } catch {
    invalid();
  }
  let rotateEveryDays: number | undefined;
  if (value.rotateEveryDays !== undefined) {
    if (!integerInRange(value.rotateEveryDays, 1, 3650)) invalid();
    rotateEveryDays = value.rotateEveryDays;
  }
  return {
    scope: value.scope,
    name: value.name,
    type: value.type,
    tags: value.tags,
    access,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    usedBy,
    version: value.version,
    ...present("label", optionalText(value.label, SECRET_VAULT_LIMITS.label)),
    ...present("folder", optionalText(value.folder, SECRET_VAULT_LIMITS.folder)),
    ...present("note", optionalText(value.note, SECRET_VAULT_LIMITS.note)),
    ...present("rotatedAt", optionalTime(value.rotatedAt)),
    ...present("rotateBy", optionalTime(value.rotateBy)),
    ...present("rotateEveryDays", rotateEveryDays),
    ...present("expiresAt", optionalTime(value.expiresAt)),
    ...present("lastUsedAt", optionalTime(value.lastUsedAt)),
  };
}

function decodeTrashed(value: unknown): TrashedSecret {
  if (!isDynamicRecord(value) || !isScope(value.scope) || !isName(value.name) || !isTime(value.deletedAt)) invalid();
  return {
    scope: value.scope,
    name: value.name,
    deletedAt: value.deletedAt,
    ...present("label", optionalText(value.label, SECRET_VAULT_LIMITS.label)),
    ...present("by", value.by === undefined ? undefined : decodeActor(value.by)),
  };
}

function decodeRequest(value: unknown): SecretRequest {
  if (!isDynamicRecord(value) || !isIdentifier(value.requestId) || !isIdentifier(value.agentId) || !isName(value.name))
    invalid();
  if (!isTime(value.createdAt)) invalid();
  const base = { requestId: value.requestId, agentId: value.agentId, name: value.name, createdAt: value.createdAt };
  if (value.kind === "fill" && typeof value.shared === "boolean")
    return { kind: "fill", ...base, shared: value.shared };
  if (value.kind === "approve" && isBoundedString(value.site, 2048))
    return { kind: "approve", ...base, site: value.site };
  return invalid();
}

function decodeVersion(item: unknown): SecretVersion {
  if (!isDynamicRecord(item) || !integerInRange(item.version, 1, 1_000_000) || !isTime(item.createdAt)) invalid();
  if (typeof item.current !== "boolean") invalid();
  return {
    version: item.version,
    createdAt: item.createdAt,
    current: item.current,
    ...present("by", item.by === undefined ? undefined : decodeActor(item.by)),
  };
}

function decodeAuditRow(item: unknown): SecretAuditRow {
  if (!isDynamicRecord(item) || !isTime(item.at) || !isAuditAction(item.action)) invalid();
  return {
    at: item.at,
    action: item.action,
    actor: decodeActor(item.actor),
    ...present("detail", optionalText(item.detail, SECRET_VAULT_LIMITS.detail)),
  };
}

function list<T>(value: unknown, maximum: number, decode: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value.map(decode);
}

const isCount = (value: unknown): value is number => integerInRange(value, 0, 1_000_000);

export function decodeSecretVaultResult(value: unknown): SecretVaultResult {
  if (!isDynamicRecord(value) || !isString(value.kind)) invalid();
  switch (value.kind) {
    case "overview":
      return {
        kind: "overview",
        secrets: list(value.secrets, SECRET_VAULT_LIMITS.secrets, decodeSummary),
        trash: list(value.trash, SECRET_VAULT_LIMITS.trash, decodeTrashed),
        requests: list(value.requests, SECRET_VAULT_LIMITS.requests, decodeRequest),
      };
    case "detail": {
      const detail = value.detail;
      if (!isDynamicRecord(detail)) invalid();
      return {
        kind: "detail",
        detail: {
          secret: decodeSummary(detail.secret),
          versions: list(detail.versions, SECRET_VAULT_LIMITS.versions + 1, decodeVersion),
          audit: list(detail.audit, SECRET_VAULT_LIMITS.audit, decodeAuditRow),
        },
      };
    }
    case "value":
      if (!isString(value.value)) invalid();
      return { kind: "value", value: value.value };
    case "bundle":
      if (!isBoundedString(value.bundle, SECRET_VAULT_LIMITS.bundle) || !isCount(value.count)) invalid();
      return { kind: "bundle", bundle: value.bundle, count: value.count };
    case "imported":
      if (!isCount(value.added) || !isCount(value.updated) || !isCount(value.unchanged)) invalid();
      return { kind: "imported", added: value.added, updated: value.updated, unchanged: value.unchanged };
    case "done":
      return { kind: "done" };
    default:
      return invalid();
  }
}
