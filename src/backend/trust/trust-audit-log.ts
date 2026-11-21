import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isTrustAuditEntry,
  TRUST_AUDIT_TEXT_LIMITS,
  type TrustAuditEntry,
  type TrustAuditQuery,
  trustAuditMatches,
} from "@openbot/contracts/trust-control";
import { createOpenBotLogger, redactText, toLogValue } from "@openbot/logging";

const logger = createOpenBotLogger("trust-audit");

export type TrustAuditInput = Omit<TrustAuditEntry, "id" | "at"> & { at?: string };

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/u;

function bounded(value: string, limit: number): string {
  const clean = redactText(value.replace(/[\r\n]+/gu, " ").trim());
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function localDayStart(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/**
 * Owns the append-only trust audit trail: one JSON line per consequential action (a spend, a
 * publish, a send, a delete, a policy change, an approval or a decision, a secret fill, a sign-in),
 * in one file per month under `trust-audit/` in the user data folder, readable only by the user.
 * Nothing rewrites or deletes a line, and no file is ever rotated away: the record outlives every
 * conversation. Text goes through `redactText` before it is written.
 *
 * The spend sums for the budgets come from the same lines, so a budget and its evidence never
 * disagree.
 */
export class TrustAuditLog {
  readonly #directory: string;
  readonly #now: () => Date;
  /** Every spend line, oldest first, loaded on first use. */
  #spend: TrustAuditEntry[] | null = null;

  constructor(directory: string, now: () => Date = () => new Date()) {
    this.#directory = directory;
    this.#now = now;
  }

  record(input: TrustAuditInput): TrustAuditEntry {
    const at = input.at ?? this.#now().toISOString();
    const entry: TrustAuditEntry = {
      ...input,
      id: randomUUID(),
      at,
      action: bounded(input.action, TRUST_AUDIT_TEXT_LIMITS.action),
      summary: bounded(input.summary, TRUST_AUDIT_TEXT_LIMITS.summary),
      actor: {
        kind: input.actor.kind,
        ...(input.actor.id ? { id: input.actor.id } : {}),
        ...(input.actor.name ? { name: bounded(input.actor.name, TRUST_AUDIT_TEXT_LIMITS.name) } : {}),
      },
      ...(input.ticket ? { ticket: bounded(input.ticket, TRUST_AUDIT_TEXT_LIMITS.ticket) } : {}),
      ...(input.answeredBy ? { answeredBy: bounded(input.answeredBy, TRUST_AUDIT_TEXT_LIMITS.name) } : {}),
    };
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      const file = join(this.#directory, `${at.slice(0, 7)}.jsonl`);
      const created = !existsSync(file);
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      if (created) chmodSync(file, 0o600);
    } catch (error) {
      logger.warn("Unable to write a trust audit line", { error: toLogValue(error) });
    }
    if (entry.category === "spend" && entry.amount !== undefined && this.#spend) this.#spend.push(entry);
    return entry;
  }

  #files(): string[] {
    try {
      return readdirSync(this.#directory)
        .filter((name) => MONTH_FILE.test(name))
        .sort();
    } catch {
      return [];
    }
  }

  #read(file: string): TrustAuditEntry[] {
    try {
      return readFileSync(join(this.#directory, file), "utf8")
        .split("\n")
        .flatMap((line) => {
          if (!line.trim()) return [];
          try {
            const value = JSON.parse(line);
            return isTrustAuditEntry(value) ? [value] : [];
          } catch {
            // A torn last line after a crash is skipped, never repaired.
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  /** The newest entries that match, newest first. */
  query(query: TrustAuditQuery): TrustAuditEntry[] {
    const limit = query.limit ?? 200;
    const rows: TrustAuditEntry[] = [];
    for (const file of this.#files().reverse()) {
      // A month that ends before `since` holds nothing newer.
      if (query.since && `${file.slice(0, 7)}-31T23:59:59.999Z` < query.since) break;
      if (query.before && `${file.slice(0, 7)}` > query.before.slice(0, 7)) continue;
      const entries = this.#read(file);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry && trustAuditMatches(entry, query)) rows.push(entry);
        if (rows.length >= limit) return rows;
      }
    }
    return rows;
  }

  #spendEntries(): TrustAuditEntry[] {
    if (!this.#spend)
      this.#spend = this.#files().flatMap((file) =>
        this.#read(file).filter((entry) => entry.category === "spend" && entry.amount !== undefined),
      );
    return this.#spend;
  }

  /**
   * The money that counted spend lines (allowed or approved) add up to, today (from local midnight)
   * and in total, for the lines that `covers` accepts.
   */
  spent(covers: (entry: TrustAuditEntry) => boolean): { today: number; total: number } {
    const dayStart = localDayStart(this.#now());
    let today = 0;
    let total = 0;
    for (const entry of this.#spendEntries()) {
      if ((entry.outcome !== "allowed" && entry.outcome !== "approved") || !covers(entry)) continue;
      const amount = entry.amount ?? 0;
      total += amount;
      if (entry.at >= dayStart) today += amount;
    }
    return { today, total };
  }

  /** Every counted spend line, for the totals of the settings page. */
  spendLines(): readonly TrustAuditEntry[] {
    return this.#spendEntries().filter((entry) => entry.outcome === "allowed" || entry.outcome === "approved");
  }

  get todayStart(): string {
    return localDayStart(this.#now());
  }
}
