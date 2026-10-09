import { join } from "node:path";
import { COMPUTER_USE_MCP_SERVER_ID } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentService } from "../backend/agent-service";
import type { EventCheckReader } from "../backend/event-check-reader";
import { toMcpOperationError } from "../backend/mcp-effects";
import type { McpAuthorizationSource, McpToolRuntimeSource } from "../backend/mcp-provider-shapes";
import { ChatMcpPolicyStore } from "./chat-mcp-policy-store";
import { ChatMcpProxy } from "./chat-mcp-proxy";
import { ChatMcpService } from "./chat-mcp-service";

interface Options {
  path: string;
  service: () => AgentService;
  authorization: McpAuthorizationSource;
  runtimes: McpToolRuntimeSource;
}
function chatKey(service: AgentService, threadId: string): string | null {
  const channelId = service.channels.store.channelForThread(threadId);
  if (channelId) return `channel:${channelId}`;
  const agent = service.listAgents().find((candidate) => candidate.threadId === threadId);
  return agent ? `agent:${agent.id}` : null;
}
export const createChatMcp = Effect.fn("ChatMcp.create")(function* (options: Options) {
  const policies = new ChatMcpPolicyStore(join(options.path, "chat-app-permissions-v1.json"));
  yield* policies.load();
  const proxy = new ChatMcpProxy({
    policies,
    stateDirectory: join(options.path, "mcp-app-state"),
    configs: () => options.service().enabledMcpServers(),
    chatKey: (threadId) => chatKey(options.service(), threadId),
    authorization: options.authorization,
    runtimes: options.runtimes,
  });
  yield* proxy.start();
  const api = new ChatMcpService({
    policies,
    proxy,
    agents: () => options.service().listAgents(),
    channelExists: (id) => options.service().channels.store.ids().includes(id),
    configs: () =>
      options
        .service()
        .enabledMcpServers()
        .filter((config) => config.id !== COMPUTER_USE_MCP_SERVER_ID),
    changed: () => options.service().refreshAllAgentRuntimes().pipe(toMcpOperationError),
  });
  const thread = (agentId: string) => {
    const agent = options
      .service()
      .listAgents()
      .find((item) => item.id === agentId);
    if (!agent?.threadId) throw new Error("Unknown event check agent.");
    return agent.threadId;
  };
  const reader: EventCheckReader = {
    accounts: (agentId) => proxy.readAccounts(thread(agentId)),
    read: (agentId, connectionId, use) => Effect.suspend(() => proxy.read(thread(agentId), connectionId, use)),
  };
  return { api, reader, scope: proxy.forThread.bind(proxy), close: proxy.close.bind(proxy) };
});
