import { chatVisualReply } from "@openbot/contracts/chat-visual";
import { EVENT_CHECK_ITEM_TYPE_PREFIX } from "@openbot/contracts/event-checks";
import type { AgentSummary, ConversationMessage, QueueDeliveryStatus } from "@openbot/contracts/ipc";
import {
  CONVERSATION_PLAN_ITEM_TYPE,
  hostedSiteConversationEvent,
  isContextResetMarker,
  marketplaceSuggestionEvent,
  parseConversationPlanText,
  routineConversationEvent,
  routineRunConversationEvent,
  skillConversationEvent,
} from "@openbot/contracts/ipc";
import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import { cleanAgentMessageText } from "@openbot/team-client/agent-message-text";
import type {
  AgentDeliveryMarkerStatus,
  AgentMessage,
  AgentMessagePlan,
  AgentProfile,
  ChatActionMarkerModel,
  MessageEventCheckOrigin,
} from "@openbot/ui/data";
import { formatChatTimestamp } from "@openbot/ui/features/conversation/chat-timestamp";
import { silentAgentAnswer } from "@openbot/ui/features/conversation/new-message-tally";
import type { TaskListItem } from "@openbot/ui/features/conversation/TaskList";
import { currentText } from "@openbot/ui/text";
import { isRoutineEventItem } from "./features/conversation/conversation-read-state";

export function toAgentProfile(stored: AgentSummary): AgentProfile {
  return {
    id: stored.id,
    name: stored.name,
    title: stored.title,
    description: stored.description,
    notifications: stored.notifications,
    provider: stored.provider,
    model: stored.model,
    reasoningEffort: stored.reasoningEffort,
    access: stored.access,
    computerUse: stored.computerUse,
    allowAutomation: stored.allowAutomation,
    busyMessageMode: stored.busyMessageMode,
    threadId: stored.threadId,
    workspacePath: stored.workspacePath,
    avatarSeed: stored.avatarSeed,
    avatarHue: stored.avatarHue,
    avatarUrl: stored.avatarUrl,
    marketplaceSource: stored.marketplaceSource,
    updatedAt: stored.updatedAt,
    time: stored.updatedAt ? formatTime(stored.updatedAt) : currentText().t("chat.day.now"),
    preview: cleanPreview(stored.preview),
  };
}

export function toAgentMessage(message: ConversationMessage, ownerAgentId?: string): AgentMessage {
  const exchangeSenderId = message.senderAgentId ?? message.exchange?.senderAgentId;
  const routineEvent = routineConversationEvent(message);
  const routineRunEvent = routineRunConversationEvent(message);
  const hostedSiteEvent = hostedSiteConversationEvent(message);
  const actionMarker = chatActionMarker(message, ownerAgentId, routineEvent, routineRunEvent, hostedSiteEvent);
  const plan = messagePlan(message);
  return {
    id: message.id,
    turnId: message.turnId,
    author: message.author === "user" ? "you" : "agent",
    body: message.author === "user" ? message.text : cleanAgentMessageText(message.text),
    time: formatMessageTime(message.createdAt),
    createdAt: message.createdAt,
    streaming: message.status === "streaming",
    itemType: message.itemType,
    kind: message.questionPrompt ? "question" : actionMarker ? "action-marker" : plan ? "plan" : "text",
    senderAgentId: exchangeSenderId,
    senderMember: message.author === "user" ? message.senderMember : undefined,
    replyToMessageId: message.replyToMessageId,
    ...(cancelledByUser(message) ? { cancelled: true as const } : {}),
    attachments: message.attachments,
    imageGeneration: message.imageGeneration,
    questionPrompt: message.questionPrompt,
    exchange: message.exchange,
    reaction: message.reaction,
    reactions:
      message.reactions ?? (message.reaction ? [{ emoji: message.reaction, actor: { kind: "user" as const } }] : []),
    routine: message.routine,
    actionMarker: actionMarker ?? undefined,
    plan: plan ?? undefined,
    status:
      message.exchange || message.routine
        ? undefined
        : message.delivery?.status === "queued"
          ? `Queued #${message.delivery.position}`
          : message.delivery?.status === "cancelled"
            ? "Cancelled"
            : message.status === "failed"
              ? "Failed"
              : message.status === "interrupted"
                ? "Stopped"
                : undefined,
  };
}

/**
 * The plan of a `plan` message. A peer on a released Team API protocol sends only the checklist
 * text, so the plan is read back from it.
 */
