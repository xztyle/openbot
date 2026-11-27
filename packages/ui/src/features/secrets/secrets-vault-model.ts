import {
  type SecretHealth,
  type SecretKind,
  type SecretSummary,
  secretHealth,
  secretScopeKind,
  secretUnused,
} from "@openbot/contracts/ipc";

export type SecretScopeFilter = "all" | "shared" | "space" | "agent";
export type SecretStatusFilter = "any" | "attention" | "unused" | "never-rotated";
export type SecretGrouping = "scope" | "folder" | "type";

export interface SecretFilters {
  query: string;
  scope: SecretScopeFilter;
  status: SecretStatusFilter;
  /** The folder path the list is in: its keys and its subfolders'. Empty for every key. */
  folder: string;
  tag: string | null;
}

export const EMPTY_FILTERS: SecretFilters = { query: "", scope: "all", status: "any", folder: "", tag: null };

export function filtersActive(filters: SecretFilters): boolean {
  return (
    filters.query.trim() !== "" ||
    filters.scope !== "all" ||
    filters.status !== "any" ||
    filters.folder !== "" ||
    filters.tag !== null
  );
}

/** Whether a key sits in `folder` or one of its subfolders. */
export function inFolder(secret: Pick<SecretSummary, "folder">, folder: string): boolean {
  if (!folder) return true;
  const own = secret.folder ?? "";
  return own === folder || own.startsWith(`${folder}/`);
}

/** The folders right under `folder`, with how many keys each holds, by name. */
export function subfolders(
  secrets: readonly SecretSummary[],
  folder: string,
): { path: string; name: string; count: number }[] {
  const counts = new Map<string, number>();
  const prefix = folder ? `${folder}/` : "";
  for (const secret of secrets) {
    const own = secret.folder ?? "";
    if (!own.startsWith(prefix) || own === folder) continue;
    const name = own.slice(prefix.length).split("/")[0];
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ path: `${prefix}${name}`, name, count }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Every folder path in use, its parents included. */
export function knownFolders(secrets: readonly SecretSummary[]): string[] {
  const paths = new Set<string>();
  for (const secret of secrets) {
    const parts = (secret.folder ?? "").split("/").filter(Boolean);
    for (let index = 1; index <= parts.length; index += 1) paths.add(parts.slice(0, index).join("/"));
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

/** The tags in use, the most used first. */
export function tagCounts(secrets: readonly SecretSummary[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const secret of secrets) for (const tag of secret.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
}

export function needsAttention(health: SecretHealth): boolean {
  return health === "expired" || health === "expiring" || health === "rotate-due" || health === "rotate-soon";
}

export interface SecretStats {
  total: number;
  attention: number;
  unused: number;
  neverRotated: number;
}

export function secretStats(secrets: readonly SecretSummary[], now: number): SecretStats {
  let attention = 0;
  let unused = 0;
  let neverRotated = 0;
  for (const secret of secrets) {
    if (needsAttention(secretHealth(secret, now))) attention += 1;
    if (secretUnused(secret, now)) unused += 1;
    if (secret.rotatedAt === undefined) neverRotated += 1;
  }
  return { total: secrets.length, attention, unused, neverRotated };
}

/** The text a search matches: the names, the folder, the tags, the note and who uses it. */
export function matchesSecret(secret: SecretSummary, filters: SecretFilters, scopeLabel: string, now: number): boolean {
  const kind = secretScopeKind(secret.scope);
  if (filters.scope !== "all" && filters.scope !== kind) return false;
  if (filters.status === "attention" && !needsAttention(secretHealth(secret, now))) return false;
  if (filters.status === "unused" && !secretUnused(secret, now)) return false;
  if (filters.status === "never-rotated" && secret.rotatedAt !== undefined) return false;
  if (!inFolder(secret, filters.folder)) return false;
  if (filters.tag !== null && !secret.tags.includes(filters.tag)) return false;
  const words = filters.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length) return true;
  const haystack = [
    secret.name,
    secret.label,
    secret.folder,
    secret.note,
    scopeLabel,
    ...secret.tags.map((tag) => `#${tag}`),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return words.every((word) => haystack.includes(word.replace(/^#/u, "")) || haystack.includes(word));
}

export interface SecretGroup {
  id: string;
  title: string;
  /** The scope of a group by scope, for its avatar. */
  scope?: string;
  secrets: SecretSummary[];
}

const TYPE_ORDER: readonly SecretKind[] = ["key", "password", "token", "code", "other"];

/**
 * The groups of the list, in a steady order: by scope (shared, the spaces, then each agent), by folder
 * (the path's text, no folder last), or by type.
 */
export function groupSecrets(
  secrets: readonly SecretSummary[],
  grouping: SecretGrouping,
  labels: { scope: (scope: string) => string; type: (type: SecretKind) => string; noFolder: string },
): SecretGroup[] {
  const groups = new Map<string, SecretGroup>();
  const add = (id: string, title: string, secret: SecretSummary, scope?: string) => {
    let group = groups.get(id);
    if (!group) {
      group = { id, title, secrets: [], ...(scope ? { scope } : {}) };
      groups.set(id, group);
    }
    group.secrets.push(secret);
  };
  for (const secret of secrets) {
    if (grouping === "scope") add(`scope:${secret.scope}`, labels.scope(secret.scope), secret, secret.scope);
    else if (grouping === "folder") add(`folder:${secret.folder ?? ""}`, secret.folder ?? labels.noFolder, secret);
    else add(`type:${secret.type}`, labels.type(secret.type), secret);
  }
  const list = [...groups.values()];
  for (const group of list) group.secrets.sort((left, right) => displayName(left).localeCompare(displayName(right)));
  const rank = (group: SecretGroup): string => {
    if (grouping === "scope") {
      const kind = secretScopeKind(group.scope ?? "");
      return `${kind === "shared" ? 0 : kind === "space" ? 1 : 2}${group.title.toLocaleLowerCase()}`;
    }
    if (grouping === "folder") return group.id === "folder:" ? "￿" : group.title.toLocaleLowerCase();
    return String(TYPE_ORDER.findIndex((type) => `type:${type}` === group.id));
  };
  return list.sort((left, right) => rank(left).localeCompare(rank(right)));
}

export function displayName(secret: Pick<SecretSummary, "label" | "name">): string {
  return secret.label || secret.name;
}

export type AgoUnit = "now" | "minutes" | "hours" | "days" | "months" | "years";

/** How long ago, in the largest whole unit. */
export function agoParts(at: number, now: number): { unit: AgoUnit; count: number } {
  const elapsed = Math.max(0, now - at);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return { unit: "now", count: 0 };
  if (minutes < 60) return { unit: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", count: hours };
  const days = Math.floor(hours / 24);
  if (days < 31) return { unit: "days", count: days };
  const months = Math.floor(days / 30.4);
  if (months < 12) return { unit: "months", count: months };
  return { unit: "years", count: Math.floor(days / 365) };
}

/** A date input's value (`YYYY-MM-DD`, local) for a time, and back: the end of that local day. */
export function dateInputValue(at: number | undefined): string {
  if (at === undefined) return "";
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dateInputTime(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 0, 0);
  const time = date.getTime();
  return Number.isFinite(time) && time > 0 ? time : null;
}

/** Tags typed with commas, trimmed, without repeats. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}
