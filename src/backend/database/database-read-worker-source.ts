import { Worker } from "node:worker_threads";
import type { DatabaseReadWorkerData } from "./database-read-protocol";
import type { DatabaseReadWorkerHandle } from "./database-reader";

/**
 * Starts a database read worker from its TypeScript source, for a test or a script that runs the
 * sources (Node with `tsx`, or Bun). The app starts its bundled entry instead
 * (`src/main/database-read-worker-process.ts`).
 */
export function spawnSourceDatabaseReadWorker(data: DatabaseReadWorkerData): DatabaseReadWorkerHandle {
  return new Worker(new URL("./database-read-worker.ts", import.meta.url), {
    workerData: data,
    name: "OpenBot database reads",
    // Bun runs TypeScript itself; Node needs the loader in the worker too.
    ...("bun" in process.versions ? {} : { execArgv: ["--import", "tsx"] }),
  });
}
