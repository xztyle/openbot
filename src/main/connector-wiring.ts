import { join } from "node:path";
import {
  type AgentAttentionItem,
  type AgentSummary,
  CONVERSATION_PLAN_ITEM_TYPE,
  CONVERSATION_SUBAGENTS_ITEM_TYPE,
  type ConversationPage,
  type LoopDecision,
  type QueuedMessageReceipt,
  ROUTINE_QUIET_ANSWER_ITEM_TYPE,
} from "@openbot/contracts/ipc";
import type { EventRoutineOwner } from "@openbot/contracts/ipc-events";
import type { OwnerHeldItem } from "@openbot/contracts/team-protocol/owner-away-v1";
import type { Effect } from "effect";
import { runCauseEffect } from "../backend/effect-boundary";
import { AgentMail, type AgentMailHooks } from "./agent-mail/agent-mail";
import { ConnectorAccess } from "./connector-access";
import { ConnectorGateway, connectorGatewayConfig } from "./connector-gateway";
import type { HostEventsService } from "./host-events-service";
import { OwnerMcpServer } from "./owner-mcp-server";
import { OwnerMcpTokens } from "./owner-mcp-tokens";
import type { SecretCipher } from "./provider-credential-store";
import { WebhookInbox } from "./webhook-inbox";

const TOKENS_FILE = "openbot-owner-mcp-tokens-v1.json";
const INBOXES_FILE = "openbot-webhook-inboxes-v1.json";
const MAILBOXES_FILE = "openbot-agent-mailboxes-v1.json";
/** Messages that are not the conversation: progress notes, plans, questions and quiet routine answers. */
const NOT_CONVERSATION = new Set([
  "commentary",
  "question_prompt",
  CONVERSATION_PLAN_ITEM_TYPE,
  CONVERSATION_SUBAGENTS_ITEM_TYPE,
  ROUTINE_QUIET_ANSWER_ITEM_TYPE,
]);

export interface ConnectorWiringOptions {
  userData: string;
  cipher: SecretCipher;
  events: HostEventsService;
  listAgents: () => readonly AgentSummary[];
  spaceOfAgent: (agentId: string) => { id: string; name: string };
  spaceOfChannel: (channelId: string) => string;
  channelName: (channelId: string) => string;
  threadOf: (agentId: string) => string | null;
  readPage: (agentId: string, threadId: string, limit: number) => ConversationPage;
  sendMessage: (input: {
    agentId: string;
    text: string;
    clientMessageId: string;
  }) => Effect.Effect<QueuedMessageReceipt, { readonly cause: unknown }>;
  delivery: (deliveryId: string) => { recipientAgentId: string; status: string; turnId: string | null } | null;
  turnAnswer: (agentId: string, turnId: string) => string | null;
  attentionItems: () => AgentAttentionItem[];
  loopDecisions: () => LoopDecision[];
  heldItems: () => OwnerHeldItem[];
  /** The agent mailboxes' way into agents and loops. */
  mail: AgentMailHooks;
}

/**
 * The connector gateway with the owner's MCP endpoint and the webhook inboxes, and their settings.
 * The gateway listens only when the operator sets `OPENBOT_CONNECTOR_LISTEN`.
 */
export function createConnectors(options: ConnectorWiringOptions): {
  access: ConnectorAccess;
  gateway: ConnectorGateway;
  mail: AgentMail;
} {
  const tokens = new OwnerMcpTokens({ file: join(options.userData, TOKENS_FILE) });
  const agents = () =>
    options
      .listAgents()
      .filter((agent) => agent.hiddenAt === undefined)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        title: agent.title,
        space: options.spaceOfAgent(agent.id).name,
      }));
  const mcp = new OwnerMcpServer({
    tokens,
    listAgents: agents,
    sendMessage: async (input) => {
      const receipt = await runCauseEffect(options.sendMessage(input));
      const delivery = receipt.deliveries.find((item) => item.recipientAgentId === input.agentId);
      return { deliveryId: delivery?.id ?? receipt.deliveries[0]?.id ?? "" };
    },
    delivery: options.delivery,
    turnAnswer: options.turnAnswer,
    recentMessages: (agentId, limit) => {
      const threadId = options.threadOf(agentId);
      if (!threadId) return [];
      return options
        .readPage(agentId, threadId, limit * 4)
        .messages.filter(
          (message) =>
            (message.author === "user" || message.author === "assistant") &&
            message.status === "completed" &&
            !(message.itemType && NOT_CONVERSATION.has(message.itemType)) &&
            message.text.trim(),
        )
        .slice(-limit)
        .map((message) => ({
          from: message.author === "user" ? ("owner" as const) : ("agent" as const),
          text: message.text,
          at: message.createdAt,
        }));
    },
    attentionItems: options.attentionItems,
    loopDecisions: options.loopDecisions,
    heldItems: options.heldItems,
  });
  const inbox = new WebhookInbox({
    file: join(options.userData, INBOXES_FILE),
    cipher: options.cipher,
    events: options.events,
  });
  // The gateway is made after the mailboxes, which read its address only when settings ask.
  let gatewayRef: ConnectorGateway | null = null;
  const mail = new AgentMail({
    file: join(options.userData, MAILBOXES_FILE),
    cipher: options.cipher,
    hooks: options.mail,
    gateway: {
      listening: () => gatewayRef?.listening() ?? false,
      publicUrl: () => gatewayRef?.publicUrl() ?? null,
    },
  });
  const gateway = new ConnectorGateway({ config: connectorGatewayConfig(), mcp, inbox, mail });
  gatewayRef = gateway;
  const ownerName = (owner: EventRoutineOwner) =>
    owner.kind === "agent"
      ? (options.listAgents().find((agent) => agent.id === owner.id)?.name ?? owner.id)
      : options.channelName(owner.id);
  const access = new ConnectorAccess({
    gateway,
    tokens,
    inbox,
    routes: () => options.events.inboxRoutes(),
    ownerName,
    ownerSpaceId: (owner) =>
      owner.kind === "agent" ? options.spaceOfAgent(owner.id).id : options.spaceOfChannel(owner.id),
  });
  return { access, gateway, mail };
}
