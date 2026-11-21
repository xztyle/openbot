import { randomUUID } from "node:crypto";
import {
  decodeLoopDecision,
  decodeLoopExperiment,
  LOOP_DECISION_STATUSES,
  LOOP_EVENT_KINDS,
  LOOP_EXPERIMENT_STATUSES,
  LOOP_LIMITS,
  type Loop,
  type LoopDecision,
  type LoopDefinition,
  type LoopEvent,
  type LoopExperiment,
  type LoopItem,
  type LoopValue,
  parseLoopDefinition,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";
import {
  databaseRows,
  objectValue,
  optionalNumberColumn,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../database/database-rows";
import { withDatabaseTransaction } from "../database-transaction";
import type { OpenBotDatabase } from "../openbot-database";

function loopRow(row: DynamicRecord): Loop {
  const templateId = optionalStringColumn(row, "template_id");
  return {
    ...parseLoopDefinition(JSON.parse(requiredStringColumn(row, "definition_json"))),
    id: requiredStringColumn(row, "loop_id"),
    spaceId: requiredStringColumn(row, "space_id"),
    ...(templateId ? { templateId } : {}),
    createdAt: requiredNumberColumn(row, "created_at"),
    updatedAt: requiredNumberColumn(row, "updated_at"),
  };
}

function values(text: string): Record<string, LoopValue> {
  const parsed: DynamicRecord | null = objectValue(JSON.parse(text));
  if (!parsed) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, LoopValue] => typeof entry[1] === "string" || typeof entry[1] === "number",
    ),
  );
}

function checks(text: string): string[] {
  const parsed: readonly string[] | null = stringList(JSON.parse(text));
  return parsed ? [...parsed] : [];
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null;
}

function itemRow(row: DynamicRecord): LoopItem {
  const owner = optionalStringColumn(row, "owner_agent_id");
  const external = optionalStringColumn(row, "external_id");
  const pending = optionalStringColumn(row, "pending_decision_id");
  return {
    id: requiredStringColumn(row, "item_id"),
    loopId: requiredStringColumn(row, "loop_id"),
    title: requiredStringColumn(row, "title"),
    stageId: requiredStringColumn(row, "stage_id"),
    ...(owner ? { ownerAgentId: owner } : {}),
    values: values(requiredStringColumn(row, "values_json")),
    checks: checks(requiredStringColumn(row, "checks_json")),
    ...(external ? { externalId: external } : {}),
    ...(pending ? { pendingDecisionId: pending } : {}),
    enteredAt: requiredNumberColumn(row, "entered_at"),
    createdAt: requiredNumberColumn(row, "created_at"),
    updatedAt: requiredNumberColumn(row, "updated_at"),
  };
}

function eventRow(row: DynamicRecord): LoopEvent {
  const kind = requiredStringColumn(row, "kind");
  const actorKind = requiredStringColumn(row, "actor_kind");
  const optional = (key: string, column: string) => {
    const value = optionalStringColumn(row, column);
    return value ? { [key]: value } : {};
  };
  return {
    id: requiredStringColumn(row, "event_id"),
    loopId: requiredStringColumn(row, "loop_id"),
    itemId: requiredStringColumn(row, "item_id"),
    at: requiredNumberColumn(row, "at"),
    kind: isOneOf(LOOP_EVENT_KINDS, kind) ? kind : "note",
    actorKind: actorKind === "agent" || actorKind === "person" ? actorKind : "host",
    ...optional("actorId", "actor_id"),
    ...optional("from", "from_stage"),
    ...optional("to", "to_stage"),
    ...optional("text", "text"),
  };
}

function experimentRow(row: DynamicRecord): LoopExperiment {
  const stored = decodeLoopExperiment(JSON.parse(requiredStringColumn(row, "experiment_json")));
  const status = requiredStringColumn(row, "status");
  return { ...stored, status: isOneOf(LOOP_EXPERIMENT_STATUSES, status) ? status : stored.status };
}

function decisionRow(row: DynamicRecord): LoopDecision {
  const stored = decodeLoopDecision(JSON.parse(requiredStringColumn(row, "decision_json")));
  const status = requiredStringColumn(row, "status");
  return { ...stored, status: isOneOf(LOOP_DECISION_STATUSES, status) ? status : stored.status };
}

export type LoopEventInput = Omit<LoopEvent, "id" | "at"> & { at?: number };

/**
 * Owns the loop tables. It checks nothing about who asks or whether a move is allowed; `LoopService`
 * does. Each write runs in one transaction with the history row that records it.
 */
