import type { AgentSummary, McpServerConfig } from "@openbot/contracts/ipc";
import type { McpChatPolicy, McpChatSnapshot, McpChatTarget } from "@openbot/contracts/team-protocol/mcp-chat-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { McpOperationError } from "../backend/mcp-effects";
import { toMcpOperationError } from "../backend/mcp-effects";
import { McpServerError } from "../backend/mcp-server-store";
import type { ChatMcpPolicyStore } from "./chat-mcp-policy-store";
import type { ChatMcpProxy } from "./chat-mcp-proxy";

interface Options {
  policies: ChatMcpPolicyStore;
  proxy: ChatMcpProxy;
  agents: () => readonly Pick<AgentSummary, "id">[];
  channelExists: (id: string) => boolean;
  configs: () => readonly McpServerConfig[];
  changed: () => Effect.Effect<void, McpOperationError>;
}
/** Only authenticated administrators may update these grants; agent tools have no write surface. */
export class ChatMcpService {
  constructor(readonly options: Options) {}
  #key(target: McpChatTarget): string {
    const exists =
      target.kind === "agent"
        ? this.options.agents().some((agent) => agent.id === target.id)
        : this.options.channelExists(target.id);
    if (!exists) throw new McpServerError(sourceText("error.mcp.chatUnknown"));
    return `${target.kind}:${target.id}`;
  }
  snapshot(target: McpChatTarget): McpChatSnapshot {
    const key = this.#key(target);
    const connections = this.options
      .configs()
      .filter((config) => config.enabled)
      .map(({ id, name }) => ({ id, name }));
    return {
      grants: this.options.policies
        .get(key)
        .grants.filter((grant) => connections.some((connection) => connection.id === grant.connectionId)),
      connections,
    };
  }
  readonly save = Effect.fn("ChatMcpService.save")(function* (
    this: ChatMcpService,
    target: McpChatTarget,
    policy: McpChatPolicy,
  ) {
    const key = this.#key(target);
    const ids = policy.grants.map((grant) => grant.connectionId);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !this.options.configs().some((config) => config.id === id && config.enabled))
    )
      throw new McpServerError(sourceText("error.mcp.chatConnectionGone"));
    yield* this.options.policies.save(key, policy).pipe(toMcpOperationError);
    this.options.proxy.revoke(key);
    yield* this.options.changed();
    return this.snapshot(target);
  });
}
