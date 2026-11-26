import { isOwnerSummary, type OwnerSummary } from "./agent-approvals";
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
 *
 * A ticket of the Motion board that waits on the user is a `question` of no turn: `turnId` is
 * `MOTION_TICKET_TURN` and `url` opens the ticket (`isTicketAttention`). A client of before shows it
 * as a question of the agent, so the wire needs no new kind.
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

/**
 * Why a Motion ticket waits on the user, which picks its answers:
 * - `approval`: the agent asks for the user's OK (Approve / Decline);
 * - `review-escalated`: the independent grader used up its rounds (Accept as is / Send back);
 * - `blocked`: the agent needs information or access from the user (a written answer);
 * - `other`: anything else (a written answer).
 */
export const TICKET_ASKS = ["approval", "review-escalated", "blocked", "other"] as const;
export type TicketAsks = (typeof TICKET_ASKS)[number];

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
 * `channelId` is the team channel that the work of the request belongs to, also when the turn runs
 * outside a channel task (a teammate's delegated work): the channel shows its card, and a
 * notification opens the channel.
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
  channelId?: string;
  /** The web address of a `ticket`. */
  url?: string;
  /** A ticket: why it waits on the user. Absent while the host has not read it yet. */
  asks?: TicketAsks;
  /** A ticket: what the agent needs from the user, in one line. Technical: shown only on request. */
  reason?: string;
  /** A ticket explained for the owner, who has no technical background. The card shows this. */
  plain?: OwnerSummary;
  /** A ticket that a manager sent up to the owner: the manager's name, and why. */
  escalatedBy?: string;
  escalationReason?: string;
  /**
   * The owner wrote to the agent while this waits, and the agent has not answered since: the owner
   * asked something instead of deciding. A question decides nothing, so the request stays.
   */
  ownerAsked?: true;
  /** A `form` that is a decision card (`request_decision`): the owner chooses an option, not a form. */
  decision?: true;
}

/** The `turnId` of a Motion ticket that waits on the user. */
export const MOTION_TICKET_TURN = "motion";

/**
 * The answer field of a waiting Motion ticket's `respondToPrompt`: its text goes on the ticket as the
 * owner's comment. Answers without it dismiss the ticket from Needs you.
 */
export const TICKET_ANSWER_FIELD = "answer";

/**
 * The optional verdict field of the same `respondToPrompt`, for a review that the grader escalated:
 * `accept` closes the ticket as it is (the owner's verdict replaces the grader's), `send-back` reopens
 * it with the note. A client that sends no verdict only comments.
 */
export const TICKET_VERDICT_FIELD = "verdict";
export const TICKET_VERDICTS = ["accept", "send-back"] as const;
export type TicketVerdict = (typeof TICKET_VERDICTS)[number];

/**
 * The optional decision field of the same `respondToPrompt`: what the owner's answer decides, when it
 * is one of the ticket's two buttons (Approve / Decline, Accept as is / Send back). A decision card
 * that asks the same thing (`request_decision` with the ticket's key) is one request with the ticket:
 * the host answers the card with the decision, and a written answer with no decision leaves it open.
 */
export const TICKET_DECISION_FIELD = "decision";
export const TICKET_DECISIONS = ["approve", "decline"] as const;
export type TicketDecision = (typeof TICKET_DECISIONS)[number];

/** The key of a waiting ticket from its summary, "EVE-40 · Title": the text before the separator. */
export function ticketKeyOf(summary: string | undefined): string | undefined {
  const key = summary?.split(" · ")[0]?.trim();
  return key ? key : undefined;
}

/** Whether two ticket keys name one ticket. Motion writes keys in capitals; a tool argument may not. */
export function sameTicketKey(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** A Motion ticket that waits on the user, which opens at its `url`, not in a chat. */
export function isTicketAttention(item: Pick<AgentAttentionItem, "turnId" | "url">): item is AgentAttentionItem & {
  url: string;
} {
  return item.turnId === MOTION_TICKET_TURN && item.url !== undefined;
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
    (value.origin === undefined || isBoundedString(value.origin, AGENT_ATTENTION_TEXT_LIMIT)) &&
    (value.channelId === undefined || isIdentifier(value.channelId)) &&
    (value.url === undefined || (isBoundedString(value.url, 2_000) && /^https?:\/\//u.test(value.url))) &&
    (value.asks === undefined || isOneOf(TICKET_ASKS, value.asks)) &&
    (value.reason === undefined || isBoundedString(value.reason, AGENT_ATTENTION_TEXT_LIMIT)) &&
    (value.plain === undefined || isOwnerSummary(value.plain)) &&
    (value.escalatedBy === undefined || isBoundedString(value.escalatedBy, AGENT_ATTENTION_TEXT_LIMIT)) &&
    (value.escalationReason === undefined || isBoundedString(value.escalationReason, AGENT_ATTENTION_TEXT_LIMIT)) &&
    (value.ownerAsked === undefined || value.ownerAsked === true) &&
    (value.decision === undefined || value.decision === true)
  );
}

export function isAgentAttentionItemList(value: unknown): value is AgentAttentionItem[] {
  return Array.isArray(value) && value.length <= AGENT_ATTENTION_ITEMS_LIMIT && value.every(isAgentAttentionItem);
}

/** The key of one request: a provider can use a request id again on another agent. */
export function agentAttentionKey(item: Pick<AgentAttentionItem, "agentId" | "requestId">): string {
  return `${item.agentId}\n${String(item.requestId)}`;
}
