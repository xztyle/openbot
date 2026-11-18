// Optional message search wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - `POST /v1/workspace/search` `{ query (500), channelIds? (100), authorIds? (50), after?, before?
//   (80, ISO times), threadsOnly?, spaceId?, sort?: "relevance" | "recent", cursor? (32, digits),
//   limit? (1 to 50, default 20) }` answers `{ hits, total, nextCursor }`: the messages of the
//   channels, groups and DMs that the member of the session can see, thread replies too, whose words
//   match. In `query`, a word finds the words that start with it, also without accents; `"two words"`
//   finds the phrase; `-word` leaves out the messages that have it. `hits` (at most 50) are each
//   `{ channelId, messageId, sequence, threadRootId?, author: { kind: "member" | "agent" |
//   "coordinator" | "external", id, name (120) }, at (80), snippet (300), highlights (at most 20, each
//   `{ start, length }` in `snippet`), spaceId? }`. `nextCursor` is null after the last page.
//   A message of an agent hidden from the peer is not found. Deleted messages, the frames of a
//   streaming answer, steps, notes and routing events are not found either.
//
// A fork host built before this route answers 404; a client then searches the channel names only, as
// before. A present malformed value fails closed. The bounds are written out: this file must not move
// with an IPC limit.
import {
  adminRoute,
  boolean,
  count,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const WORKSPACE_SEARCH_CAPABILITY = FORK_HOST_CAPABILITY;

export const WORKSPACE_SEARCH_ROUTES = {
  search: "/v1/workspace/search",
} as const;

const request = fields(
  { query: string(500) },
  {
    channelIds: list(identifier, 100),
    authorIds: list(identifier, 50),
    after: string(80),
    before: string(80),
    threadsOnly: boolean,
    spaceId: identifier,
    sort: oneOf("relevance", "recent"),
    cursor: string(32),
    limit: count,
  },
);

const hit = fields(
  {
    channelId: identifier,
    messageId: identifier,
    sequence: count,
    author: fields({ kind: oneOf("member", "agent", "coordinator", "external"), id: identifier, name: string(120) }),
    at: string(80),
    snippet: string(300),
    highlights: list(fields({ start: count, length: count }), 20),
  },
  { threadRootId: identifier, spaceId: identifier },
);

export const WORKSPACE_SEARCH_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    WORKSPACE_SEARCH_ROUTES.search,
    adminRoute(request, fields({ hits: list(hit, 50), total: count, nextCursor: nullable(string(32)) })),
  ],
]);
