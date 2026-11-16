// The entry of a database read worker that answers the reads of `database-read-answers.ts`. Tests and
// scripts start it from the source (`database-read-worker-source.ts`). The app starts its own entry,
// `src/main/database-read-worker.ts`, which also encodes a chat page for a Team API response.
import { runDatabaseReadWorker } from "./database-read-worker-runtime";

runDatabaseReadWorker();