export class LoopStore {
  readonly #database: OpenBotDatabase;

  constructor(database: OpenBotDatabase) {
    this.#database = database;
  }

  get #db() {
    return this.#database.connection;
  }

  transaction<T>(work: () => T): T {
    return withDatabaseTransaction(this.#database, work);
  }

  loops(spaceId: string): Loop[] {
    return databaseRows(
      this.#db.prepare("SELECT * FROM loops WHERE space_id = ? ORDER BY created_at").all(spaceId),
    ).map(loopRow);
  }

  allLoops(): Loop[] {
    return databaseRows(this.#db.prepare("SELECT * FROM loops ORDER BY created_at").all()).map(loopRow);
  }

  loop(loopId: string): Loop | null {
    const [row] = databaseRows(this.#db.prepare("SELECT * FROM loops WHERE loop_id = ?").all(loopId));
    return row ? loopRow(row) : null;
  }

  createLoop(spaceId: string, definition: LoopDefinition, templateId?: string): Loop {
    const now = Date.now();
    const id = randomUUID();
    this.#db
      .prepare(
        "INSERT INTO loops (loop_id, space_id, template_id, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, spaceId, templateId ?? null, JSON.stringify(definition), now, now);
    const loop = this.loop(id);
    if (!loop) throw new Error("The loop was not saved.");
    return loop;
  }

  updateLoop(loopId: string, definition: LoopDefinition): void {
    this.#db
      .prepare("UPDATE loops SET definition_json = ?, updated_at = ? WHERE loop_id = ?")
      .run(JSON.stringify(definition), Date.now(), loopId);
  }

  deleteLoop(loopId: string): void {
    this.transaction(() => {
      // The foreign keys cascade only when the connection enforces them, so the rows go explicitly too.
      for (const table of ["loop_events", "loop_experiments", "loop_decisions", "loop_items"])
        this.#db.prepare(`DELETE FROM ${table} WHERE loop_id = ?`).run(loopId);
      this.#db.prepare("DELETE FROM loops WHERE loop_id = ?").run(loopId);
    });
  }

  items(loopIds: readonly string[]): LoopItem[] {
    if (loopIds.length === 0) return [];
    return databaseRows(
      this.#db
        .prepare(
          `SELECT * FROM loop_items WHERE loop_id IN (${loopIds.map(() => "?").join(", ")}) ORDER BY entered_at LIMIT ?`,
        )
        .all(...loopIds, LOOP_LIMITS.items),
    ).map(itemRow);
  }

  item(itemId: string): LoopItem | null {
    const [row] = databaseRows(this.#db.prepare("SELECT * FROM loop_items WHERE item_id = ?").all(itemId));
    return row ? itemRow(row) : null;
  }

  itemByExternalId(loopId: string, externalId: string): LoopItem | null {
    const [row] = databaseRows(
      this.#db.prepare("SELECT * FROM loop_items WHERE loop_id = ? AND external_id = ?").all(loopId, externalId),
    );
    return row ? itemRow(row) : null;
  }

  itemCount(loopId: string): number {
    const [row] = databaseRows(
      this.#db.prepare("SELECT COUNT(*) AS count FROM loop_items WHERE loop_id = ?").all(loopId),
    );
    return row ? requiredNumberColumn(row, "count") : 0;
  }

  insertItem(item: LoopItem): void {
    this.#db
      .prepare(
        `INSERT INTO loop_items (item_id, loop_id, title, stage_id, owner_agent_id, values_json, checks_json, external_id,
          pending_decision_id, entered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.loopId,
        item.title,
        item.stageId,
        item.ownerAgentId ?? null,
        JSON.stringify(item.values),
        JSON.stringify(item.checks),
        item.externalId ?? null,
        item.pendingDecisionId ?? null,
        item.enteredAt,
        item.createdAt,
        item.updatedAt,
      );
  }

  writeItem(item: LoopItem): void {
    this.#db
      .prepare(
        `UPDATE loop_items SET title = ?, stage_id = ?, owner_agent_id = ?, values_json = ?, checks_json = ?,
          pending_decision_id = ?, entered_at = ?, updated_at = ? WHERE item_id = ?`,
      )
      .run(
        item.title,
        item.stageId,
        item.ownerAgentId ?? null,
        JSON.stringify(item.values),
        JSON.stringify(item.checks),
        item.pendingDecisionId ?? null,
        item.enteredAt,
        item.updatedAt,
        item.id,
      );
  }

  removeItem(itemId: string): void {
    this.transaction(() => {
      this.#db.prepare("DELETE FROM loop_experiments WHERE item_id = ?").run(itemId);
      this.#db.prepare("DELETE FROM loop_decisions WHERE item_id = ? AND status = 'pending'").run(itemId);
      this.#db.prepare("DELETE FROM loop_items WHERE item_id = ?").run(itemId);
    });
  }

  addEvent(input: LoopEventInput): void {
    this.#db
      .prepare(
        `INSERT INTO loop_events (event_id, loop_id, item_id, at, kind, actor_kind, actor_id, from_stage, to_stage, text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.loopId,
        input.itemId,
        input.at ?? Date.now(),
        input.kind,
        input.actorKind,
        input.actorId ?? null,
        input.from ?? null,
        input.to ?? null,
        input.text?.slice(0, LOOP_LIMITS.text) ?? null,
      );
  }

  /** The newest events of the loops, newest first. */
  events(loopIds: readonly string[], limit: number = LOOP_LIMITS.events): LoopEvent[] {
    if (loopIds.length === 0) return [];
    return databaseRows(
      this.#db
        .prepare(
          `SELECT * FROM loop_events WHERE loop_id IN (${loopIds.map(() => "?").join(", ")}) ORDER BY at DESC LIMIT ?`,
        )
        .all(...loopIds, limit),
    ).map(eventRow);
  }

  itemEvents(itemId: string, limit = 100): LoopEvent[] {
    return databaseRows(
      this.#db.prepare("SELECT * FROM loop_events WHERE item_id = ? ORDER BY at DESC LIMIT ?").all(itemId, limit),
    ).map(eventRow);
  }

  experiments(loopIds: readonly string[]): LoopExperiment[] {
    if (loopIds.length === 0) return [];
    return databaseRows(
      this.#db
        .prepare(
          `SELECT * FROM loop_experiments WHERE loop_id IN (${loopIds.map(() => "?").join(", ")}) ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(...loopIds, LOOP_LIMITS.experiments),
    ).map(experimentRow);
  }

  experiment(experimentId: string): LoopExperiment | null {
    const [row] = databaseRows(
      this.#db.prepare("SELECT * FROM loop_experiments WHERE experiment_id = ?").all(experimentId),
    );
    return row ? experimentRow(row) : null;
  }

  writeExperiment(experiment: LoopExperiment): void {
    this.#db
      .prepare(
        `INSERT INTO loop_experiments (experiment_id, loop_id, item_id, experiment_json, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(experiment_id) DO UPDATE SET experiment_json = excluded.experiment_json, status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(
        experiment.id,
        experiment.loopId,
        experiment.itemId,
        JSON.stringify(experiment),
        experiment.status,
        experiment.updatedAt,
      );
  }

  /** The pending decisions of the space and the newest decided ones. */
  decisions(spaceId: string): LoopDecision[] {
    return databaseRows(
      this.#db
        .prepare(
          `SELECT * FROM loop_decisions WHERE space_id = ? ORDER BY status = 'pending' DESC, created_at DESC LIMIT ?`,
        )
        .all(spaceId, LOOP_LIMITS.decisions),
    ).map(decisionRow);
  }

  pendingDecisions(): LoopDecision[] {
    return databaseRows(
      this.#db
        .prepare("SELECT * FROM loop_decisions WHERE status = 'pending' ORDER BY created_at LIMIT ?")
        .all(LOOP_LIMITS.decisions),
    ).map(decisionRow);
  }

  decision(decisionId: string): LoopDecision | null {
    const [row] = databaseRows(this.#db.prepare("SELECT * FROM loop_decisions WHERE decision_id = ?").all(decisionId));
    return row ? decisionRow(row) : null;
  }

  writeDecision(decision: LoopDecision): void {
    this.#db
      .prepare(
        `INSERT INTO loop_decisions (decision_id, loop_id, space_id, item_id, decision_json, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(decision_id) DO UPDATE SET decision_json = excluded.decision_json, status = excluded.status`,
      )
      .run(
        decision.id,
        decision.loopId,
        decision.spaceId,
        decision.itemId,
        JSON.stringify(decision),
        decision.status,
        decision.createdAt,
      );
  }

  /** The spaces that hold a pending decision, for a count without reading each board. */
  pendingCount(spaceId: string): number {
    const [row] = databaseRows(
      this.#db
        .prepare("SELECT COUNT(*) AS count FROM loop_decisions WHERE space_id = ? AND status = 'pending'")
        .all(spaceId),
    );
    return row ? (optionalNumberColumn(row, "count") ?? 0) : 0;
  }
}
