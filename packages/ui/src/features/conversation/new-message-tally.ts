/*
 * How many messages arrived below the reader, away from the components that draw the count.
 *
 * A chat that is open and focused marks its messages read as they arrive, so the unread count a
 * conversation carries stays at zero however far the reader scrolled up. The pill above the
 * composer needs the other number: what came in since the reader left the bottom. That is a
 * function of the ids the timeline holds and whether the view still follows the newest message,
 * so it is here and it is tested as data.
 */

import { ROUTINE_QUIET_ANSWER_ITEM_TYPE } from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";

export interface TimelineRow {
  id: string;
  /** Whether the reader would call this row a new message. */
  countable: boolean;
}

export interface NewMessageTally {
  count: number;
  /** The last id the reader has accounted for. `undefined` before the first page arrives. */
  anchorId: string | undefined;
  /** Every id the reader has accounted for. A row with another id arrived since. */
  seen?: ReadonlySet<string>;
}

/** The reader has seen everything: no count, and the newest row becomes the anchor. */
export function anchorNewMessages(rows: readonly TimelineRow[]): NewMessageTally {
  return { count: 0, anchorId: rows.at(-1)?.id, seen: new Set(rows.map((row) => row.id)) };
}

/**
 * The tally after a timeline change.
 *
 * Every row anchors, including the rows that never count. A reader who opened a thread, wrote a
 * prompt and scrolled up has nothing countable behind them, and an anchor drawn from countable
 * rows alone would be missing: the first reply would then read as the first page of a thread and
 * count nothing.
 *
 * A new row does not always come last. The answer of a turn goes with its turn, above a marker that
 * came while the turn ran, so a row counts when its id is new and it comes after the first row the
 * reader had. An older page only puts rows before that one.
 *
 * `following` is whether the view still sticks to the newest message. It has to be read at the
 * moment the messages change, not after the frame that scrolls the view: by then every arrival
 * would look like one the reader watched.
 */
export function tallyNewMessages(
  previous: NewMessageTally,
  rows: readonly TimelineRow[],
  following: boolean,
): NewMessageTally {
  if (following) return anchorNewMessages(rows);
  const latest = rows[rows.length - 1];
  if (!latest) return { count: 0, anchorId: undefined };
  const latestId = latest.id;
  const seen = previous.seen ?? new Set(previous.anchorId === undefined ? [] : [previous.anchorId]);
  const firstKnown = rows.findIndex((row) => seen.has(row.id));
  const accounted = new Set(rows.map((row) => row.id));
  /*
   * Nothing here says what arrived, so the count stands: no known row is left because the
   * messages were deleted, because a page scrolled out of the window, or because this is the first
   * page of a thread the reader just opened, and none of those is news.
   */
  if (firstKnown < 0) return { count: previous.count, anchorId: latestId, seen: accounted };
  let arrived = 0;
  // A body that grows while it streams, and an older page that only prepends, both add nothing.
  for (let index = firstKnown + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.countable && !seen.has(row.id)) arrived += 1;
  }
  return { count: previous.count + arrived, anchorId: latestId, seen: accounted };
}

/** Rows the reader would call a new message. */
export function countableTimelineMessage(message: AgentMessage): boolean {
  if (message.author === "you") return false;
  if (
    message.kind === "thinking" ||
    message.kind === "plan" ||
    message.kind === "subagents" ||
    message.kind === "memory-changes"
  )
    return false;
  if (silentAgentAnswer(message)) return false;
  // A quiet routine run tells the user nothing new. Its answers show only when the reader opens the run.
  if (message.itemType === ROUTINE_QUIET_ANSWER_ITEM_TYPE) return false;
  // A routine notice or a lifecycle marker carries no message of its own.
  if (message.actionMarker && !message.exchange) return false;
  return true;
}

/**
 * A finished agent answer with nothing to draw. An agent ends a turn with no text when it has
 * nothing to tell the user, for example after a teammate update that needs no reply. The row stays
 * in the conversation, so read state still reaches it, but the timeline shows no empty bubble.
 */
export function silentAgentAnswer(message: AgentMessage): boolean {
  return (
    message.author === "agent" &&
    (message.kind ?? "text") === "text" &&
    !message.streaming &&
    !message.status &&
    !message.actionMarker &&
    !message.questionPrompt &&
    !message.imageGeneration &&
    !message.attachments?.length &&
    !message.reactions?.length &&
    !message.body.trim()
  );
}
