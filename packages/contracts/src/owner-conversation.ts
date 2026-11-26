/**
 * The owner's chat with an agent is for the owner's conversation only.
 *
 * A turn that a person's own message started, with the agent's answer to it, is the conversation:
 * it shows as usual and counts as unread. A turn that anything else started is the agent's own
 * activity: a Motion event, a teammate's message, a note from Atelier (an approval answer, a
 * guardrail note, a research result), a mail, or a routine run. It counts nothing unread, tells
 * nothing, and the chat folds it into one "Agent activity" row for each burst.
 *
 * A turn in which the agent writes to the owner on purpose (`OWNER_MESSAGE_ITEM_TYPE`, from
 * `message_owner`) or asks the owner a question that waits for the answer is the owner's conversation,
 * whatever started it. A teammate's report that answers a request of the owner's request chain is the
 * owner's answer too, unless the agent passed it on to another agent. The chain is transitive: a request
 * that the agent sent in a person's own turn, or in a turn that a report of the chain started, at any
 * depth. The links are the exchange ids (`messageId` and `replyToMessageId`), not times.
 *
 * This is the one rule. The host's read state (`conversation-read-store.ts`, and its SQL twin in
 * `thread-read-states.ts`), the end-of-turn notice (`isBackgroundTurn`), the chat's fold and the
 * client's own recount all read it, on desktop, web and phone alike.
 */
import {
  AGENT_EXCHANGE_ITEM_TYPE,
  isSystemNoticeKind,
  SYSTEM_NOTICE_ITEM_TYPE_PREFIX,
  type SystemNoticeKind,
} from "./ipc-conversation-events";
import type { AgentExchangeSummary, ConversationMessage } from "./ipc-conversation-messages";

/** The item type of a message that an agent wrote to the owner on purpose, with `message_owner`. */
export const OWNER_MESSAGE_ITEM_TYPE = "owner-message";

/** The item type of a question that waits for the owner's answer (`ask_user`). */
const QUESTION_PROMPT_ITEM_TYPE = "question_prompt";

/** A message that is for the owner whatever started its turn. */
export function isOwnerAddressedItemType(itemType: string | undefined): boolean {
  return itemType === OWNER_MESSAGE_ITEM_TYPE || itemType === QUESTION_PROMPT_ITEM_TYPE;
}

/**
 * Text that Atelier wrote for the agent, not a person: a Motion note, a teammate's message as the
 * agent reads it, a guardrail or delegation note, or the note after a restart. Each starts with words
 * that only Atelier writes.
 */
const ATELIER_PROMPTS: ReadonlyArray<{ pattern: RegExp; notice: SystemNoticeKind }> = [
  { pattern: /^Motion · /u, notice: "motion-event" },
  {
    pattern: /^(?:OpenBot|Atelier) restarted during your last turn; continue where you left off\.$/u,
    notice: "restart-resume",
  },
  { pattern: /^Message from OpenBot teammate [^\n]* \([^()\s]+\)\.\nMessage ID: /u, notice: "operator-note" },
  { pattern: /^This turn starts with \d+ messages\. Read all of them before you answer\.\n/u, notice: "operator-note" },
  { pattern: /^Atelier (?:stopped this |guardrail: |note: )/u, notice: "operator-note" },
];

/**
 * The kind of note that a prompt is when Atelier, not a person, wrote it, or null. A provider can keep
 * such a prompt with no sign of the delivery that sent it, for example when it joins the prompts that
 * waited during a turn into one; it is then the agent's own activity, never the owner's message.
 */
export function atelierPromptNotice(text: string): SystemNoticeKind | null {
  return ATELIER_PROMPTS.find(({ pattern }) => pattern.test(text))?.notice ?? null;
}

/** What woke the agent for a turn of its own activity, for the row that names the senders. */
export type AgentActivitySource =
  | { kind: "agent"; agentId: string }
  | { kind: "motion" }
  | { kind: "atelier" }
  | { kind: "mail" }
  | { kind: "routine" };

/**
 * One message of an agent's own chat, as the rule reads it. Each caller maps its own shape: the host's
 * stored message and the client's drawn row spell their authors differently.
 */
