// Frozen optional attention-items-v1 wire contract of this fork.
//
// What it adds, recorded here because freezing it makes it permanent: the event
// `agent-attention-changed` with the whole list of requests of every agent that wait for the user (a
// question, a form, an API key form, an approval, a browser takeover, a sign-in takeover or a browser
// secret). The runtime snapshot holds four of them, so a client could not count or list the rest. Each
// item names the request (`kind`, `requestId`, `agentId`, `threadId`, `turnId`), the time the host
// listed it (`createdAt`), and may carry `summary` (a question that is not private, the name of an API
// key, or the title of the tab of a takeover) and `origin` (the host name of that tab). An approval has
// no summary: its command can hold a secret. The cards keep coming from the released events and pages.
// Added later, optional: `channelId`, the team channel that the work of the request belongs to. A
// client of before drops it, as it drops any key it does not know, and shows the request as before.
// Added later, optional: `url` (http or https, at most 2000 characters), on a Motion ticket that waits
// on the user: a `question` whose `turnId` is `motion`. A client of before shows it as a question.
// Added later, optional, on such a ticket: `asks` (`approval`, `review-escalated`, `blocked` or
// `other`: why it waits, which picks its answers) and `reason` (what the agent needs, at most 200
// characters). A client of before drops both and shows the ticket as before.
// Added later, optional, on such a ticket: `plain` (`{ asks, why, ifYes, ifNo }`, each at most 240
// characters: the ticket explained for an owner with no technical background, which the card shows
// instead of `reason`), `escalatedBy` and `escalationReason` (the manager that sent it up to the
// owner, and why; at most 200 characters each). A client of before drops them.
//
// The host sends the event after each runtime snapshot that it sends to a peer, and again at each
// change, to a peer that has `fork-host-v1` only. It leaves out each request of an agent that the peer
// cannot see. Bounds: at most 200 items, identifiers of at most 128 characters, a summary and an origin
// of at most 200 characters. A malformed event fails closed. Widening any of it needs a second
// capability string.
//
// It adds no capability string: a released peer accepts at most 64, so it shares `fork-host-v1`
// (see `fork-host-v1.ts`). A host without it never sends the event, and a client then counts the
// requests that it has from the snapshot and the request events.

import { isOwnerSummary } from "../agent-approvals";
import {
  AGENT_ATTENTION_ITEMS_LIMIT,
  AGENT_ATTENTION_KINDS,
  AGENT_ATTENTION_TEXT_LIMIT,
  type AgentAttentionItem,
  TICKET_ASKS,
} from "../ipc-attention-items";
import { isDynamicRecord, isNumber, isOneOf, isString } from "../runtime-values";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const ATTENTION_ITEMS_CAPABILITY = FORK_HOST_CAPABILITY;
export const ATTENTION_ITEMS_EVENT = "agent-attention-changed";

const IDENTIFIER_LIMIT = 128;

function invalid(): never {
  throw new Error("Invalid attention item.");
}

function identifier(value: unknown): string {
  if (!isString(value) || value.length === 0 || value.length > IDENTIFIER_LIMIT) invalid();
  return value;
}

function requestId(value: unknown): string | number {
  if (isNumber(value) && Number.isSafeInteger(value)) return value;
  return identifier(value);
}

function text(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isString(value) || value.length > AGENT_ATTENTION_TEXT_LIMIT) invalid();
  return value;
}

function item(value: unknown): AgentAttentionItem {
  if (!isDynamicRecord(value) || !isOneOf(AGENT_ATTENTION_KINDS, value.kind)) invalid();
  if (!isString(value.createdAt) || value.createdAt.length > 64 || Number.isNaN(Date.parse(value.createdAt))) invalid();
  const summary = text(value.summary);
  const origin = text(value.origin);
  const channelId = value.channelId === undefined ? undefined : identifier(value.channelId);
  const url = value.url === undefined ? undefined : ticketUrl(value.url);
  const asks = value.asks === undefined ? undefined : isOneOf(TICKET_ASKS, value.asks) ? value.asks : invalid();
  const reason = text(value.reason);
  const plain = value.plain === undefined ? undefined : isOwnerSummary(value.plain) ? value.plain : invalid();
  const escalatedBy = text(value.escalatedBy);
  const escalationReason = text(value.escalationReason);
  return {
    kind: value.kind,
    requestId: requestId(value.requestId),
    agentId: identifier(value.agentId),
    threadId: identifier(value.threadId),
    turnId: identifier(value.turnId),
    createdAt: value.createdAt,
    ...(summary === undefined ? {} : { summary }),
    ...(origin === undefined ? {} : { origin }),
    ...(channelId === undefined ? {} : { channelId }),
    ...(url === undefined ? {} : { url }),
    ...(asks === undefined ? {} : { asks }),
    ...(reason === undefined ? {} : { reason }),
    ...(plain === undefined
      ? {}
      : { plain: { asks: plain.asks, why: plain.why, ifYes: plain.ifYes, ifNo: plain.ifNo } }),
    ...(escalatedBy === undefined ? {} : { escalatedBy }),
    ...(escalationReason === undefined ? {} : { escalationReason }),
  };
}

function ticketUrl(value: unknown): string {
  if (!isString(value) || value.length > 2_000 || !/^https?:\/\//u.test(value)) invalid();
  return value;
}

/** The list in its wire shape. Throws on a malformed list. */
export function decodeAttentionItems(value: unknown): AgentAttentionItem[] {
  if (!Array.isArray(value) || value.length > AGENT_ATTENTION_ITEMS_LIMIT) throw new Error("Invalid attention items.");
  return value.map(item);
}

export type AttentionItemsEvent = {
  type: typeof ATTENTION_ITEMS_EVENT;
  items: AgentAttentionItem[];
};

export function attentionItemsEvent(input: unknown): AttentionItemsEvent | null {
  if (!isDynamicRecord(input) || input.type !== ATTENTION_ITEMS_EVENT) return null;
  return { type: ATTENTION_ITEMS_EVENT, items: decodeAttentionItems(input.items) };
}

/** The list that one peer may see: no request of an agent in `hidden`. */
export function visibleAttentionItems(
  items: readonly AgentAttentionItem[],
  hidden: ReadonlySet<string>,
): AgentAttentionItem[] {
  return items.filter((entry) => !hidden.has(entry.agentId));
}