export function messagePlan(message: ConversationMessage): AgentMessagePlan | null {
  if (message.author !== "assistant" || message.itemType !== CONVERSATION_PLAN_ITEM_TYPE) return null;
  const plan = message.plan ?? parseConversationPlanText(message.text);
  if (!plan?.steps.length) return null;
  return { ...plan, stopped: message.status === "interrupted" || message.status === "failed" };
}

/**
 * The rows of a plan block. A step runs only while its turn runs: after the turn ends, a step that
 * was not finished shows as not started.
 */
export function planItems(plan: AgentMessagePlan, streaming: boolean): TaskListItem[] {
  return plan.steps.map((step) => {
    const state =
      step.status === "completed" ? "done" : step.status === "inProgress" && streaming ? "active" : "pending";
    return { id: step.id, label: state === "active" ? (step.activeText ?? step.text) : step.text, state };
  });
}

const PLAN_TITLE_LIMIT = 80;

/** The header of a plan block: a short explanation, else "Tasks", or "Stopped" for a stopped plan. */
export function planTitle(plan: AgentMessagePlan): string {
  const { t } = currentText();
  if (plan.stopped && plan.steps.some((step) => step.status !== "completed")) return t("chat.taskList.stopped");
  if (plan.explanation && plan.explanation.length <= PLAN_TITLE_LIMIT) return plan.explanation;
  return t("chat.taskList.title");
}

/**
 * A message of the person that they cancelled in the queue. It stays in the chat marked Cancelled,
 * because the text was theirs and the agent never read it. A cancelled message of another kind, such
 * as a teammate's request, has its own marker and stays out of the transcript as before.
 */
function cancelledByUser(message: ConversationMessage): boolean {
  return message.delivery?.status === "cancelled" && message.author === "user" && !message.exchange && !message.routine;
}

/** A message the list leaves out: waiting or cancelled in the queue, and not the person's own. */
function hiddenFromTranscript(message: ConversationMessage): boolean {
  return (
    (message.delivery?.status === "queued" ||
      (message.delivery?.status === "cancelled" && !cancelledByUser(message))) &&
    !message.routine &&
    !message.itemType?.startsWith(EVENT_CHECK_ITEM_TYPE_PREFIX)
  );
}

function isCommentary(message: ConversationMessage): boolean {
  return message.author === "assistant" && message.itemType === "commentary";
}

/** The reasoning of one turn as one message: the cleaned text and the id of each step. */
function thinkingMessage(
  key: string,
  first: ConversationMessage,
  members: readonly ConversationMessage[],
): AgentMessage {
  return {
    id: `thinking:${key}`,
    turnId: first.turnId,
    author: "agent",
    body: "",
    time: formatMessageTime(first.createdAt),
    createdAt: first.createdAt,
    streaming: members.some((member) => member.status === "streaming"),
    itemType: "commentary",
    kind: "thinking",
    items: members.map((member) => cleanAgentMessageText(member.text)),
    itemIds: members.map((member) => member.id),
  };
}

export function toAgentMessages(messages: ConversationMessage[], ownerAgentId?: string): AgentMessage[] {
  return projectMessages(messages, ownerAgentId, undefined);
}

function projectMessages(
  messages: readonly ConversationMessage[],
  ownerAgentId: string | undefined,
  cache: MessageProjectionCache | undefined,
): AgentMessage[] {
  const visible = messages.filter((message) => !hiddenFromTranscript(message));
  // The commentary of one turn joins into one message, at the place of its first step.
  const groups = new Map<string, ConversationMessage[]>();
  for (const message of visible) {
    if (!isCommentary(message)) continue;
    const key = message.turnId ?? message.id;
    const group = groups.get(key);
    if (group) group.push(message);
    else groups.set(key, [message]);
  }
  const result: AgentMessage[] = [];
  const emitted = new Set<string>();
  for (const message of visible) {
    if (!isCommentary(message)) {
      result.push(cache ? cache.message(message, ownerAgentId) : toAgentMessage(message, ownerAgentId));
      continue;
    }
    const key = message.turnId ?? message.id;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const members = groups.get(key) ?? [message];
    result.push(cache ? cache.thinking(key, message, members) : thinkingMessage(key, message, members));
  }
  return result;
}

/**
 * Which locale and day the strings of a projection follow. `time` reads both, so a row that was
 * cached under another context is made again.
 */
