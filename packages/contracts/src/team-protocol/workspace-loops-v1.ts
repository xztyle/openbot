// Optional loops wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - `POST /v1/workspace/loops` `{ spaceId, decisionsOnly? }` answers `{ spaceId, loops, items, experiments, decisions,
//   events, templates }` for one space: every loop (50) with its definition, its items (2000), their
//   experiments (500), the decisions of the space (200, the pending ones first) and the newest history
//   rows (400). Any member may read it. With `decisionsOnly: true` it answers only the loops and the
//   pending decisions, with the other lists empty.
// - `POST /v1/workspace/loops/action` with an action answers the same board, with `createdId?` (a new
//   loop or item, or the decision that a gated move opened) and `blocked?` (40 reasons: the exit
//   criteria that do not hold). An action is one of `create-loop`, `update-loop`, `delete-loop`,
//   `save-item`, `remove-item`, `check`, `move-item`, `decide` and `update-experiment`, as
//   `ipc-workspace-loops.ts` writes them. Only an owner or an admin sends one; a refused action answers
//   409 with the reason.
//
// A loop definition crosses as `parseLoopDefinition` reads it: stage ids of `a-z 0-9 - _` (40), field
// keys of `a-z 0-9 _` (40), field values of text (2000) or numbers, times as epoch milliseconds. A
// fork host built before these routes answers 404; a client then offers no Loops view. A present
// malformed value fails closed. Widening any of it needs a second capability string.
import { decodeWorkspaceLoops, parseWorkspaceLoopAction, parseWorkspaceLoopsInput } from "../ipc-workspace-loops";
import { adminRoute, type OptionalRouteCodec } from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import { decodeTeamProtocolV2Json, type TeamProtocolV2Json } from "./v2";

export const WORKSPACE_LOOPS_CAPABILITY = FORK_HOST_CAPABILITY;

export const WORKSPACE_LOOPS_ROUTES = {
  board: "/v1/workspace/loops",
  action: "/v1/workspace/loops/action",
} as const;

/** The IPC parsers are the codec: each checks every bound, and the JSON it answers is the wire shape. */
function codec(request: (value: unknown) => object): (value: unknown) => TeamProtocolV2Json {
  return (value) => decodeTeamProtocolV2Json(request(value));
}

const board = codec(decodeWorkspaceLoops);

export const WORKSPACE_LOOPS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [WORKSPACE_LOOPS_ROUTES.board, adminRoute(codec(parseWorkspaceLoopsInput), board)],
  [WORKSPACE_LOOPS_ROUTES.action, adminRoute(codec(parseWorkspaceLoopAction), board)],
]);
