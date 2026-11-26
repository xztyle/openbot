import { AGENT_EXCHANGE_ITEM_TYPE } from "@openbot/contracts/ipc";
import {
  type AgentActivitySource,
  type BackgroundTurnOptions,
  backgroundTurns,
  isBackgroundRow,
  isOwnerAddressedItemType,
  type OwnerConversationRow,
  storedNoticeKind,
} from "@openbot/contracts/owner-conversation";
import type { AgentMessage } from "@openbot/ui/data";
import { startsDay } from "./agent-message-timeline";

/** The role of a drawn row in the rule of the owner's conversation (`backgroundTurns`). */
function rowRole(message: AgentMessage): OwnerConversationRow["role"] {
  if (storedNoticeKind(message.itemType)) return "notice";
  if (message.author === "you") return message.routine || message.itemType === "routine" ? "routine" : "person";
  if (message.itemType === AGENT_EXCHANGE_ITEM_TYPE) return message.exchange ? "exchange" : "other";
  if (!message.itemType || message.itemType === "agentMessage") return "answer";
  return "other";
}

/**
 * The turns of the agent's own activity in its chat, with what woke the agent for each: a Motion event,
 * a teammate, a note from Atelier, a mail or a routine run, and no person wrote in it. It is the rule
 * of the host's read state (`backgroundTurns` in `@openbot/contracts/owner-conversation`), so a turn
 * that does not count as unread is also a turn that folds.
 */
export function agentActivityTurns(
  messages: readonly AgentMessage[],
  options: BackgroundTurnOptions = {},
): Map<string, AgentActivitySource[]> {
  return backgroundTurns(
    messages.map((message) => ({
      turnId: message.turnId,
      role: rowRole(message),
      notice: storedNoticeKind(message.itemType),
      exchange: message.exchange,
      direction: message.exchange?.direction,
      text: message.body,
    })),
    // By default only a turn with a sign of what woke the agent folds: the chat never hides a turn it
    // cannot explain. A count passes `wholeTurns`, as the host counts.
    options,
  );
}

/**
 * Whether a drawn row is the agent's own activity: a row of such a turn, or a note from Atelier or a
 * message between agents that no turn has started yet. A message to the owner and a question to them
 * never are, whatever started their turn.
 */
function activityRow(row: AgentMessage, turns: ReadonlyMap<string, AgentActivitySource[]>): boolean {
  if (isOwnerAddressedItemType(row.itemType)) return false;
  if (row.turnId) return isBackgroundRow(row, turns);
  const notice = storedNoticeKind(row.itemType);
  return (notice !== null && notice !== "restart-resume") || row.itemType === AGENT_EXCHANGE_ITEM_TYPE;
}

/** What woke the agent for a row with no turn, from the row itself. */
function rowSources(row: AgentMessage): AgentActivitySource[] {
  const notice = storedNoticeKind(row.itemType);
  if (notice === "motion-event") return [{ kind: "motion" }];
  if (notice === "inbound-email") return [{ kind: "mail" }];
  if (notice) return [{ kind: "atelier" }];
  const sender = row.exchange?.direction === "incoming" ? row.exchange.senderAgentId : undefined;
  return sender ? [{ kind: "agent", agentId: sender }] : [];
}

interface AgentTurnFoldOptions {
  /** The turns that fold, by `agentActivityTurns`. */
  turns: ReadonlyMap<string, AgentActivitySource[]>;
  /** The keys of the rows that the person opened. */
  open: ReadonlySet<string>;
  activeTurnId?: string | null | undefined;
}

/**
 * Replaces the rows of the agent's own activity with one "Agent activity" row for each burst of it.
 * A burst is the activity between two rows of the owner's conversation: a row of a person, a row of a
 * turn a person started, or a new day ends it. A message to the owner from a turn of the burst shows
 * right after the burst's row. An open row keeps the rows of
 * its turns under it, so they show in place. The row keeps the key of its first message, so it stays
 * the same row while new turns join.
 */
export function foldAgentTurns(rows: readonly AgentMessage[], options: AgentTurnFoldOptions): AgentMessage[] {
  const result: AgentMessage[] = [];
  let run: AgentMessage[] | undefined;
  // A message to the owner from a turn of the run: it shows right after the run's row, so the turn
  // stays one row.
  let toOwner: AgentMessage[] = [];
  const closeRun = () => {
    if (run) result.push(...foldedRows(run, options));
    result.push(...toOwner);
    run = undefined;
    toOwner = [];
  };
  for (const row of rows) {
    if (run && row.turnId !== undefined && options.turns.has(row.turnId) && !activityRow(row, options.turns)) {
      toOwner.push(row);
      continue;
    }
    if (!activityRow(row, options.turns)) {
      closeRun();
      result.push(row);
      continue;
    }
    const previous = run?.at(-1);
    if (run && previous && previous.turnId !== row.turnId && startsDay(previous, row)) closeRun();
    run ??= [];
    run.push(row);
  }
  closeRun();
  return result;
}

function sameSource(left: AgentActivitySource, right: AgentActivitySource): boolean {
  return (
    left.kind === right.kind && (left.kind !== "agent" || (right.kind === "agent" && left.agentId === right.agentId))
  );
}

function foldedRows(rows: readonly AgentMessage[], options: AgentTurnFoldOptions): AgentMessage[] {
  const first = rows[0];
  if (!first) return [];
  const key = first.id;
  const expanded = options.open.has(key);
  // One update for each wake: each turn, and each note or message that no turn started yet.
  const updates = new Set(rows.map((row) => row.turnId ?? `row:${row.id}`)).size;
  const sources: AgentActivitySource[] = [];
  for (const row of rows) {
    const found = row.turnId ? (options.turns.get(row.turnId) ?? []) : rowSources(row);
    for (const source of found) if (!sources.some((known) => sameSource(known, source))) sources.push(source);
  }
  const activeTurnId = options.activeTurnId;
  const working = rows.some((row) => row.streaming === true || (activeTurnId != null && row.turnId === activeTurnId));
  const timestamp = rows.findLast((row) => row.createdAt !== undefined)?.createdAt;
  const startTimestamp = rows.find((row) => row.createdAt !== undefined)?.createdAt;
  const fold: AgentMessage = {
    id: agentTurnFoldId(key),
    ...(first.turnId === undefined ? {} : { turnId: first.turnId }),
    author: "agent",
    body: "",
    time: first.time,
    ...(first.createdAt === undefined ? {} : { createdAt: first.createdAt }),
    animate: first.animate,
    kind: "agent-turns",
    agentTurns: {
      key,
      sources,
      messageIds: rows.map((row) => row.id),
      count: updates,
      timestamp,
      startTimestamp,
      working,
      expanded,
    },
  };
  return expanded ? [fold, ...rows] : [fold];
}

/** The row id of a fold. It is not the id of its first message, because an open fold also draws that message. */
function agentTurnFoldId(key: string): string {
  return `${key}:agent-turns`;
}
