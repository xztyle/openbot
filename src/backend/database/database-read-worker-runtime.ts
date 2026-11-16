// The body of a database read worker: a worker thread of the main process that answers the heavy
// reads of `openbot.db` (conversation pages, unread states, search) on a connection of its own, so
// the main thread's event loop stays free while SQLite reads. An entry file calls
// `runDatabaseReadWorker`: `database-read-worker.ts` here, and the app's entry in `src/main`, which
// adds the Team API encoding of a page.
//
// SQLite in write-ahead-log mode lets readers run beside the one writer. The main connection stays
// the only writer: this connection is `query_only`, and every request reads in one read transaction
// that sees each transaction the main thread committed before it sent the request.
//
// Its runtime imports are `node:*` and the read modules of `database/`, which import only
// `@openbot/contracts`.

import { DatabaseSync } from "node:sqlite";
import { type MessagePort, parentPort, workerData } from "node:worker_threads";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { DatabaseReadAnswers, type PageEncoder } from "./database-read-answers";
import type {
  DatabaseReadWorkerData,
  DatabaseReadWorkerMessage,
  DatabaseReadWorkerReply,
} from "./database-read-protocol";
import { registerSqlFunctions } from "./sql-functions";
import { cacheStatements } from "./statement-cache";

function isWorkerData(value: unknown): value is DatabaseReadWorkerData {
  return isDynamicRecord(value) && isString(value.databasePath);
}

export interface DatabaseReadWorkerOptions {
  /** Encodes a page for a response; without it a page response is left to the main thread. */
  encodePage?: PageEncoder;
}

/** Answers the main thread's reads on this worker thread until the main thread closes it. */
export function runDatabaseReadWorker(options: DatabaseReadWorkerOptions = {}): void {
  if (!parentPort) throw new Error("The database read worker runs only as a worker thread.");
  const port: MessagePort = parentPort;
  if (!isWorkerData(workerData)) throw new Error("The database read worker needs the path of the database.");
  const { databasePath } = workerData;

  let connection: DatabaseSync | null = null;
  let answers: DatabaseReadAnswers | null = null;

  /** Opened at the first read: the main thread starts a worker only after the database is migrated. */
  function readAnswers(): DatabaseReadAnswers {
    if (answers) return answers;
    const db = new DatabaseSync(databasePath);
    // A writer's commit can hold the lock for a moment; a read waits for it as the main connection does.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA query_only = ON");
    registerSqlFunctions(db);
    cacheStatements(db);
    connection = db;
    answers = new DatabaseReadAnswers(db, options.encodePage ?? null);
    return answers;
  }

  function reply(message: DatabaseReadWorkerReply): void {
    port.postMessage(message);
  }

  port.on("message", (message: DatabaseReadWorkerMessage) => {
    if (message.type === "close") {
      try {
        connection?.close();
      } finally {
        connection = null;
        answers = null;
        Atomics.store(message.closed, 0, 1);
        Atomics.notify(message.closed, 0);
        port.close();
      }
      return;
    }
    try {
      reply(readAnswers().answer(message.id, message.request));
    } catch (error) {
      reply({ type: "failure", id: message.id, message: error instanceof Error ? error.message : String(error) });
    }
  });
}
