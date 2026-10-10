/*
 * The channel transcript as rows, away from the component that draws it.
 *
 * A channel message carries an author of its own kind, a sequence number and a status. A row of the
 * shared chat needs an `AgentMessage`, an author with a profile, and the answers to three questions
 * the reader sees: does this row repeat the name above it, does a new day start here, and where does
 * the unread part of the channel begin. All of that is a function of the page, so it is here and it
 * is tested as data.
 */

import type { ChannelMessage, ChannelPage } from "@openbot/contracts/ipc";
import { channelRoutingConversationEvent } from "@openbot/contracts/ipc";
import type { AppTranslate } from "@openbot/i18n";
import { cleanAgentMessageText } from "@openbot/team-client/agent-message-text";
import type { AgentMessage, AgentProfile, ChatActionMarkerModel } from "@openbot/ui/data";
import type { ChatMessageAuthor } from "@openbot/ui/features/conversation/ChatMessageRow";
import { type DayMarkerOptions, dayMarkerLabel } from "@openbot/ui/features/conversation/chat-day-markers";
import { currentText } from "@openbot/ui/text";
import { messagePlan } from "../../app-message-projection";
import { withinGroupingWindow } from "../conversation/chat-grouping";

export interface ChannelTimelineEntry {
  id: string;
  sequence: number;
  authorId: string;
  author: ChatMessageAuthor;
  message: AgentMessage;
  /** False while the row continues a run by the same author: the run reads as one block. */
  showAuthor: boolean;
  /** The separator above the row, or `null` when the row stays on the day above it. */
  dayMarker: string | null;
  /** The task changed after this answer, so a later answer takes its place. The row stays, muted. */
  superseded: boolean;
  /** The first message of the row. A row of reasoning holds several; this is the first of them. */
  source: ChannelMessage;
}

/** The id of a routine that wrote into the channel. Its author is a routine, not a person. */
const ROUTINE_AUTHOR_PREFIX = "routine:";

/** A row with no text, no attachment and no question has nothing to draw. */
function hasContent(entry: ChannelMessage): boolean {
  return Boolean(entry.message.text.trim() || entry.message.attachments?.length || entry.message.questionPrompt);
}

/**
 * The routing receipt of a channel as an activity row, or `null` for an ordinary message.
 *
 * A receipt reads like the "Messaged" and "Created routine" markers of a one-to-one chat: it is
 * feedback about how the work was shared, so it carries no bubble, no author face and no message
 * actions, and it does not count as a new message.
 */
function channelRoutingMarker(entry: ChannelMessage): ChatActionMarkerModel | null {
  const event = channelRoutingConversationEvent(entry.message);
  return event ? { ...event, kind: "channel-routing", timestamp: entry.message.createdAt } : null;
}

/**
 * What the model said while it worked. The agent chat draws it as a Thinking row, and so does a
 * channel, so the work of a turn does not read as a series of answers.
 */
function isCommentary(entry: ChannelMessage): boolean {
  return entry.message.author === "assistant" && entry.message.itemType === "commentary";
}

function toAgentMessage(entry: ChannelMessage, own: boolean, options: DayMarkerOptions): AgentMessage {
  const message = entry.message;
  const actionMarker = channelRoutingMarker(entry);
  const commentary = !actionMarker && isCommentary(entry);
  const plan = actionMarker || commentary ? null : messagePlan(message);
  const time = { hour: "numeric", minute: "2-digit" } as const;
  const createdAt = new Date(message.createdAt);
  return {
    id: entry.id,
    author: own ? "you" : "agent",
    ...(actionMarker ? { kind: "action-marker" as const, actionMarker } : {}),
    ...(plan ? { kind: "plan" as const, plan } : {}),
    ...(commentary
      ? { kind: "thinking" as const, items: [cleanAgentMessageText(message.text)], itemIds: [entry.id] }
      : {}),
    body: commentary ? "" : message.text,
    // Intl throws on an invalid date, where `toLocaleTimeString` returns text.
    time:
      options.format && !Number.isNaN(createdAt.getTime())
        ? options.format.date(createdAt, time)
        : createdAt.toLocaleTimeString(options.locale, time),
    createdAt: message.createdAt,
    streaming: message.status === "streaming",
    status: message.status,
    itemType: message.itemType,
    senderAgentId: message.senderAgentId,
    replyToMessageId: message.replyToMessageId,
    attachments: message.attachments,
    imageGeneration: message.imageGeneration,
    questionPrompt: message.questionPrompt,
    turnId: message.turnId,
  };
}

