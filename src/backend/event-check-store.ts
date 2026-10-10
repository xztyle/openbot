import { randomUUID } from "node:crypto";
import {
  decodeEventCheck,
  decodeEventCheckExecution,
  EVENT_CHECK_HISTORY_LIMIT,
  EVENT_CHECK_OPTION_LABEL_MAX_ENTRIES,
  type EventCheck,
  type EventCheckExecution,
  type EventCheckHealth,
  type EventCheckInput,
} from "@openbot/contracts/event-checks";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { decodeTeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { nextEventCheckOccurrence } from "@openbot/team-client/event-check-schedule";
import { withDatabaseTransaction } from "./database-transaction";
import type { EventCheckData } from "./event-check-reader";
import type { CheckBaseline, CheckObservation } from "./event-check-result";
import { eventCheckPrompt } from "./event-check-result";
import type { OpenBotDatabase } from "./openbot-database";

/** A check that fails again and again waits longer between runs: twice as long for each error in a row. */
const EVENT_CHECK_BACKOFF_CEILING_MS = 15 * 60_000;
/** The longest wait is also bounded by this many intervals, so a long interval is never stretched much. */
const EVENT_CHECK_BACKOFF_MAX_INTERVALS = 16;
/** Executions in a row that end in an error before the host tells the user once. */
export const EVENT_CHECK_FAILURE_NOTICE_STREAK = 5;

export interface CheckOutbox {
  id: string;
  checkId: string;
  revision: string;
  executionId: string;
  items: EventCheckData[];
  text: string;
  /** When the execution queued the event. Not part of the stored payload. */
  createdAt?: string;
}
/** The wait before the next run, from the normal wait and the errors in a row. Never shorter than the normal wait. */
export function eventCheckBackoffMs(normalMs: number, consecutiveErrors: number): number {
  if (consecutiveErrors <= 0 || normalMs <= 0) return normalMs;
  const ceiling = Math.max(
    normalMs,
    Math.min(EVENT_CHECK_BACKOFF_CEILING_MS, normalMs * EVENT_CHECK_BACKOFF_MAX_INTERVALS),
  );
  return Math.min(ceiling, normalMs * 2 ** Math.min(consecutiveErrors, 20));
}
function jsonColumn(value: unknown, column: string): EventCheckData {
  if (!isDynamicRecord(value) || typeof value[column] !== "string") throw new Error("Invalid stored event check.");
  return decodeTeamProtocolV2Json(JSON.parse(value[column]));
}
function baseline(value: unknown): CheckBaseline | null {
  if (value === null) return null;
  if (!isDynamicRecord(value) || !isDynamicRecord(value.fingerprints)) throw new Error("Invalid check baseline.");
  if (Object.keys(value.fingerprints).length > 10000) throw new Error("Invalid check baseline.");
  const fingerprints: Record<string, string> = {};
  for (const [key, hash] of Object.entries(value.fingerprints)) {
    if (!/^[a-f0-9]{64}$/.test(key) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid check fingerprint.");
    fingerprints[key] = hash;
  }
  return { fingerprints };
}
/** The IDs that a setting value names: the part of each comma-separated entry before its colon. */
function valueIds(value: string): Set<string> {
  return new Set(value.split(",").map((part) => (part.split(":")[0] ?? "").trim()));
}
/**
 * The names of the choices that a save keeps. A save that carries names for some choices wins for
 * them, the names that the check already had stay for the others (an older client or an agent tool
 * carries none), and a name for an ID that the value no longer holds is dropped.
 */
function retainOptionLabels(input: EventCheckInput, previous: EventCheck | null): EventCheckInput {
  if (input.source.kind !== "api") return input;
  const held = new Map(
    previous?.source.kind === "api" ? previous.source.configuration.map((field) => [field.name, field]) : [],
  );
  const configuration = input.source.configuration.map((field) => {
    const { optionLabels: _sent, ...rest } = field;
    const ids = valueIds(field.value);
    const merged = { ...held.get(field.name)?.optionLabels, ...field.optionLabels };
    const kept = Object.entries(merged)
      .filter(([id]) => ids.has(id))
      .slice(0, EVENT_CHECK_OPTION_LABEL_MAX_ENTRIES);
    return kept.length > 0 ? { ...rest, optionLabels: Object.fromEntries(kept) } : rest;
  });
  return { ...input, source: { ...input.source, configuration } };
}
/** The source as the check reads it: a template link and the names of choices are not part of it. */
function readsSource(source: EventCheckInput["source"]): EventCheckInput["source"] {
  if (source.kind !== "api") return source;
  const { template: _link, ...rest } = source;
  return { ...rest, configuration: source.configuration.map(({ optionLabels: _names, ...field }) => field) };
}
/** Owns bounded check state and atomic observation/outbox writes; never imports the service. */
export class EventCheckStore {
  constructor(readonly database: OpenBotDatabase) {}
  list(agentId?: string): EventCheck[] {
    const rows =
      agentId === undefined
        ? this.database.connection
            .prepare("SELECT definition_json FROM projection_event_checks ORDER BY check_id")
            .all()
        : this.database.connection
            .prepare("SELECT definition_json FROM projection_event_checks WHERE agent_id = ? ORDER BY check_id")
            .all(agentId);
    return rows.map((row) => decodeEventCheck(jsonColumn(row, "definition_json")));
  }
  get(agentId: string, id: string): EventCheck {
    const row = this.database.connection
      .prepare("SELECT definition_json FROM projection_event_checks WHERE agent_id = ? AND check_id = ?")
      .get(agentId, id);
    return decodeEventCheck(jsonColumn(row, "definition_json"));
  }
  current(id: string, revision: string): EventCheck | null {
    const row = this.database.connection
      .prepare("SELECT definition_json FROM projection_event_checks WHERE check_id = ? AND revision = ?")
      .get(id, revision);
    return row ? decodeEventCheck(jsonColumn(row, "definition_json")) : null;
  }
  save(input: EventCheckInput, now: Date, forceReset = false): EventCheck {
    const previous = input.id ? this.get(input.agentId, input.id) : null;
    if (!previous && this.list().length >= 100) throw new Error("Too many event checks.");
    // A list answer carries `health`. It is never saved with the definition.
    const definition: EventCheckInput = retainOptionLabels({ ...input }, previous);
    Reflect.deleteProperty(definition, "health");
    const delivery = input.delivery ?? previous?.delivery;
    const check: EventCheck = {
      ...definition,
      ...(delivery ? { delivery } : {}),
      id: previous?.id ?? randomUUID(),
      revision: randomUUID(),
      nextCheckAt: nextEventCheckOccurrence(input.schedule, input.timezone, now).toISOString(),
      createdAt: previous?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    // A template link says where a check came from, and the names of choices only help a person read
    // the settings. Neither changes what the check reads, so neither resets the baseline.
    const reads = (check: EventCheckInput) => [readsSource(check.source), check.selection, check.selfEvents];
    const reset = forceReset || !previous || JSON.stringify(reads(previous)) !== JSON.stringify(reads(input));
    return withDatabaseTransaction(this.database, () => {
      const db = this.database.connection;
      db.prepare(`INSERT INTO projection_event_checks (check_id, agent_id, definition_json, active, next_check_at, revision)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(check_id) DO UPDATE SET definition_json=excluded.definition_json,
        active=excluded.active, next_check_at=excluded.next_check_at, revision=excluded.revision,
        baseline_json=CASE WHEN ? THEN NULL ELSE baseline_json END,
        last_success_at=CASE WHEN ? THEN NULL ELSE last_success_at END`).run(
        check.id,
        check.agentId,
        JSON.stringify(check),
        Number(check.active),
        check.nextCheckAt,
        check.revision,
        Number(reset),
        Number(reset),
      );
      if (reset)
        db.prepare("DELETE FROM projection_event_check_outbox WHERE check_id = ? AND delivery_id IS NULL").run(
          check.id,
        );
      else
        db.prepare(
          "UPDATE projection_event_check_outbox SET revision = ?, payload_json = json_set(payload_json, '$.revision', ?) WHERE check_id = ?",
        ).run(check.revision, check.revision, check.id);
      return check;
    });
  }
  remove(agentId: string, id: string): void {
    this.get(agentId, id);
    withDatabaseTransaction(this.database, () => {
      const db = this.database.connection;
      db.prepare("DELETE FROM projection_event_checks WHERE check_id = ? AND agent_id = ?").run(id, agentId);
    });
  }
  state(id: string): { baseline: CheckBaseline | null; lastSuccessAt: string | null } {
    const row = this.database.connection
      .prepare("SELECT baseline_json, last_success_at FROM projection_event_checks WHERE check_id = ?")
      .get(id);
    if (!isDynamicRecord(row)) throw new Error("Unknown event check.");
    return {
      baseline: row.baseline_json === null ? null : baseline(jsonColumn(row, "baseline_json")),
      lastSuccessAt: typeof row.last_success_at === "string" ? row.last_success_at : null,
    };
  }
  nextDueAt(): string | null {
    const row = this.database.connection
      .prepare("SELECT MIN(next_check_at) AS next FROM projection_event_checks WHERE active = 1")
      .get();
    return isDynamicRecord(row) && typeof row.next === "string" ? row.next : null;
  }
  /** Executions that ended in an error since the last success, among the stored history. A cancelled run does not count or end the streak. */
  consecutiveErrors(checkId: string): number {
    let errors = 0;
    for (const row of this.#recentExecutions(checkId)) {
      if (row.status === "cancelled") continue;
      if (row.status !== "error") break;
      errors++;
    }
    return errors;
  }
  health(checkId: string): EventCheckHealth {
    const [newest] = this.#recentExecutions(checkId).filter((row) => row.status !== "cancelled");
    return {
      consecutiveErrors: this.consecutiveErrors(checkId),
      lastError: newest?.status === "error" ? newest.error : null,
      lastStatus: newest?.status ?? null,
      lastCheckedAt: newest?.finishedAt ?? null,
    };
  }
  #recentExecutions(checkId: string): EventCheckExecution[] {
    return this.database.connection
      .prepare(
        "SELECT result_json FROM projection_event_check_executions WHERE check_id = ? ORDER BY started_at DESC, execution_id DESC LIMIT ?",
      )
      .all(checkId, EVENT_CHECK_HISTORY_LIMIT)
      .map((row) => decodeEventCheckExecution(jsonColumn(row, "result_json")));
  }
  advance(check: EventCheck, now: Date): void {
    const normal = nextEventCheckOccurrence(check.schedule, check.timezone, now);
    const wait = eventCheckBackoffMs(normal.getTime() - now.getTime(), this.consecutiveErrors(check.id));
    const next = new Date(Math.max(normal.getTime(), now.getTime() + wait)).toISOString();
    this.database.connection
      .prepare(
        "UPDATE projection_event_checks SET next_check_at = ?, definition_json = json_set(definition_json, '$.nextCheckAt', ?) WHERE check_id = ? AND revision = ?",
      )
      .run(next, next, check.id, check.revision);
  }
  history(agentId: string, id: string): EventCheckExecution[] {
    this.get(agentId, id);
    return this.#recentExecutions(id);
  }
  finish(check: EventCheck, execution: EventCheckExecution, observation?: CheckObservation): void {
    withDatabaseTransaction(this.database, () => {
      const hadErrors = this.consecutiveErrors(check.id) > 0;
      const db = this.database.connection;
      if (
        !db
          .prepare("SELECT 1 FROM projection_event_checks WHERE check_id = ? AND agent_id = ?")
          .get(check.id, check.agentId)
      )
        return;
      const current = this.current(check.id, check.revision);
      const record: EventCheckExecution = current
        ? execution
        : { ...execution, status: "cancelled", eventCount: 0, error: null };
      db.prepare("INSERT INTO projection_event_check_executions VALUES (?, ?, ?, ?)").run(
        execution.id,
        check.id,
        execution.startedAt,
        JSON.stringify(record),
      );
      db.prepare(`DELETE FROM projection_event_check_executions WHERE check_id = ? AND execution_id NOT IN
        (SELECT execution_id FROM projection_event_check_executions WHERE check_id = ? ORDER BY started_at DESC, execution_id DESC LIMIT ?)`).run(
        check.id,
        check.id,
        EVENT_CHECK_HISTORY_LIMIT,
      );
      if (observation && current?.active) this.#commitObservation(check, record, observation);
      // A success ends the back-off at once, also after a person fixed the cause and ran the check by hand.
      if (current && hadErrors && record.status !== "error" && record.status !== "cancelled") this.#resetBackoff(check);
    });
  }
  #resetBackoff(check: EventCheck): void {
    const next = nextEventCheckOccurrence(check.schedule, check.timezone, new Date()).toISOString();
    this.database.connection
      .prepare(
        "UPDATE projection_event_checks SET next_check_at = ?, definition_json = json_set(definition_json, '$.nextCheckAt', ?) WHERE check_id = ? AND revision = ?",
      )
      .run(next, next, check.id, check.revision);
  }
  #commitObservation(check: EventCheck, execution: EventCheckExecution, observation: CheckObservation): void {
    const db = this.database.connection;
    db.prepare("UPDATE projection_event_checks SET baseline_json = ?, last_success_at = ? WHERE check_id = ?").run(
      JSON.stringify(observation.baseline),
      execution.finishedAt,
      check.id,
    );
    if (observation.changed.length === 0) return;
    const text = eventCheckPrompt(check, observation.changed);
    if (text.length > 100_000) throw new Error("Event batch too large.");
    const event: CheckOutbox = {
      id: `check-event:${execution.id}`,
      checkId: check.id,
      revision: check.revision,
      executionId: execution.id,
      items: observation.changed,
      text,
    };
    db.prepare("INSERT INTO projection_event_check_outbox VALUES (?, ?, ?, ?, ?, NULL)").run(
      event.id,
      check.id,
      check.revision,
      JSON.stringify(event),
      execution.finishedAt,
    );
  }
  pending(checkId?: string): CheckOutbox[] {
    return this.database.connection
      .prepare(
        "SELECT o.payload_json, o.created_at FROM projection_event_check_outbox o JOIN projection_event_checks c ON c.check_id = o.check_id AND c.revision = o.revision WHERE o.delivery_id IS NULL AND c.active = 1 AND (? IS NULL OR o.check_id = ?) ORDER BY o.created_at, o.event_id LIMIT 100",
      )
      .all(checkId ?? null, checkId ?? null)
      .map((row) => {
        const value = jsonColumn(row, "payload_json");
        if (
          !isDynamicRecord(value) ||
          typeof value.id !== "string" ||
          typeof value.checkId !== "string" ||
          typeof value.revision !== "string" ||
          typeof value.executionId !== "string" ||
          typeof value.text !== "string" ||
          !Array.isArray(value.items)
        )
          throw new Error("Invalid check outbox.");
        return {
          id: value.id,
          checkId: value.checkId,
          revision: value.revision,
          executionId: value.executionId,
          items: value.items.map(decodeTeamProtocolV2Json),
          text: value.text,
          ...(isDynamicRecord(row) && typeof row.created_at === "string" ? { createdAt: row.created_at } : {}),
        };
      });
  }
  deliveryError(execution: EventCheckExecution, error: string): EventCheckExecution {
    const updated = { ...execution, error };
    this.database.connection
      .prepare("UPDATE projection_event_check_executions SET result_json = ? WHERE execution_id = ?")
      .run(JSON.stringify(updated), execution.id);
    return updated;
  }
  delivered(event: CheckOutbox, deliveryId: string): void {
    this.database.connection.prepare("DELETE FROM projection_event_check_outbox WHERE event_id = ?").run(event.id);
    // The mailbox retains the idempotency key. A crash before this deletion reuses that delivery.
    void deliveryId;
  }
}
