import type { AgentMessage, AgentMessageMarkerModel } from "@openbot/ui/data";
import { dayMarkerLabel } from "@openbot/ui/features/conversation/chat-day-markers";

interface AgentMessageRow {
  message: AgentMessage;
  marker: AgentMessageMarkerModel;
}

interface AgentMessageGroupOptions {
  /**
   * The person switched messages between agents off. Every message is still reachable, and a run is
   * one collapsed row. An incoming message with files joins its run, or is a group of one, so the
   * chat draws no card of its files: they are in the peek.
   */
  collapsed?: boolean | undefined;
}

/**
 * Joins consecutive messages to and from other agents into one row, so a long exchange between
 * agents does not fill the chat. The row keeps the id of the first message, so it stays the same row
 * while the exchange grows. The stored messages stay unchanged.
 *
 * A run stops at the first unread message and at a new day, so the unread divider and the day
 * separator keep a row of their own.
 */
export function groupAgentMessageMarkers(
  messages: readonly AgentMessage[],
  firstUnreadMessageId?: string | null,
  options: AgentMessageGroupOptions = {},
): AgentMessage[] {
  const collapsed = options.collapsed === true;
  const rows: AgentMessage[] = [];
  let run: AgentMessageRow[] = [];
  const closeRun = () => {
    const first = run[0];
    const last = run.at(-1);
    if (first && last) {
      rows.push(
        run.length === 1 && !(collapsed && drawsAttachments(first.message))
          ? first.message
          : {
              ...first.message,
              actionMarker: {
                kind: "agent-message-group",
                messages: run.map((row) => ({ id: row.message.id, marker: row.marker })),
                timestamp: last.marker.timestamp,
              },
            },
      );
    }
    run = [];
  };

  for (const message of messages) {
    const marker = groupableMarker(message, collapsed);
    if (!marker) {
      closeRun();
      rows.push(message);
      continue;
    }
    const previous = run.at(-1)?.message;
    if (previous && (message.id === firstUnreadMessageId || startsDay(previous, message))) closeRun();
    run.push({ message, marker });
  }
  closeRun();
  return rows;
}

/** An incoming message with files draws them under its marker, so it keeps a row of its own. */
function drawsAttachments(message: AgentMessage): boolean {
  return message.exchange?.direction === "incoming" && (message.attachments?.length ?? 0) > 0;
}

function groupableMarker(message: AgentMessage, collapsed: boolean): AgentMessageMarkerModel | null {
  if (message.actionMarker?.kind !== "agent-message") return null;
  if (!collapsed && drawsAttachments(message)) return null;
  return message.actionMarker;
}

/**
 * Joins consecutive reasoning rows into one, for a person who turned reasoning off. The row keeps the
 * id of the first, so it stays the same row while the run grows, and it holds all the steps, so
 * nothing is left out. A run stops at the first unread message and at a new day. The stored messages
 * stay unchanged.
 */
export function collapseThinkingRuns(
  messages: readonly AgentMessage[],
  firstUnreadMessageId?: string | null,
): AgentMessage[] {
  const rows: AgentMessage[] = [];
  let run: AgentMessage[] = [];
  const closeRun = () => {
    const first = run[0];
    if (first) {
      rows.push(run.length === 1 ? first : { ...first, items: run.flatMap((message) => message.items ?? []) });
    }
    run = [];
  };
  for (const message of messages) {
    if (message.kind !== "thinking") {
      closeRun();
      rows.push(message);
      continue;
    }
    const previous = run.at(-1);
    if (previous && (message.id === firstUnreadMessageId || startsDay(previous, message))) closeRun();
    run.push(message);
  }
  closeRun();
  return rows;
}

/** Whether a message falls on a new day after the previous one, so a day separator comes between them. */
export function startsDay(previous: AgentMessage, current: AgentMessage): boolean {
  return current.createdAt !== undefined && dayMarkerLabel(previous.createdAt, current.createdAt) !== null;
}

/**
 * The ids of the messages in a group row of agent messages or routine runs, separated by spaces, so
 * a search or focus request finds the row.
 */
export function groupedMessageIds(message: AgentMessage | undefined): string | undefined {
  const marker = message?.actionMarker;
  if (marker?.kind === "agent-message-group") return marker.messages.map((entry) => entry.id).join(" ");
  if (marker?.kind === "routine-run-group") return marker.runs.map((entry) => entry.id).join(" ");
  return undefined;
}