function projectionContext(ownerAgentId: string | undefined): string {
  const { format } = currentText();
  const today = new Date();
  return [
    ownerAgentId ?? "",
    format.locale,
    // The date conventions of `intlLocale` are not on the format, so a fixed date shows them.
    format.date(CONTEXT_PROBE_DATE, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }),
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ].join("\u0000");
}

const CONTEXT_PROBE_DATE = new Date(Date.UTC(2001, 8, 17, 15, 4, 5));

/** The fields of a message whose own value, or its reference, an `AgentMessage` is made from. */
const PROJECTED_FIELDS = [
  "id",
  "turnId",
  "author",
  "text",
  "createdAt",
  "status",
  "itemType",
  "source",
  "senderAgentId",
  "replyToMessageId",
  "attachments",
  "imageGeneration",
  "questionPrompt",
  "reaction",
  "reactions",
] as const satisfies readonly (keyof ConversationMessage)[];

/**
 * The fields that the projection copies into a new object. A change inside them does not change
 * their reference, so they are compared by value.
 */
const DERIVED_FIELDS = [
  "senderMember",
  "delivery",
  "exchange",
  "routine",
  "plan",
] as const satisfies readonly (keyof ConversationMessage)[];

interface MessageSnapshot {
  context: string;
  fields: unknown[];
  derived: (string | undefined)[];
}

function snapshotMessage(message: ConversationMessage, context: string): MessageSnapshot {
  return {
    context,
    fields: PROJECTED_FIELDS.map((field) => message[field]),
    derived: DERIVED_FIELDS.map((field) => {
      const value = message[field];
      return value === undefined ? undefined : JSON.stringify(value);
    }),
  };
}

function snapshotsMatch(left: MessageSnapshot, right: MessageSnapshot): boolean {
  return (
    left.context === right.context &&
    left.fields.every((value, index) => value === right.fields[index]) &&
    left.derived.every((value, index) => value === right.derived[index])
  );
}

export interface MessageProjectionCache {
  message: (message: ConversationMessage, ownerAgentId: string | undefined) => AgentMessage;
  thinking: (key: string, first: ConversationMessage, members: readonly ConversationMessage[]) => AgentMessage;
}

/**
 * `toAgentMessages` that keeps the object of a message whose source did not change. A row that
 * reads the object then does not run again when only the message that streams has a new delta.
 * The output is the same as `toAgentMessages`: a message is made again when a field it reads, the
 * interface language, the day, or the owner changed.
 *
 * It keys the cache on the source object, so a store that keeps its items (as a Solid store does)
 * gets the reuse, and a page that a read replaced is made again whole.
 */
export function createMessageProjector(): (
  messages: readonly ConversationMessage[],
  ownerAgentId?: string,
) => AgentMessage[] {
  const entries = new WeakMap<ConversationMessage, { snapshot: MessageSnapshot; value: AgentMessage }>();
  let thinkingEntries = new Map<
    string,
    { members: ConversationMessage[]; snapshots: MessageSnapshot[]; value: AgentMessage }
  >();
  return (messages, ownerAgentId) => {
    const context = projectionContext(ownerAgentId);
    const nextThinking: typeof thinkingEntries = new Map();
    const cache: MessageProjectionCache = {
      message(message, owner) {
        const snapshot = snapshotMessage(message, context);
        const cached = entries.get(message);
        if (cached && snapshotsMatch(cached.snapshot, snapshot)) return cached.value;
        const value = toAgentMessage(message, owner);
        entries.set(message, { snapshot, value });
        return value;
      },
      thinking(key, first, members) {
        const snapshots = members.map((member) => snapshotMessage(member, context));
        const cached = thinkingEntries.get(key);
        const reusable =
          cached &&
          cached.members.length === members.length &&
          cached.members.every((member, index) => member === members[index]) &&
          cached.snapshots.every((snapshot, index) => {
            const next = snapshots[index];
            return next !== undefined && snapshotsMatch(snapshot, next);
          });
        const value = reusable ? cached.value : thinkingMessage(key, first, members);
        nextThinking.set(key, { members: [...members], snapshots, value });
        return value;
      },
    };
    const result = projectMessages(messages, ownerAgentId, cache);
    thinkingEntries = nextThinking;
    return result;
  };
}

/** The stored wake-up of an event check. It carries no text of its own and draws no row. */
export function isEventCheckMarkerMessage(message: AgentMessage): boolean {
  return message.actionMarker?.kind === "event-check";
}

