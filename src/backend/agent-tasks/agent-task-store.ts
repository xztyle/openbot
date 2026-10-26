import { randomUUID } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { AGENT_TASK_OUTCOMES, type AgentTaskOutcome } from "@openbot/contracts/ipc";
import { type DynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";
import { deleteAggregateHistory, deleteThreadAttachments } from "../database/database-core";
import { databaseRow, databaseRows, optionalStringColumn, requiredStringColumn } from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";

const AGENT_TASK_ORIGINS = ["user", "agent"] as const;
export type AgentTaskOrigin = (typeof AGENT_TASK_ORIGINS)[number];

/** A second conversation of one agent, with its own thread, next to the agent's own chat. */
export interface AgentTaskRecord {
  taskId: string;
  agentId: string;
  threadId: string;
  origin: AgentTaskOrigin;
  title: string;
  /** The end of the last turn. Null before the first turn ends. */
  outcome: AgentTaskOutcome | null;
  /** The redacted provider error of the last failed turn. A new turn clears it. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** A closed task takes no more messages. */
  closedAt: string | null;
}

export interface AgentTaskInput {
  agentId: string;
  origin: AgentTaskOrigin;
  title: string;
}

/**
 * Owns `projection_agent_tasks`. It never imports the database facade's callers.
 *
 * A task creates a row in `projection_threads`, so it goes through `dispatch`, as a messaging link
 * does. Its event payload holds ids only: the event log is append-only and must not keep the title.
 */
export class AgentTaskStore {
  readonly #database: OpenBotDatabase;

  constructor(database: OpenBotDatabase) {
    this.#database = database;
  }

  task(taskId: string): AgentTaskRecord | null {
    const row = databaseRow(
      this.#database.connection.prepare("SELECT * FROM projection_agent_tasks WHERE task_id = ?").get(taskId),
    );
    return row ? decodeTask(row) : null;
  }

  taskForThread(threadId: string): AgentTaskRecord | null {
    const row = databaseRow(
      this.#database.connection.prepare("SELECT * FROM projection_agent_tasks WHERE thread_id = ?").get(threadId),
    );
    return row ? decodeTask(row) : null;
  }

  /** The open tasks of this agent first, then the newest closed ones, up to `INPUT_LIMITS.agentTasks`. */
  list(agentId: string): AgentTaskRecord[] {
    return databaseRows(
      this.#database.connection
        .prepare(
          `SELECT * FROM projection_agent_tasks WHERE agent_id = ?
           ORDER BY closed_at IS NOT NULL, updated_at DESC, task_id LIMIT ?`,
        )
        .all(agentId, INPUT_LIMITS.agentTasks),
    ).map(decodeTask);
  }

  /** The agent id and thread id of every task, for boot recovery. */
  executionThreads(): Array<{ id: string; threadId: string }> {
    return databaseRows(
      this.#database.connection.prepare("SELECT agent_id, thread_id FROM projection_agent_tasks").all(),
    ).map((row) => ({ id: requiredStringColumn(row, "agent_id"), threadId: requiredStringColumn(row, "thread_id") }));
  }

  /** The open tasks of this agent, oldest first, so a task that waits longer starts first. */
  openTaskIds(agentId: string): string[] {
    return databaseRows(
      this.#database.connection
        .prepare(
          "SELECT task_id FROM projection_agent_tasks WHERE agent_id = ? AND closed_at IS NULL ORDER BY created_at, task_id",
        )
        .all(agentId),
    ).map((row) => requiredStringColumn(row, "task_id"));
  }

  taskIdsForAgent(agentId: string): string[] {
    return databaseRows(
      this.#database.connection.prepare("SELECT task_id FROM projection_agent_tasks WHERE agent_id = ?").all(agentId),
    ).map((row) => requiredStringColumn(row, "task_id"));
  }

  threadIdsForAgent(agentId: string): string[] {
    return databaseRows(
      this.#database.connection.prepare("SELECT thread_id FROM projection_agent_tasks WHERE agent_id = ?").all(agentId),
    ).map((row) => requiredStringColumn(row, "thread_id"));
  }

  /** Creates the task and its thread in one transaction. */
  create(input: AgentTaskInput): AgentTaskRecord {
    const taskId = `agent-task-${randomUUID()}`;
    const threadId = `openbot-thread-${randomUUID()}`;
    this.#database.dispatch(
      `agent-task:${taskId}`,
      [
        {
          aggregateType: "agent-task",
          aggregateId: taskId,
          eventType: "agent-task.created",
          payload: { agentId: input.agentId, threadId, origin: input.origin },
        },
      ],
      (db, sequences) => {
        const now = new Date().toISOString();
        const sequence = sequences[0] ?? 0;
        db.prepare("INSERT INTO projection_threads VALUES (?, ?, ?, NULL, ?, ?, ?)").run(
          threadId,
          input.agentId,
          input.title,
          now,
          now,
          sequence,
        );
        db.prepare(
          `INSERT INTO projection_agent_tasks
             (task_id, agent_id, thread_id, origin, title, outcome, created_at, updated_at, closed_at,
              last_event_sequence)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
        ).run(taskId, input.agentId, threadId, input.origin, input.title, now, now, sequence);
        return null;
      },
    );
    const created = this.task(taskId);
    if (!created) throw new Error("The task was not stored.");
    return created;
  }

  /** Records the end of the task's last turn. */
  setOutcome(taskId: string, outcome: AgentTaskOutcome): void {
    this.#database.connection
      .prepare("UPDATE projection_agent_tasks SET outcome = ?, updated_at = ? WHERE task_id = ?")
      .run(outcome, new Date().toISOString(), taskId);
  }

  /** Keeps the error of the task's last turn, or clears it when a turn starts. */
  setError(taskId: string, error: string | null): void {
    this.#database.connection
      .prepare("UPDATE projection_agent_tasks SET error = ? WHERE task_id = ?")
      .run(error, taskId);
  }

  /** Marks new activity, so the task lists first among its peers. */
  touch(taskId: string): void {
    this.#database.connection
      .prepare("UPDATE projection_agent_tasks SET updated_at = ? WHERE task_id = ?")
      .run(new Date().toISOString(), taskId);
  }

  close(taskId: string): void {
    const now = new Date().toISOString();
    this.#database.connection
      .prepare(
        "UPDATE projection_agent_tasks SET closed_at = ?, updated_at = ? WHERE task_id = ? AND closed_at IS NULL",
      )
      .run(now, now, taskId);
  }

  reopen(taskId: string): void {
    this.#database.connection
      .prepare("UPDATE projection_agent_tasks SET closed_at = NULL, updated_at = ? WHERE task_id = ?")
      .run(new Date().toISOString(), taskId);
  }

  /** Removes a task that never took a message, with its empty thread: a move into it was refused. */
  discard(taskId: string): void {
    const task = this.task(taskId);
    if (!task) return;
    this.#database.dispatch(
      `agent-task-discarded:${taskId}`,
      // Recorded on the agent: the task's own history goes below.
      [
        {
          aggregateType: "agent-tasks",
          aggregateId: task.agentId,
          eventType: "agent-task.discarded",
          payload: { threadIds: [task.threadId] },
        },
      ],
      (db) => {
        deleteAggregateHistory(db, "agent-task", [taskId]);
        deleteAggregateHistory(db, "thread", [task.threadId]);
        // The thread row takes the task row with it.
        db.prepare("DELETE FROM projection_threads WHERE thread_id = ?").run(task.threadId);
        return null;
      },
    );
  }

  /**
   * Removes every task of an agent, with the task threads and their history. The caller releases the
   * provider sessions of `threadIdsForAgent` first.
   */
  deleteForAgent(agentId: string): void {
    const tasks = databaseRows(
      this.#database.connection
        .prepare("SELECT task_id, thread_id FROM projection_agent_tasks WHERE agent_id = ?")
        .all(agentId),
    ).map((row) => ({
      taskId: requiredStringColumn(row, "task_id"),
      threadId: requiredStringColumn(row, "thread_id"),
    }));
    if (tasks.length === 0) return;
    this.#database.dispatch(
      `agent-tasks-deleted:${agentId}:${randomUUID()}`,
      [
        {
          aggregateType: "agent-tasks",
          aggregateId: agentId,
          eventType: "agent-task.agent-deleted",
          payload: { threadIds: tasks.map((task) => task.threadId) },
        },
      ],
      (db) => {
        deleteAggregateHistory(
          db,
          "agent-task",
          tasks.map((task) => task.taskId),
        );
        for (const { threadId } of tasks) {
          deleteAggregateHistory(db, "thread", [threadId]);
          deleteThreadAttachments(db, threadId);
        }
        // The thread rows take the task rows with them.
        for (const { threadId } of tasks)
          db.prepare("DELETE FROM projection_threads WHERE thread_id = ?").run(threadId);
        return null;
      },
    );
  }
}

function decodeTask(row: DynamicRecord): AgentTaskRecord {
  const origin = requiredStringColumn(row, "origin");
  const outcome = optionalStringColumn(row, "outcome");
  if (!isOneOf(AGENT_TASK_ORIGINS, origin)) throw new Error(`Unknown task origin: ${origin}`);
  if (outcome !== null && !isOneOf(AGENT_TASK_OUTCOMES, outcome)) throw new Error(`Unknown task outcome: ${outcome}`);
  return {
    taskId: requiredStringColumn(row, "task_id"),
    agentId: requiredStringColumn(row, "agent_id"),
    threadId: requiredStringColumn(row, "thread_id"),
    origin,
    title: requiredStringColumn(row, "title"),
    outcome,
    error: optionalStringColumn(row, "error"),
    createdAt: requiredStringColumn(row, "created_at"),
    updatedAt: requiredStringColumn(row, "updated_at"),
    closedAt: optionalStringColumn(row, "closed_at"),
  };
}
