// Frozen optional security-audit-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: an owner or admin of a
// server can read the newest rows of the host's security audit file. Each row says when something
// happened, who did it (the user of the host, a team member, or an agent), what it did, and what it
// touched. A row holds names and identifiers, such as the name of a private variable, and never a
// value. A member cannot use the route; `requireAdmin` on the host is the only role gate. The host
// keeps a bounded file, so the newest 200 rows at most come back, newest first. Widening any of it
// needs a second capability string.

import { adminRoute, count, fields, list, type OptionalRouteCodec, oneOf, string } from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const SECURITY_AUDIT_CAPABILITY = FORK_HOST_CAPABILITY;
export const SECURITY_AUDIT_ROUTES = { list: "/v1/security-audit/list" } as const;
export const SECURITY_AUDIT_MAX_ROWS = 200;

const row = fields(
  {
    at: string(64),
    actor: fields({ kind: oneOf("user", "member", "agent", "system") }, { id: string(256), name: string(256) }),
    action: string(256),
    target: fields({ kind: string(256) }, { id: string(256), agentId: string(256), name: string(256) }),
  },
  { names: list(string(256), 50), outcome: oneOf("refused") },
);
export const SECURITY_AUDIT_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    SECURITY_AUDIT_ROUTES.list,
    adminRoute(fields({}, { limit: count }), fields({ rows: list(row, SECURITY_AUDIT_MAX_ROWS) })),
  ],
]);
