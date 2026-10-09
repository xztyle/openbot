import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import type { McpChatGrant } from "@openbot/contracts/team-protocol/mcp-chat-v1";

const SLACK_READ_TOOLS = new Set([
  "conversations_history",
  "conversations_replies",
  "conversations_search_messages",
  "channels_list",
]);
/**
 * The one Slack server whose tool names `SLACK_READ_TOOLS` was reviewed against. The Slack listing in
 * `marketplace/plugin-catalog/plugins/slack/plugin.json` must name exactly this command: the plugin
 * catalog build fails when the two differ, so a version bump there is a review of this list too.
 */
export const SLACK_MCP_COMMAND = "npx";
export const SLACK_MCP_ARGS: readonly string[] = ["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"];
/** Unknown tools require explicit permission to make changes. Names alone never grant a generic app access. */
export function isSlackApp(config: McpServerConfig): boolean {
  return (
    config.transport === "stdio" &&
    config.command === SLACK_MCP_COMMAND &&
    JSON.stringify(config.args) === JSON.stringify(SLACK_MCP_ARGS)
  );
}
export function mayCallChatTool(mode: McpChatGrant["mode"] | undefined, tool: Tool, config: McpServerConfig): boolean {
  if (mode === "write") return true;
  if (mode !== "read" || tool.annotations?.destructiveHint === true) return false;
  if (isSlackApp(config)) return SLACK_READ_TOOLS.has(tool.name);
  return tool.annotations?.readOnlyHint === true;
}
