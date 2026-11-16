import { Worker } from "node:worker_threads";
import type { DatabaseReadWorkerData } from "../backend/database/database-read-protocol";
import type { DatabaseReadWorkerHandle } from "../backend/database/database-reader";

/**
 * Starts the app's database read worker (`database-read-worker.ts`, with the Team API page encoding)
 * from its TypeScript source, for a script that runs the sources (Node with `tsx`, or Bun). The app
 * starts the bundled entry (`database-read-worker-process.ts`).
 */
export function spawnSourceAppReadWorker(data: DatabaseReadWorkerData): DatabaseReadWorkerHandle {
  return new Worker(new URL("./database-read-worker.ts", import.meta.url), {
    workerData: data,
    name: "OpenBot database reads",
    ...("bun" in process.versions ? {} : { execArgv: ["--import", "tsx"] }),
  });
}
