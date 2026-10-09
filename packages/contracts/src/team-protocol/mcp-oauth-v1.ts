// Additive, admin-only remote sign-in. Codes travel towards the owning host session; tokens never
// travel back. The existing mcp-servers-v1 test remains noninteractive.

import { isDynamicRecord } from "../runtime-values";
import type { OptionalRouteCodec } from "./admin-wire";
import { adminRoute, count, empty, fields, identifier, nullable, oneOf, string, variant } from "./admin-wire";

export const MCP_OAUTH_CAPABILITY = "mcp-oauth-v1";
export const MCP_OAUTH_ROUTES = {
  start: "/v1/mcp-oauth/start",
  status: "/v1/mcp-oauth/status",
  complete: "/v1/mcp-oauth/complete",
  cancel: "/v1/mcp-oauth/cancel",
} as const;

export interface McpOAuthStart {
  attemptId: string;
  expiresAt: number;
}
export type McpOAuthStatus =
  | { kind: "waiting"; authorizationUrl: string | null; state: string | null; expiresAt: number }
  | { kind: "complete"; toolCount: number; error: string | null };

const startReply = fields({ attemptId: identifier, expiresAt: count });
const statusReply = variant({
  waiting: fields({
    kind: oneOf("waiting"),
    authorizationUrl: nullable(string(8192)),
    state: nullable(string(128)),
    expiresAt: count,
  }),
  complete: fields({ kind: oneOf("complete"), toolCount: count, error: nullable(string(2000)) }),
});
const byAttempt = fields({ attemptId: identifier });
export const MCP_OAUTH_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    MCP_OAUTH_ROUTES.start,
    adminRoute(fields({ url: string(2048), redirectUrl: string(2048), accountId: identifier }), startReply),
  ],
  [MCP_OAUTH_ROUTES.status, adminRoute(byAttempt, statusReply)],
  [
    MCP_OAUTH_ROUTES.complete,
    adminRoute(fields({ attemptId: identifier, state: identifier, code: string(4096) }), empty),
  ],
  [MCP_OAUTH_ROUTES.cancel, adminRoute(byAttempt, empty)],
]);

export function decodeMcpOAuthStart(value: unknown): McpOAuthStart {
  const parsed = startReply(value);
  if (!isDynamicRecord(parsed) || typeof parsed.attemptId !== "string" || typeof parsed.expiresAt !== "number")
    throw new Error("Invalid MCP sign-in start.");
  return { attemptId: parsed.attemptId, expiresAt: parsed.expiresAt };
}
export function decodeMcpOAuthStatus(value: unknown): McpOAuthStatus {
  const parsed = statusReply(value);
  if (!isDynamicRecord(parsed)) throw new Error("Invalid MCP sign-in status.");
  if (
    parsed.kind === "waiting" &&
    (typeof parsed.authorizationUrl === "string" || parsed.authorizationUrl === null) &&
    (typeof parsed.state === "string" || parsed.state === null) &&
    typeof parsed.expiresAt === "number"
  )
    return {
      kind: "waiting",
      authorizationUrl: parsed.authorizationUrl,
      state: parsed.state,
      expiresAt: parsed.expiresAt,
    };
  if (
    parsed.kind === "complete" &&
    typeof parsed.toolCount === "number" &&
    (typeof parsed.error === "string" || parsed.error === null)
  )
    return { kind: "complete", toolCount: parsed.toolCount, error: parsed.error };
  throw new Error("Invalid MCP sign-in status.");
}
