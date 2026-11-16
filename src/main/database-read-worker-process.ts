// How the app starts a database read worker: a worker thread of the main process that runs the
// bundled `database-read-worker.js` (see `database-read-worker.ts` here). A worker
// thread loads its file from inside `app.asar`, as Electron 45 does for the main process, and has
// `node:sqlite`. It needs no process of its own: a worker that is stuck in SQLite is replaced, and
// the main thread does not wait for it.

import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { DatabaseReadWorkerData } from "../backend/database/database-read-protocol";
import type { DatabaseReadWorkerHandle } from "../backend/database/database-reader";

export function spawnDatabaseReadWorker(data: DatabaseReadWorkerData): DatabaseReadWorkerHandle {
  return new Worker(join(__dirname, "database-read-worker.js"), {
    workerData: data,
    name: "OpenBot database reads",
  });
}
