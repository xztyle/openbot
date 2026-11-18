import { isBoundedString, isIdentifier, isRequestId } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

/**
 * What a request that waits for the user asks for:
 * - `question`: `ask_user`, a provider's question or an MCP consent form;
 * - `form`: an `ask_ui` block;
 * - `api-key`: the form of `request_api_key`;
 * - `approval`: a command, a file change or more permissions;
 * - `browser-takeover`: `request_takeover`, the user acts in a browser tab;
 * - `sign-in`: a takeover because the site refused the sign-in from the host's network address;
 * - `secret`: `submit_secret`, a password or a code for a browser tab.
 */
export const AGENT_ATTENTION_KINDS = [
  "question",
  "form",
  "api-key",
  "approval",
  "browser-takeover",
  "sign-in",
  "secret",
] as const;
export type AgentAttentionKind = (typeof AGENT_ATTENTION_KINDS)[number];

/** The most items one list holds. More requests than this seldom wait at the same time. */
export const AGENT_ATTENTION_ITEMS_LIMIT = 200;
/** The longest summary or origin of an item. */
export const AGENT_ATTENTION_TEXT_LIMIT = 200;

/**
 * One request of any agent that waits for the user: the host's whole list, unlike the runtime
 * snapshot, which holds four. A client counts and lists them ("Needs you") and opens the chat that
 * answers each. The card itself comes from the request's own event or page.
 *
 * `summary` is text that is safe to show anywhere the agent shows: the question (never a private
 * one), the name of an API key, or the title of the tab of a takeover. An approval has none, because
 * its command can hold a secret. `origin` is the host name of the tab of a takeover or a secret.
 */
export interface AgentAttentionItem {
  kind: AgentAttentionKind;
  requestId: string | number;
  agentId: string;
  threadId: string;
  turnId: string;
  /** When the host first listed the request, as an ISO time. */
  createdAt: string;
  summary?: string;
  origin?: string;
}

export function isAgentAttentionItem(value: unknown): value is AgentAttentionItem {
  return (
    isDynamicRecord(value) &&
    isOneOf(AGENT_ATTENTION_KINDS, value.kind) &&
    isRequestId(value.requestId) &&
    isIdentifier(value.agentId) &&
    isIdentifier(value.threadId) &&
    isIdentifier(value.turnId) &&
    isBoundedString(value.createdAt, 64) &&
    (value.summary === undefined || isBoundedString(value.summary, AGENT_ATTENTION_TEXT_LIMIT)) &&
    (value.origin === undefined || isBoundedString(value.origin, AGENT_ATTENTION_TEXT_LIMIT))
  );
}

export function isAgentAttentionItemList(value: unknown): value is AgentAttentionItem[] {
  return Array.isArray(value) && value.length <= AGENT_ATTENTION_ITEMS_LIMIT && value.every(isAgentAttentionItem);
}

/** The key of one request: a provider can use a request id again on another agent. */
export function agentAttentionKey(item: Pick<AgentAttentionItem, "agentId" | "requestId">): string {
  return `${item.agentId}\n${String(item.requestId)}`;
}