/**
 * Who a row draws as.
 *
 * Another person of the team draws as a member, the way the agent chat draws them: their name, and
 * a face that follows their id. A routine that wrote into the channel is an author with a name and
 * a `routine:` id; it keeps the agent look, so it does not read as a person. A name that is gone
 * falls back to a word, never to an id.
 */
function channelRowAuthor(
  source: ChannelMessage,
  own: boolean,
  agent: AgentProfile | undefined,
  t: AppTranslate,
): ChatMessageAuthor {
  if (own) return { kind: "you", name: t("chat.message.you") };
  const { author } = source;
  const storedName = author.name.trim();
  if (author.kind === "member" && !author.id.startsWith(ROUTINE_AUTHOR_PREFIX)) {
    return { kind: "member", name: storedName || t("chat.message.memberFallback"), avatarSeed: author.id };
  }
  return {
    kind: "agent",
    name: agent?.name ?? (storedName || t("channel.members.former")),
    agent,
    avatarSeed: agent ? undefined : author.id,
  };
}

/**
 * The rows of one channel page.
 *
 * `isOwnMessage` answers for the reader alone: a member id is the signed-in person or another
 * person of the team, and only the first stands on the right. A coordinator is an author with a
 * name, so it draws as an agent. An author the agent list no longer holds keeps its stored name and
 * seeds its face from its id, so two deleted agents do not share one face.
 */
export function channelTimelineEntries(
  page: ChannelPage,
  agents: AgentProfile[],
  isOwnMessage: (authorId: string) => boolean,
  options: DayMarkerOptions = {},
): ChannelTimelineEntry[] {
  const entries: ChannelTimelineEntry[] = [];
  const t = options.t ?? currentText().t;
  let previous: ChannelTimelineEntry | undefined;
  // A run of one author is broken by an activity row the same way a reply from someone else breaks
  // it: the marker draws no name, so the message under it has to show its own again.
  let previousAuthored: ChannelTimelineEntry | undefined;
  for (const source of page.messages) {
    if (!hasContent(source)) continue;
    const thinking = channelRoutingMarker(source) === null && isCommentary(source);
    // Reasoning that follows reasoning of the same author is one row: it holds every step.
    if (thinking && previous?.message.kind === "thinking" && previous.authorId === source.author.id) {
      previous.message.items = [...(previous.message.items ?? []), cleanAgentMessageText(source.message.text)];
      previous.message.itemIds = [...(previous.message.itemIds ?? []), source.id];
      previous.message.streaming = previous.message.streaming === true || source.message.status === "streaming";
      continue;
    }
    const own = source.author.kind === "member" && isOwnMessage(source.author.id);
    const agent = agents.find((candidate) => candidate.id === source.author.id);
    const author = channelRowAuthor(source, own, agent, t);
    const dayMarker = dayMarkerLabel(previous?.message.createdAt, source.message.createdAt, options);
    const marker = channelRoutingMarker(source);
    const sameAuthor =
      previousAuthored !== undefined && previousAuthored === previous && previousAuthored.authorId === source.author.id;
    const withinWindow = withinGroupingWindow(previousAuthored?.message.createdAt, source.message.createdAt);
    const entry: ChannelTimelineEntry = {
      id: source.id,
      sequence: source.sequence,
      authorId: source.author.id,
      author,
      message: toAgentMessage(source, own, options),
      showAuthor: marker === null && !thinking && !(sameAuthor && withinWindow && dayMarker === null),
      dayMarker,
      superseded: source.superseded,
      source,
    };
    entries.push(entry);
    previous = entry;
    if (marker === null && !thinking) previousAuthored = entry;
  }
  return entries;
}

/**
 * The row the unread divider stands on, or `null` when the reader has seen everything.
 *
 * The count comes from the channel list, and it leaves out what the reader wrote, so the walk back
 * through the rows leaves it out too. The page carries no read pointer of its own: its
 * `throughSequence` is the newest message of the channel, not the newest the reader has seen.
 */
export function firstUnreadChannelMessageId(entries: ChannelTimelineEntry[], unreadCount: number): string | null {
  if (unreadCount <= 0) return null;
  let remaining = unreadCount;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    // The count from the channel list leaves out activity rows, plans and reasoning, so the walk
    // back leaves them out.
    if (
      entry.author.kind === "you" ||
      entry.message.actionMarker ||
      entry.message.kind === "plan" ||
      entry.message.kind === "thinking"
    )
      continue;
    remaining -= 1;
    if (remaining === 0) return entry.id;
  }
  return entries[0]?.id ?? null;
}
