// Optional all-queues read of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - `GET /v1/agents/queues` answers `{ queues }`: the queue snapshot of each agent that the member can
//   see, in the shape that `GET /v1/agents/<agentId>/queue` answers for the same client (the window of
//   `queue-window` when it was negotiated). At most 1,000 queues.
//
// A client read every agent's queue with its own request on each connect, 43 requests for 43 agents
// after every reconnect of every device, and the read of the open chat waited behind them. One request
// now brings them all. A fork host built before this route answers 404; the client then reads each
// queue as before. A present malformed value fails closed.
import { isQueueSnapshot } from "../ipc-queue";
import { isDynamicRecord } from "../runtime-values";
import { adminRoute, empty, type OptionalRouteCodec } from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import { decodeTeamProtocolV2Json } from "./v2";

export const AGENT_QUEUES_CAPABILITY = FORK_HOST_CAPABILITY;

export const AGENT_QUEUES_ROUTE = "/v1/agents/queues";

const AGENT_QUEUES_LIMIT = 1_000;

function queuesResponse(value: unknown) {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.queues) ||
    value.queues.length > AGENT_QUEUES_LIMIT ||
    !value.queues.every(isQueueSnapshot)
  )
    throw new Error("Invalid agent queues.");
  return decodeTeamProtocolV2Json({ queues: value.queues });
}

export const AGENT_QUEUES_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [AGENT_QUEUES_ROUTE, adminRoute(empty, queuesResponse)],
]);