/** A message that draws a bubble of the agent: the rows that can carry the chip. */
function carriesEventCheckOrigin(message: AgentMessage): boolean {
  return (
    message.author === "agent" &&
    (message.kind === undefined || message.kind === "text") &&
    !message.actionMarker &&
    !message.questionPrompt &&
    !message.plan &&
    !message.id.startsWith("ui-") &&
    chatVisualReply(message) === null &&
    !silentAgentAnswer(message)
  );
}

/** Output of the agent, drawn or not. It shows that a turn already ran before a marker. */
function isAgentOutput(message: AgentMessage): boolean {
  return message.author === "agent" && !message.actionMarker && !message.id.startsWith("ui-");
}

/** A message the person wrote that the agent read. One cancelled in the queue never reached it. */
function isPersonPrompt(message: AgentMessage): boolean {
  return message.author === "you" && message.cancelled !== true;
}

/** A prompt that the agent did not get from the person or an event check, and that starts a turn. */
function startsOtherTurn(message: AgentMessage): boolean {
  return message.exchange?.direction === "incoming" || message.routine !== undefined;
}

/** What one row means for the event check scans. Read once per row, not once per marker. */
interface EventCheckRow {
  turnId: string | undefined;
  marker: boolean;
  /** A message of the person that the agent read. */
  person: boolean;
  /** A message that draws a bubble of the agent: the rows that can carry the chip. */
  carrier: boolean;
  /** A prompt that the agent did not get from the person or an event check, and that starts a turn. */
  startsOther: boolean;
  /** Output of the agent, drawn or not. It shows that a turn already ran before a marker. */
  output: boolean;
}

function eventCheckRow(message: AgentMessage): EventCheckRow {
  return {
    turnId: message.turnId,
    marker: isEventCheckMarkerMessage(message),
    person: isPersonPrompt(message),
    carrier: carriesEventCheckOrigin(message),
    startsOther: startsOtherTurn(message),
    output: isAgentOutput(message),
  };
}

/**
 * Whether the turn of a marker was already running when its event arrived: an earlier message of
 * the same turn exists, an agent message, a message of the person, or another event check. The
 * marker then sits in the middle of that turn. It needs a turn id on the marker.
 */
function arrivedInRunningTurn(rows: readonly EventCheckRow[], markerIndex: number, turn: string): boolean {
  for (let index = markerIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.turnId === undefined) continue;
    const prompt = row.person || row.marker;
    if (row.turnId === turn) {
      if (prompt || row.output) return true;
      continue;
    }
    // Another turn is behind this one: nothing before it can belong to this turn.
    if (prompt || row.output) return false;
  }
  return false;
}

interface EventCheckInteraction {
  first: number;
  last: number;
  /** The person wrote in the turn, or another event reached it, before its last agent message. */
  interrupted: boolean;
  /** The turn is not over, so its last message is not known yet. */
  open: boolean;
}

const NONE = Number.POSITIVE_INFINITY;

/** The first entry of an ascending list that is greater than `index`, or `NONE`. */
function firstAfter(list: readonly number[] | undefined, index: number): number {
  if (!list) return NONE;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((list[middle] ?? NONE) > index) high = middle;
    else low = middle + 1;
  }
  return list[low] ?? NONE;
}

/** The last entry of an ascending list that is less than `bound`, or -1. */
function lastBefore(list: readonly number[] | undefined, bound: number): number {
  if (!list) return -1;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((list[middle] ?? NONE) < bound) low = middle + 1;
    else high = middle;
  }
  return list[low - 1] ?? -1;
}

function pushTo<Key>(map: Map<Key, number[]>, key: Key, index: number): void {
  const list = map.get(key);
  if (list) list.push(index);
  else map.set(key, [index]);
}

/**
 * The rows of one list, indexed once so that the interaction of each marker costs a few binary
 * searches instead of a scan to the end of the list. A scan for a marker that has no answer yet,
 * for example one whose answers were silent, used to read every row behind it.
 */
class EventCheckIndex {
  readonly rows: EventCheckRow[];
  private readonly markersByTurn = new Map<string, number[]>();
  private readonly carriersByTurn = new Map<string, number[]>();
  private readonly personsByTurn = new Map<string, number[]>();
  private readonly carriersWithoutTurn: number[] = [];
  private readonly personsWithoutTurn: number[] = [];
  /** Rows that are foreign to a marker of another turn: every marker, and a person or carrier with a turn. */
  private readonly foreignIndex: number[] = [];
  private readonly foreignTurn: Array<string | undefined> = [];
  /** For each entry of the list above, the position of the first later entry of another turn. */
  private readonly foreignRunEnd: number[] = [];

