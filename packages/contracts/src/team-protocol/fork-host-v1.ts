/**
 * One capability string for the features that only this fork's host has: event check templates and
 * their optional delivery fields, the direct API check routes, chat app permissions and sign-in, the
 * security audit read route, and the extended text attachment types. They ship in the same build,
 * so a host that advertises the string has all of them.
 *
 * A released peer reads no capability from a header with more than 64 entries, and a released
 * client refuses a host that advertises more than 64. These features used seven entries, which put
 * the list over that limit. They share this one. The legacy `event-checks-v1` string stays separate,
 * because a client that has only that one is shown the older, MCP-only checks.
 *
 * A new fork-only feature uses this string too. It does not add an entry.
 */
export const FORK_HOST_CAPABILITY = "fork-host-v1";