export interface OwnerConversationRow {
  turnId?: string | undefined;
  /**
   * `person`: a person's own message. `routine`: the message of a routine run. `notice`: a note from
   * Atelier (`system-notice:*`). `exchange`: a message between agents. `answer`: the agent's answer
   * text. `owner`: a message to the owner on purpose or a question to them (`isOwnerAddressedItemType`).
   * `other`: any other row.
   */
  role: "person" | "routine" | "notice" | "exchange" | "answer" | "owner" | "other";
  notice?: SystemNoticeKind | null | undefined;
  /** On an `exchange` row. Absent on one stored before the summary: its author tells its direction. */
  exchange?:
    | Pick<AgentExchangeSummary, "messageId" | "senderAgentId" | "replyToMessageId" | "expectsReply">
    | undefined;
  direction?: "incoming" | "outgoing" | undefined;
  text: string;
}

export interface BackgroundTurnOptions {
  /** The rows hold every message of each turn: a turn that no person wrote in needs no other sign. */
  wholeTurns?: boolean;
  /** With `wholeTurns`, a turn whose first rows may be missing: it needs a sign of what started it. */
  partialTurnId?: string | undefined;
}

/** What each notice says about the turn it started. A restart note resumes the turn it cut off. */
const NOTICE_SOURCES: Readonly<Record<SystemNoticeKind, AgentActivitySource | null>> = {
  "motion-event": { kind: "motion" },
  "operator-note": { kind: "atelier" },
  "inbound-email": { kind: "mail" },
  "restart-resume": null,
};

function sameSource(left: AgentActivitySource, right: AgentActivitySource): boolean {
  return (
    left.kind === right.kind && (left.kind !== "agent" || (right.kind === "agent" && left.agentId === right.agentId))
  );
}

/**
 * The turns of the agent's own activity, with what woke the agent for each, in the order it came.
 * A turn is one when no person wrote in it and something else started it: a Motion event, a note from
 * Atelier, a mail, a routine run, or a teammate's message. It is not one when the agent wrote to the
 * owner in it on purpose or asked the owner a question. A teammate's report that answers a request of
 * a person's request chain (`ownerChainTurns`) is not one, unless the agent sent its answer on to an
 * agent. With `wholeTurns`, the rows hold every message of each turn, so a turn that no person wrote
 * in is one even with no sign of what started it, such as a restart note. Without it, such a turn is
 * not one, nor is `partialTurnId`: a client holds the latest pages, and the first turn it holds can
 * start on a page it has not loaded.
 */
export function backgroundTurns(
  rows: Iterable<OwnerConversationRow>,
  options: BackgroundTurnOptions = {},
): Map<string, AgentActivitySource[]> {
  const sources = new Map<string, AgentActivitySource[]>();
  const seen = new Set<string>();
  const requests = new Set<string>();
  const reports = new Map<string, Array<{ agentId: string; replyTo: string | null }>>();
  const answers = new Map<string, Set<string>>();
  const forwarded = new Map<string, string[]>();
  const requestTurns = new Map<string, string>();
  const people = new Set<string>();
  const toOwner = new Set<string>();
  // A person's own message, not a routine run's: only work a person asked for reports to them.
  const personAsked = new Set<string>();
  const add = (turnId: string, source: AgentActivitySource) => {
    const list = sources.get(turnId) ?? [];
    if (!list.some((known) => sameSource(known, source))) list.push(source);
    sources.set(turnId, list);
  };
  for (const row of rows) {
    const turnId = row.turnId;
    if (!turnId) continue;
    seen.add(turnId);
    if (row.role === "person") {
      people.add(turnId);
      personAsked.add(turnId);
    } else if (row.role === "owner") toOwner.add(turnId);
    else if (row.role === "routine") add(turnId, { kind: "routine" });
    else if (row.role === "notice") {
      const source = row.notice ? NOTICE_SOURCES[row.notice] : null;
      if (source) add(turnId, source);
    } else if (row.role === "exchange") {
      const direction = row.direction ?? "incoming";
      if (direction === "incoming") {
        const agentId = row.exchange?.senderAgentId;
        if (row.exchange?.expectsReply === false) {
          if (agentId)
            reports.set(turnId, [
              ...(reports.get(turnId) ?? []),
              { agentId, replyTo: row.exchange.replyToMessageId ?? null },
            ]);
        } else {
          requests.add(turnId);
          if (agentId) add(turnId, { kind: "agent", agentId });
        }
      } else {
        forwarded.set(turnId, [...(forwarded.get(turnId) ?? []), row.text.trim()]);
        if (row.exchange) requestTurns.set(row.exchange.messageId, turnId);
      }
    } else if (row.role === "answer") answers.set(turnId, (answers.get(turnId) ?? new Set()).add(row.text.trim()));
  }
  const chain = ownerChainTurns(personAsked, reports, requestTurns);
  const relays = new Set<string>();
  for (const [turnId, turnReports] of reports) {
    if (requests.has(turnId)) continue;
    const said = answers.get(turnId);
    const sentOn = Boolean(said && (forwarded.get(turnId) ?? []).some((text) => said.has(text)));
    if (!sentOn && chain.has(turnId)) relays.add(turnId);
    else for (const report of turnReports) add(turnId, { kind: "agent", agentId: report.agentId });
  }
  // With every row of each turn, a turn that no person started is the agent's own also with no sign.
  if (options.wholeTurns)
    for (const turnId of seen)
      if (turnId !== options.partialTurnId && !relays.has(turnId) && !sources.has(turnId)) sources.set(turnId, []);
  for (const turnId of relays) sources.delete(turnId);
  for (const turnId of people) sources.delete(turnId);
  for (const turnId of toOwner) sources.delete(turnId);
  return sources;
}

