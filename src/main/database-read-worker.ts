// The app's entry of a database read worker (see `src/backend/database/database-read-worker-runtime.ts`).
// Besides the reads of the backend entry, it encodes a chat page as the body of a Team API response
// with the same function that the main thread uses (`encodeTeamResponseBody`), so the page leaves the
// worker as the string that the response writes. Its imports are `node:*`, the read modules of the
// database and the Team API encoding, which import only the contracts.
import { runDatabaseReadWorker } from "../backend/database/database-read-worker-runtime";
import { encodeTeamResponseBody } from "./team-api/response-encoding";

runDatabaseReadWorker({
  encodePage: (route, page) =>
    encodeTeamResponseBody(
      {
        method: route.method,
        path: route.path,
        protocol: route.protocol,
        capabilities: new Set(route.capabilities),
        hiddenAgentIds: route.hiddenAgentIds === null ? null : new Set(route.hiddenAgentIds),
      },
      200,
      page,
    ),
});
