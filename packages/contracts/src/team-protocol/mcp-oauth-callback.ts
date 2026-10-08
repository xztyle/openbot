import { isDynamicRecord } from "../runtime-values";
export const MCP_OAUTH_CHANNEL_PREFIX = "openbot-mcp-oauth:";
export interface McpOAuthReturn {
  state: string;
  code: string;
  error: string;
}
export function isMcpOAuthReturn(value: unknown, state: string): value is McpOAuthReturn {
  if (!isDynamicRecord(value)) return false;
  const candidate = value;
  return (
    candidate.state === state &&
    typeof candidate.code === "string" &&
    candidate.code.length <= 4096 &&
    typeof candidate.error === "string" &&
    candidate.error.length <= 128
  );
}
