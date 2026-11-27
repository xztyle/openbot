/**
 * One capability string for the features that only this fork's host has: event check templates and
 * their optional delivery fields, the direct API check routes, chat app permissions and sign-in, the
 * security audit read route, and the extended text attachment types. They ship in the same build,
 * so a host that advertises the string has all of them.
 *
 * The background teammate mark of `agent-background-v1.ts` came later and uses this string too. A
 * fork host built before it refuses an update that sets only that mark, so the client fails closed.
 * The `agent-input-escalations-changed` event of `input-escalations-v1.ts` came later too. A fork
 * host built before it sends no such event, so a client shows each request in its own chat only.
 * The `agent-attention-changed` event of `attention-items-v1.ts` came later too. A fork host built
 * before it sends no such event, so a client counts only the requests it has from other events.
 * The `connection.report` operation of `connection-report-v1.ts` came later too. A fork host built
 * before it answers with `unsupported_operation`, and the client ignores that answer.
 * The `agent-roster-changed` event of `agent-roster-v1.ts` came later too. A fork host built before
 * it sends `bots-changed`, which holds at most 100 agents.
 *
 * A released peer reads no capability from a header with more than 64 entries, and a released
 * client refuses a host that advertises more than 64. These features used seven entries, which put
 * the list over that limit. They share this one. The legacy `event-checks-v1` string stays separate,
 * because a client that has only that one is shown the older, MCP-only checks.
 *
 * A new fork-only feature uses this string too. It does not add an entry.
 */
export const FORK_HOST_CAPABILITY = "fork-host-v1";