  constructor(messages: readonly AgentMessage[]) {
    this.rows = messages.map(eventCheckRow);
    this.rows.forEach((row, index) => {
      const { turnId } = row;
      if (row.marker) {
        if (turnId !== undefined) pushTo(this.markersByTurn, turnId, index);
        this.foreignIndex.push(index);
        this.foreignTurn.push(turnId);
      } else if (row.person) {
        if (turnId === undefined) this.personsWithoutTurn.push(index);
        else {
          pushTo(this.personsByTurn, turnId, index);
          this.foreignIndex.push(index);
          this.foreignTurn.push(turnId);
        }
      } else if (row.carrier) {
        if (turnId === undefined) this.carriersWithoutTurn.push(index);
        else {
          pushTo(this.carriersByTurn, turnId, index);
          this.foreignIndex.push(index);
          this.foreignTurn.push(turnId);
        }
      }
    });
    const count = this.foreignIndex.length;
    for (let position = count - 1; position >= 0; position -= 1) {
      const next = position + 1;
      this.foreignRunEnd[position] =
        next < count && this.foreignTurn[next] !== this.foreignTurn[position]
          ? next
          : (this.foreignRunEnd[next] ?? count);
    }
  }

  /** The first row after `index` that is foreign to `turn`: it ends the interaction of that turn. */
  firstForeignAfter(index: number, turn: string): number {
    let low = 0;
    let high = this.foreignIndex.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.foreignIndex[middle] ?? NONE) > index) high = middle;
      else low = middle + 1;
    }
    if (low >= this.foreignIndex.length) return NONE;
    if (this.foreignTurn[low] !== turn) return this.foreignIndex[low] ?? NONE;
    const end = this.foreignRunEnd[low] ?? this.foreignIndex.length;
    return this.foreignIndex[end] ?? NONE;
  }

  /**
   * The messages that answer a marker that has a turn id: those of its turn, and those with no
   * turn id that no row of another turn came before.
   */
  interactionOfTurn(
    markerIndex: number,
    turn: string,
    activeTurnId: string | null | undefined,
    messages: readonly AgentMessage[],
  ): EventCheckInteraction | null {
    // Another event check of the same turn owns the messages from its place on.
    const stop = firstAfter(this.markersByTurn.get(turn), markerIndex);
    const foreign = this.firstForeignAfter(markerIndex, turn);
    const ofTurn = firstAfter(this.carriersByTurn.get(turn), markerIndex);
    const withoutTurn = firstAfter(this.carriersWithoutTurn, markerIndex);
    let first = NONE;
    if (ofTurn < stop) first = ofTurn;
    if (withoutTurn < stop && withoutTurn < foreign && withoutTurn < first) first = withoutTurn;
    if (first === NONE) return null;
    // A row of another turn before the first message makes the messages with no turn id foreign.
    const foreignBeforeFirst = foreign < first;
    const end = this.firstForeignAfter(first, turn);
    const interruptedByEvent = stop < end;
    const limit = Math.min(end, stop);
    let last = first;
    const lastOfTurn = lastBefore(this.carriersByTurn.get(turn), limit);
    if (lastOfTurn > last) last = lastOfTurn;
    if (!foreignBeforeFirst) {
      const lastWithoutTurn = lastBefore(this.carriersWithoutTurn, limit);
      if (lastWithoutTurn > last) last = lastWithoutTurn;
    }
    const personWrote = Math.min(
      firstAfter(this.personsByTurn.get(turn), markerIndex),
      firstAfter(this.personsWithoutTurn, markerIndex),
    );
    const interrupted = interruptedByEvent || personWrote < last;
    const lastRow = messages[last];
    const open = lastRow?.streaming === true || activeTurnId === turn;
    return { first, last, interrupted, open };
  }

  /**
   * The same for a marker whose delivery has not started, so it has no turn id. The interaction
   * runs until the next message of the person, the next event check, or the next prompt that is
   * not theirs, so the scan is short.
   */
  interactionByOrder(
    markerIndex: number,
    activeTurnId: string | null | undefined,
    messages: readonly AgentMessage[],
  ): EventCheckInteraction | null {
    let turn: string | undefined;
    let first = -1;
    let last = -1;
    let interrupted = false;
    let personWrote = false;
    // A message of another turn came first, so a message without a turn id cannot be attributed.
    let foreignSeen = false;
    for (let index = markerIndex + 1; index < this.rows.length; index += 1) {
      const row = this.rows[index];
      if (!row) continue;
      if (row.marker) {
        if (turn === undefined) break;
        if (row.turnId === turn) {
          if (first >= 0) interrupted = true;
          break;
        }
        if (first >= 0) break;
        foreignSeen = true;
        continue;
      }
      if (row.person) {
        if (turn === undefined) break;
        if (row.turnId === undefined || row.turnId === turn) {
          personWrote = true;
          continue;
        }
        if (first >= 0) break;
        foreignSeen = true;
        continue;
      }
      if (turn === undefined && row.startsOther) break;
      if (!row.carrier) continue;
      if (turn === undefined) turn = row.turnId;
      else if (row.turnId === undefined) {
        if (foreignSeen) continue;
      } else if (row.turnId !== turn) {
        if (first >= 0) break;
        foreignSeen = true;
        continue;
      }
      if (first < 0) first = index;
      last = index;
      if (personWrote) interrupted = true;
    }
    if (first < 0) return null;
    const lastRow = messages[last];
    const open = lastRow?.streaming === true || (turn !== undefined && activeTurnId === turn);
    return { first, last, interrupted, open };
  }
}

