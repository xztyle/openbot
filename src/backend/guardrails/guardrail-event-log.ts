import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GUARDRAIL_TEXT_LIMIT,
  type GuardrailEvent,
  type GuardrailEventKind,
  isGuardrailEvent,
} from "@openbot/contracts/guardrails";
import { createOpenBotLogger, redactText, toLogValue } from "@openbot/logging";

const logger = createOpenBotLogger("guardrail-events");

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/u;
/** The newest events kept in memory for the view and the counts. */
const KEPT = 2_000;

export type GuardrailEventInput = Omit<GuardrailEvent, "id" | "at"> & { at?: string };

/** A `blocked-allowed` event marks the blocked action it allowed, in memory: the file only appends. */
function markAllowed(events: readonly GuardrailEvent[], event: GuardrailEvent): void {
  if (event.kind !== "blocked-allowed" || !event.ref) return;
  const blocked = events.find((candidate) => candidate.id === event.ref)?.blocked;
  if (blocked) blocked.allowedAt = event.at;
}

/**
 * Owns the append-only record of what the guardrails did: one JSON line per warning, pause, resume,
 * breaker, stuck nudge or stop, blocked injection and failover, in one file per month under
 * `guardrails/` in the user data folder, readable only by the user. Text goes through `redactText`
 * before it is written. The caught injections and the stuck stops of the KPIs are counted from it.
 */
export class GuardrailEventLog {
  readonly #directory: string;
  readonly #now: () => Date;
  #recent: GuardrailEvent[] | null = null;

  constructor(directory: string, now: () => Date = () => new Date()) {
    this.#directory = directory;
    this.#now = now;
  }

  record(input: GuardrailEventInput): GuardrailEvent {
    const line = redactText(input.summary.replace(/[\r\n]+/gu, " ").trim());
    const event: GuardrailEvent = {
      ...input,
      id: randomUUID(),
      at: input.at ?? this.#now().toISOString(),
      summary: line.length > GUARDRAIL_TEXT_LIMIT ? `${line.slice(0, GUARDRAIL_TEXT_LIMIT - 1)}…` : line,
    };
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      const file = join(this.#directory, `${event.at.slice(0, 7)}.jsonl`);
      const created = !existsSync(file);
      appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      if (created) chmodSync(file, 0o600);
    } catch (error) {
      logger.warn("Unable to write a guardrail event", { error: toLogValue(error) });
    }
    const recent = this.#load();
    recent.push(event);
    markAllowed(recent, event);
    if (recent.length > KEPT) recent.splice(0, recent.length - KEPT);
    return event;
  }

  /** The events of the last two month files, oldest first, read once. */
  #load(): GuardrailEvent[] {
    if (this.#recent) return this.#recent;
    let files: string[] = [];
    try {
      files = readdirSync(this.#directory)
        .filter((name) => MONTH_FILE.test(name))
        .sort()
        .slice(-2);
    } catch {
      // No event yet.
    }
    const events: GuardrailEvent[] = [];
    for (const file of files) {
      try {
        for (const line of readFileSync(join(this.#directory, file), "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const value = JSON.parse(line);
            if (isGuardrailEvent(value)) events.push(value);
          } catch {
            // A torn last line after a crash is skipped, never repaired.
          }
        }
      } catch {
        // An unreadable month leaves the others.
      }
    }
    this.#recent = events.slice(-KEPT);
    for (const event of this.#recent) markAllowed(this.#recent, event);
    return this.#recent;
  }

  /** One kept event by its id. */
  find(id: string): GuardrailEvent | undefined {
    return this.#load().find((event) => event.id === id);
  }

  /** The newest events, newest first. */
  newest(limit: number): GuardrailEvent[] {
    return this.#load().slice(-limit).reverse();
  }

  /** How many events of each kind happened since `since` (ISO). */
  counts(since: string): Partial<Record<GuardrailEventKind, number>> {
    const counts: Partial<Record<GuardrailEventKind, number>> = {};
    for (const event of this.#load()) if (event.at >= since) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    return counts;
  }
}
