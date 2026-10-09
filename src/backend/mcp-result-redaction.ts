import { decodeTeamProtocolV2Json, type TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { redactMcpValues } from "./mcp-redaction";

/** Redacts decoded values, including JSON carried inside an MCP text block. */
export function redactMcpResult(value: unknown, secrets: string[]): TeamProtocolV2Json {
  return redactValue(decodeTeamProtocolV2Json(value), secrets, 0);
}
function redactValue(value: TeamProtocolV2Json, secrets: string[], depth: number): TeamProtocolV2Json {
  if (typeof value === "string") return redactString(value, secrets, depth);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactString(key, secrets, depth),
        redactValue(item, secrets, depth + 1),
      ]),
    );
  return value;
}
function redactString(value: string, secrets: string[], depth: number): string {
  const text = value.trim();
  if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"')) {
    try {
      const parsed = decodeTeamProtocolV2Json(JSON.parse(text));
      if (depth >= 32) return "•••";
      return JSON.stringify(redactValue(parsed, secrets, depth + 1));
    } catch {
      // Ordinary text can begin with punctuation. It still receives the exact-value mask.
    }
  }
  return redactMcpValues(value, [...secrets, ...secrets.map((secret) => JSON.stringify(secret).slice(1, -1))]);
}