/**
 * Which messages carry the chip of an event check, by message id.
 *
 * An event check writes a marker message into the chat when it wakes the agent. The marker draws no
 * row. The agent messages of the interaction carry its name instead: the first one, and the last
 * one once the turn is over. When the person writes in the turn, or the event reaches a turn that
 * already runs, only the first agent message carries it, because the turn is no longer the answer
 * to this event alone. A marker with no agent message yet carries nothing: the chip appears with
 * the first one, a streaming message included.
 *
 * It reads the whole ordered list, because the first and last message need look-ahead, and it
 * returns a map so a message that streams is never copied: the timeline passes the entry to the row.
 */
export function eventCheckOrigins(
  messages: readonly AgentMessage[],
  options: { activeTurnId?: string | null | undefined } = {},
): Map<string, MessageEventCheckOrigin> {
  const origins = new Map<string, MessageEventCheckOrigin>();
  if (!messages.some(isEventCheckMarkerMessage)) return origins;
  const index = new EventCheckIndex(messages);
  messages.forEach((marker, markerIndex) => {
    const model = marker.actionMarker;
    if (model?.kind !== "event-check") return;
    const turn = marker.turnId;
    // A delivery that has not started while another turn runs: that turn's output is not its answer.
    if (turn === undefined && options.activeTurnId != null) return;
    const interaction =
      turn === undefined
        ? index.interactionByOrder(markerIndex, options.activeTurnId, messages)
        : index.interactionOfTurn(markerIndex, turn, options.activeTurnId, messages);
    if (!interaction) return;
    const firstMessage = messages[interaction.first];
    if (!firstMessage) return;
    const origin = (position: MessageEventCheckOrigin["position"]): MessageEventCheckOrigin => ({
      name: model.name,
      checkId: model.checkId,
      timestamp: model.timestamp,
      position,
    });
    const midTurn = turn !== undefined && arrivedInRunningTurn(index.rows, markerIndex, turn);
    if (midTurn || interaction.interrupted) {
      origins.set(firstMessage.id, origin("only"));
      return;
    }
    if (interaction.open) {
      origins.set(firstMessage.id, origin("start"));
      return;
    }
    if (interaction.first === interaction.last) {
      origins.set(firstMessage.id, origin("only"));
      return;
    }
    origins.set(firstMessage.id, origin("start"));
    const lastMessage = messages[interaction.last];
    if (lastMessage) origins.set(lastMessage.id, origin("end"));
  });
  return origins;
}

/** Whether two results name the same chips, so a streamed token does not redraw them. */
export function eventCheckOriginsEqual(
  left: ReadonlyMap<string, MessageEventCheckOrigin>,
  right: ReadonlyMap<string, MessageEventCheckOrigin>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, origin] of left) {
    const other = right.get(id);
    if (
      !other ||
      other.name !== origin.name ||
      other.checkId !== origin.checkId ||
      other.timestamp !== origin.timestamp ||
      other.position !== origin.position
    )
      return false;
  }
  return true;
}

