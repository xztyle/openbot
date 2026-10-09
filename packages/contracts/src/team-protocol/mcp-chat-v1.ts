import { isDynamicRecord } from "../runtime-values";
import { adminRoute, fields, identifier, list, type OptionalRouteCodec, oneOf, string } from "./admin-wire";

export const MCP_CHAT_CAPABILITY = "mcp-chat-v1";
export const MCP_CHAT_ROUTES = { get: "/v1/mcp-chat/get", save: "/v1/mcp-chat/save" } as const;
export interface McpChatTarget {
  kind: "agent" | "channel";
  id: string;
}
export interface McpChatGrant {
  connectionId: string;
  mode: "read" | "write";
}
export interface McpChatPolicy {
  grants: McpChatGrant[];
}
export interface McpChatSnapshot extends McpChatPolicy {
  connections: { id: string; name: string }[];
}
const target = fields({ kind: oneOf("agent", "channel"), id: identifier });
const grant = fields({ connectionId: identifier, mode: oneOf("read", "write") });
const grants = list(grant, 100);
const snapshot = fields({ grants, connections: list(fields({ id: identifier, name: string(256) }), 100) });
export const MCP_CHAT_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [MCP_CHAT_ROUTES.get, adminRoute(fields({ target }), snapshot)],
  [MCP_CHAT_ROUTES.save, adminRoute(fields({ target, grants }), snapshot)],
]);
export function decodeMcpChatTarget(value: unknown): McpChatTarget {
  const parsed = target(value);
  if (
    !isDynamicRecord(parsed) ||
    (parsed.kind !== "agent" && parsed.kind !== "channel") ||
    typeof parsed.id !== "string"
  )
    throw new Error("Invalid chat target.");
  return { kind: parsed.kind, id: parsed.id };
}
export function decodeMcpChatPolicy(value: unknown): McpChatPolicy {
  if (!isDynamicRecord(value) || !Array.isArray(value.grants) || value.grants.length > 100)
    throw new Error("Invalid chat app grants.");
  return {
    grants: value.grants.map((entry) => {
      const parsed = grant(entry);
      if (
        !isDynamicRecord(parsed) ||
        typeof parsed.connectionId !== "string" ||
        (parsed.mode !== "read" && parsed.mode !== "write")
      )
        throw new Error("Invalid chat app grant.");
      return { connectionId: parsed.connectionId, mode: parsed.mode };
    }),
  };
}
export function decodeMcpChatSnapshot(value: unknown): McpChatSnapshot {
  const parsed = snapshot(value);
  if (!isDynamicRecord(parsed) || !Array.isArray(parsed.connections)) throw new Error("Invalid chat apps.");
  return {
    ...decodeMcpChatPolicy(parsed),
    connections: parsed.connections.map((entry) => {
      if (!isDynamicRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string")
        throw new Error("Invalid chat app.");
      return { id: entry.id, name: entry.name };
    }),
  };
}