/**
 * The turns of a person's request chain: each turn that a person's own message started, and each turn
 * that a teammate's report started that answers a request sent in a turn of the chain, at any depth.
 * A report links to its request by `replyToMessageId`, and the request to its turn by its `messageId`.
 */
function ownerChainTurns(
  personAsked: ReadonlySet<string>,
  reports: ReadonlyMap<string, ReadonlyArray<{ replyTo: string | null }>>,
  requestTurns: ReadonlyMap<string, string>,
): Set<string> {
  const chain = new Set(personAsked);
  // Each pass adds the reports to the requests of the turns found so far; a chain of n hops takes n passes.
  for (let grew = true; grew; ) {
    grew = false;
    for (const [turnId, turnReports] of reports) {
      if (chain.has(turnId)) continue;
      const linked = turnReports.some((report) => {
        const requestTurn = report.replyTo ? requestTurns.get(report.replyTo) : undefined;
        return requestTurn !== undefined && requestTurn !== turnId && chain.has(requestTurn);
      });
      if (linked) {
        chain.add(turnId);
        grew = true;
      }
    }
  }
  return chain;
}

/** Whether a row of the agent's chat is the agent's own activity, by `backgroundTurns`. */
export function isBackgroundRow(
  row: { turnId?: string | undefined; itemType?: string | undefined },
  turns: ReadonlyMap<string, unknown>,
): boolean {
  if (isOwnerAddressedItemType(row.itemType)) return false;
  return row.turnId !== undefined && turns.has(row.turnId);
}

/** The role of a message as the host stores it (`ConversationMessage`). */
export function storedMessageRole(message: {
  author: string;
  itemType?: string | undefined;
  source?: string | undefined;
}): OwnerConversationRow["role"] {
  if (message.itemType?.startsWith(SYSTEM_NOTICE_ITEM_TYPE_PREFIX)) return "notice";
  if (isOwnerAddressedItemType(message.itemType)) return "owner";
  if (message.author === "user")
    return message.source === "routine" || message.itemType === "routine" ? "routine" : "person";
  if (message.itemType === AGENT_EXCHANGE_ITEM_TYPE) return "exchange";
  if (message.author === "assistant" && (!message.itemType || message.itemType === "agentMessage")) return "answer";
  return "other";
}

/** The kind of the note from Atelier that a stored message is, or null. */
export function storedNoticeKind(itemType: string | undefined): SystemNoticeKind | null {
  if (!itemType?.startsWith(SYSTEM_NOTICE_ITEM_TYPE_PREFIX)) return null;
  const kind = itemType.slice(SYSTEM_NOTICE_ITEM_TYPE_PREFIX.length);
  return isSystemNoticeKind(kind) ? kind : null;
}

/** The turns of the agent's own activity (`backgroundTurns`), as the host stores the messages. */
export function storedBackgroundTurns(
  messages: readonly ConversationMessage[],
  options: BackgroundTurnOptions = {},
): Map<string, AgentActivitySource[]> {
  return backgroundTurns(
    messages.map((message) => ({
      turnId: message.turnId,
      role: storedMessageRole(message),
      notice: storedNoticeKind(message.itemType),
      exchange: message.exchange,
      // A message stored before the exchange summary has its direction in its author.
      direction: message.exchange?.direction ?? (message.author === "agent" ? "incoming" : "outgoing"),
      text: message.text,
    })),
    options,
  );
}