export function agentProfilesEqual(left: AgentProfile, right: AgentProfile): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.title === right.title &&
    left.description === right.description &&
    left.notifications === right.notifications &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.access === right.access &&
    left.computerUse === right.computerUse &&
    left.threadId === right.threadId &&
    left.avatarSeed === right.avatarSeed &&
    left.avatarHue === right.avatarHue &&
    left.avatarUrl === right.avatarUrl &&
    marketplaceSourcesEqual(left.marketplaceSource, right.marketplaceSource) &&
    left.updatedAt === right.updatedAt &&
    left.time === right.time &&
    left.preview === right.preview
  );
}

function marketplaceSourcesEqual(
  left: AgentProfile["marketplaceSource"],
  right: AgentProfile["marketplaceSource"],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.listingId === right.listingId &&
    left.versionId === right.versionId &&
    left.version === right.version &&
    stringArraysEqual(left.skillIds, right.skillIds) &&
    stringArraysEqual(left.routineIds, right.routineIds)
  );
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function agentMessagesEqual(left: AgentMessage, right: AgentMessage): boolean {
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.author === right.author &&
    left.body === right.body &&
    left.time === right.time &&
    left.kind === right.kind &&
    left.streaming === right.streaming &&
    left.itemType === right.itemType &&
    left.status === right.status &&
    left.senderAgentId === right.senderAgentId &&
    left.senderMember?.id === right.senderMember?.id &&
    left.senderMember?.name === right.senderMember?.name &&
    left.replyToMessageId === right.replyToMessageId &&
    left.cancelled === right.cancelled &&
    left.reaction === right.reaction &&
    JSON.stringify(left.reactions) === JSON.stringify(right.reactions) &&
    JSON.stringify(left.reactionSummary) === JSON.stringify(right.reactionSummary) &&
    JSON.stringify(left.attachments) === JSON.stringify(right.attachments) &&
    JSON.stringify(left.questionPrompt) === JSON.stringify(right.questionPrompt) &&
    JSON.stringify(left.exchange) === JSON.stringify(right.exchange) &&
    JSON.stringify(left.routine) === JSON.stringify(right.routine) &&
    JSON.stringify(left.actionMarker) === JSON.stringify(right.actionMarker) &&
    JSON.stringify(left.items) === JSON.stringify(right.items) &&
    JSON.stringify(left.itemIds) === JSON.stringify(right.itemIds) &&
    JSON.stringify(left.plan) === JSON.stringify(right.plan)
  );
}

function chatActionMarker(
  message: ConversationMessage,
  ownerAgentId: string | undefined,
  routineEvent: ReturnType<typeof routineConversationEvent>,
  routineRunEvent: ReturnType<typeof routineRunConversationEvent>,
  hostedSiteEvent: ReturnType<typeof hostedSiteConversationEvent>,
): ChatActionMarkerModel | null {
  if (message.itemType?.startsWith(EVENT_CHECK_ITEM_TYPE_PREFIX))
    return {
      kind: "event-check",
      name: message.text,
      checkId: message.itemType.slice(EVENT_CHECK_ITEM_TYPE_PREFIX.length).split(":")[0] ?? "",
      timestamp: message.createdAt,
    };
  if (message.exchange) {
    const targetDeliveries = message.exchange.deliveries.map((delivery) => ({
      agentId: delivery.recipientAgentId,
      status: delivery.status,
    }));
    const status =
      message.exchange.direction === "incoming"
        ? deliveryStatus(message.delivery?.status ?? targetDeliveries[0]?.status)
        : aggregateDeliveryStatus(targetDeliveries.map((delivery) => delivery.status));
    return {
      kind: "agent-message",
      direction: message.exchange.direction,
      sourceAgentId: message.exchange.senderAgentId,
      targetDeliveries,
      status,
      timestamp: message.createdAt,
      messageId: message.exchange.messageId,
      replyToMessageId: message.exchange.replyToMessageId,
      expectsReply: message.exchange.expectsReply !== false,
    };
  }
  if (isContextResetMarker(message)) return { kind: "context-reset", timestamp: message.createdAt };
  const skillEvent = skillConversationEvent(message);
  if (skillEvent) return { ...skillEvent, kind: "skill-lifecycle", timestamp: message.createdAt };
  const suggestion = marketplaceSuggestionEvent(message);
  if (suggestion) return { kind: "marketplace-suggestion", appId: suggestion.appId, timestamp: message.createdAt };
  if (routineEvent) {
    return {
      kind: "routine-lifecycle",
      action: routineEvent.action,
      sourceAgentId: ownerAgentId ?? null,
      routineId: routineEvent.routineId,
      routineName: routineEvent.routineName,
      status: "completed",
      timestamp: message.createdAt,
    };
  }
  if (routineRunEvent) {
    return {
      kind: "routine-run",
      sourceAgentId: ownerAgentId ?? null,
      routineId: routineRunEvent.routineId,
      runId: routineRunEvent.runId,
      routineName: routineRunEvent.routineName,
      status: routineRunEvent.status,
      timestamp: message.createdAt,
    };
  }
  if (message.routine) {
    return {
      kind: "routine-run",
      sourceAgentId: ownerAgentId ?? null,
      routineId: message.routine.routineId,
      runId: message.routine.runId,
      routineName: message.routine.name,
      status: "queued",
      timestamp: message.createdAt,
    };
  }
  if (hostedSiteEvent) {
    return {
      kind: "hosted-site",
      sourceAgentId: ownerAgentId ?? null,
      action: hostedSiteEvent.action,
      status: hostedSiteEvent.status,
      operationId: hostedSiteEvent.operationId,
      siteId: hostedSiteEvent.siteId,
      title: hostedSiteEvent.title,
      hostname: hostedSiteEvent.hostname,
      url: hostedSiteEvent.url,
      timestamp: message.createdAt,
    };
  }
  if (isRoutineEventItem(message)) {
    return { kind: "unavailable", label: currentText().t("app.action.unavailable"), timestamp: message.createdAt };
  }
  return null;
}

