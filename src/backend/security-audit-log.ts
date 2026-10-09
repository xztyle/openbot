import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { redactText } from "@openbot/logging";
import { Effect } from "effect";
import { plainName, type SecurityActor } from "./security-actor";

/** One line of the security audit file. It holds names and identifiers, never a value. */
export interface SecurityAuditEntry {
  at: string;
  actor: { kind: "user" | "member" | "agent" | "system"; id?: string; name?: string };
  /** For example `event-check.save` or `mcp-server.save`. */
  action: string;
  target: { kind: string; id?: string; agentId?: string; name?: string };
  /** The names of fields or variables that changed. Never their values. */
  names?: string[];
  /** Present only when OpenBot refused the change. */
  outcome?: "refused";
}
export type SecurityAuditInput = Omit<SecurityAuditEntry, "at">;

/** Where the services record a change. A service never reads the file, so it only needs this. */
export interface SecurityAuditSink {
  record(entry: SecurityAuditInput): Effect.Effect<void>;
}
export const NO_SECURITY_AUDIT: SecurityAuditSink = { record: () => Effect.void };

export function auditActor(actor: SecurityActor): SecurityAuditEntry["actor"] {
  if (actor.kind === "user") return { kind: "user" };
  if (actor.kind === "member") return { kind: "member", id: actor.memberId, name: plainName(actor.name) };
  return { kind: "agent", id: actor.agentId, name: plainName(actor.name) };
}

export const AUDIT_MAX_BYTES = 512 * 1024;
export const AUDIT_ROTATED_FILES = 4;
const MAX_NAMES = 50;
const MAX_TEXT = 200;

/** One line, bounded, with anything that looks like a credential removed. */
function clean(value: string): string {
  return redactText(plainName(value).slice(0, MAX_TEXT));
}
function normalized(entry: SecurityAuditInput, at: string): SecurityAuditEntry {
  const row: SecurityAuditEntry = {
    at,
    actor: {
      kind: entry.actor.kind,
      ...(entry.actor.id === undefined ? {} : { id: clean(entry.actor.id) }),
      ...(entry.actor.name === undefined ? {} : { name: clean(entry.actor.name) }),
    },
    action: clean(entry.action),
    target: {
      kind: clean(entry.target.kind),
      ...(entry.target.id === undefined ? {} : { id: clean(entry.target.id) }),
      ...(entry.target.agentId === undefined ? {} : { agentId: clean(entry.target.agentId) }),
      ...(entry.target.name === undefined ? {} : { name: clean(entry.target.name) }),
    },
    ...(entry.names === undefined ? {} : { names: entry.names.slice(0, MAX_NAMES).map(clean) }),
    ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
  };
  return row;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function actorKind(value: unknown): SecurityAuditEntry["actor"]["kind"] {
  return value === "user" || value === "member" || value === "agent" ? value : "system";
}
/** Reads one line back. A line that is not a complete row is skipped, never repaired. */
function parseRow(line: string): SecurityAuditEntry | null {
  try {
    const value = JSON.parse(line);
    if (!isDynamicRecord(value) || !isDynamicRecord(value.actor) || !isDynamicRecord(value.target)) return null;
    const at = text(value.at),
      action = text(value.action),
      kind = text(value.target.kind);
    if (at === undefined || action === undefined || kind === undefined) return null;
    const id = text(value.actor.id),
      name = text(value.actor.name),
      targetId = text(value.target.id),
      agentId = text(value.target.agentId),
      targetName = text(value.target.name);
    return {
      at,
      actor: {
        kind: actorKind(value.actor.kind),
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
      },
      action,
      target: {
        kind,
        ...(targetId === undefined ? {} : { id: targetId }),
        ...(agentId === undefined ? {} : { agentId }),
        ...(targetName === undefined ? {} : { name: targetName }),
      },
      ...(Array.isArray(value.names) ? { names: value.names.filter((entry) => typeof entry === "string") } : {}),
      ...(value.outcome === "refused" ? { outcome: "refused" as const } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * An append-only file of the changes that move trust: who saved, enabled or deleted an event check,
 * changed an app connection or auto-approve, or edited another agent. One JSON object a line, in the
 * user data folder, readable by the user only. When the file passes `maxBytes`, it becomes `.1`, the
 * older ones move up, and the oldest goes. A failed write never fails the change that it records.
 *
 * This is a record for the host's owner, not a boundary: an agent with full access to the same
 * computer can read the file, and could edit it. It is not a place for values of any kind.
 */
export class SecurityAuditLog implements SecurityAuditSink {
  constructor(
    readonly path: string,
    readonly options: {
      maxBytes?: number;
      rotatedFiles?: number;
      now?: () => Date;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  record(entry: SecurityAuditInput): Effect.Effect<void> {
    return Effect.sync(() => this.append(entry));
  }

  /** The newest rows first, at most `limit`, across the rotated files. */
  list(limit = 200): Effect.Effect<SecurityAuditEntry[]> {
    return Effect.sync(() => this.read(limit));
  }

  append(entry: SecurityAuditInput): void {
    try {
      const row = normalized(entry, (this.options.now?.() ?? new Date()).toISOString());
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      this.#rotateIfFull();
      appendFileSync(this.path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  read(limit: number): SecurityAuditEntry[] {
    const rows: SecurityAuditEntry[] = [];
    const count = this.options.rotatedFiles ?? AUDIT_ROTATED_FILES;
    const files = [this.path, ...Array.from({ length: count }, (_, index) => `${this.path}.${index + 1}`)];
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const parsed = content
        .split("\n")
        .map(parseRow)
        .filter((row): row is SecurityAuditEntry => row !== null);
      rows.push(...parsed.reverse());
      if (rows.length >= limit) break;
    }
    return rows.slice(0, Math.max(0, Math.min(limit, 1000)));
  }

  #rotateIfFull(): void {
    const maxBytes = this.options.maxBytes ?? AUDIT_MAX_BYTES;
    if (!existsSync(this.path) || statSync(this.path).size < maxBytes) return;
    const count = this.options.rotatedFiles ?? AUDIT_ROTATED_FILES;
    rmSync(`${this.path}.${count}`, { force: true });
    for (let index = count - 1; index >= 1; index--) {
      if (existsSync(`${this.path}.${index}`)) renameSync(`${this.path}.${index}`, `${this.path}.${index + 1}`);
    }
    renameSync(this.path, `${this.path}.1`);
  }
}
