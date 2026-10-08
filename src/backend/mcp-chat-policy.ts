import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import type { McpChatGrant } from "@openbot/contracts/team-protocol/mcp-chat-v1";

const SLACK_READ_TOOLS = new Set([
  "conversations_history",
  "conversations_replies",
  "conversations_search_messages",
  "channels_list",
]);
/** Unknown tools require explicit permission to make changes. Names alone never grant a generic app access. */
export function isSlackApp(config: McpServerConfig): boolean {
  return (
    config.transport === "stdio" &&
    config.command === "npx" &&
    JSON.stringify(config.args) === JSON.stringify(["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"])
  );
}
export function mayCallChatTool(mode: McpChatGrant["mode"] | undefined, tool: Tool, config: McpServerConfig): boolean {
  if (mode === "write") return true;
  if (mode !== "read" || tool.annotations?.destructiveHint === true) return false;
  if (isSlackApp(config)) return SLACK_READ_TOOLS.has(tool.name);
  return tool.annotations?.readOnlyHint === true;
}