function aggregateDeliveryStatus(statuses: QueueDeliveryStatus[]): AgentDeliveryMarkerStatus {
  if (statuses.length === 0) return "unavailable";
  const normalized = statuses.map(deliveryStatus);
  if (normalized.every((status) => status === "queued")) return "queued";
  if (normalized.some((status) => status === "in-progress")) return "in-progress";
  if (normalized.every((status) => status === "completed")) return "completed";
  if (normalized.every((status) => status === "failed")) return "failed";
  if (normalized.every((status) => status === "interrupted")) return "interrupted";
  if (normalized.every((status) => status === "cancelled")) return "cancelled";
  if (normalized.every((status) => ["completed", "failed", "interrupted", "cancelled"].includes(status))) {
    return "partial";
  }
  return "in-progress";
}

function deliveryStatus(status: QueueDeliveryStatus | undefined): Exclude<AgentDeliveryMarkerStatus, "partial"> {
  if (!status) return "unavailable";
  if (status === "starting" || status === "running") return "in-progress";
  return status;
}

export function retainThinkingMessages(previous: AgentMessage[], next: AgentMessage[]): AgentMessage[] {
  const result = [...next];
  const nextIds = new Set(result.map((message) => message.id));
  for (const thinking of previous) {
    if (thinking.kind !== "thinking" || nextIds.has(thinking.id) || !thinking.turnId) continue;
    const sameTurnIndexes = result.flatMap((message, index) => (message.turnId === thinking.turnId ? [index] : []));
    if (sameTurnIndexes.length === 0) continue;
    const finalAnswerIndex = result.findIndex(
      (message) => message.turnId === thinking.turnId && message.author === "agent" && message.kind !== "thinking",
    );
    const insertionIndex = finalAnswerIndex >= 0 ? finalAnswerIndex : (sameTurnIndexes.at(-1) ?? result.length - 1) + 1;
    result.splice(insertionIndex, 0, { ...thinking, streaming: false });
    nextIds.add(thinking.id);
  }
  return result;
}

export function withoutAgent<T>(values: Record<string, T>, agentId: string): Record<string, T> {
  const next = { ...values };
  delete next[agentId];
  return next;
}

function cleanPreview(preview: string): string {
  // The stored preview is the start of the message as written, Markdown and all.
  const cleaned = markdownPreviewText(cleanAgentMessageText(preview))
    .replace(/\binbox\s+at\s+zero\b[:,]?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || currentText().t("app.agent.noMessages");
}

function formatTime(value: string): string {
  const date = new Date(value);
  const { t, format } = currentText();
  if (Number.isNaN(date.getTime())) return t("chat.day.now");
  return format.date(date, { hour: "2-digit", minute: "2-digit" });
}

export function formatMessageTime(value: string): string {
  const date = new Date(value);
  const { t, format } = currentText();
  if (Number.isNaN(date.getTime())) return t("chat.day.now");
  return formatChatTimestamp(date, format);
}
