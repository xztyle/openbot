import { AGENT_EXCHANGE_ITEM_TYPE } from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";
import { countableTimelineMessage } from "@openbot/ui/features/conversation/new-message-tally";
import { startsDay } from "./agent-message-timeline";

/**
 * The turns that only another agent started, with the id of that agent. A turn is one of them when it
 * has a message from another agent and no message from a person. This is the rule that read state
 * uses on the host (`agentOnlyTurns` in `conversation-read-store.ts`), so a turn that does not count
 * as unread is also a turn that folds. When more than one agent wrote in the turn, the first one names it.
 */
export function agentOnlyTurns(messages: readonly AgentMessage[]): Map<string, string> {
  const turns = new Map<string, string>();
  const fromPerson = new Set<string>();
  for (const message of messages) {
    if (!message.turnId) continue;
    if (message.author === "you") fromPerson.add(message.turnId);
    const agentId = incomingAgentId(message);
    if (agentId !== undefined && !turns.has(message.turnId)) turns.set(message.turnId, agentId);
  }
  for (const turnId of fromPerson) turns.delete(turnId);
  return turns;
}

/** The sender of a message that another agent sent to this agent. */
function incomingAgentId(message: AgentMessage): string | undefined {
  if (message.itemType !== AGENT_EXCHANGE_ITEM_TYPE || message.exchange?.direction !== "incoming") return undefined;
  return message.exchange.senderAgentId;
}

interface AgentTurnFoldOptions {
  /** The turns that fold, by `agentOnlyTurns`. */
  turns: ReadonlyMap<string, string>;
  /** The keys of the rows that the person opened. */
  open: ReadonlySet<string>;
  activeTurnId?: string | null | undefined;
}

/**
 * Replaces the rows of the turns that only another agent started with one row for each run of those
 * turns. Consecutive turns with the same agent are one run. A turn with another agent, a row of a
 * person, a row of no agent-only turn, and a new day stop the run. An open row keeps the rows of its
 * turns under it, so they show in place. The row keeps the key of its first message, so it stays the
 * same row while new turns join.
 */
export function foldAgentTurns(rows: readonly AgentMessage[], options: AgentTurnFoldOptions): AgentMessage[] {
  if (options.turns.size === 0) return [...rows];
  const result: AgentMessage[] = [];
  let run: { agentId: string; rows: AgentMessage[] } | undefined;
  const closeRun = () => {
    if (run) result.push(...foldedRows(run.agentId, run.rows, options));
    run = undefined;
  };
  for (const row of rows) {
    const agentId = row.turnId ? options.turns.get(row.turnId) : undefined;
    if (agentId === undefined) {
      closeRun();
      result.push(row);
      continue;
    }
    const previous = run?.rows.at(-1);
    if (run && previous && (run.agentId !== agentId || (previous.turnId !== row.turnId && startsDay(previous, row)))) {
      closeRun();
    }
    if (!run) run = { agentId, rows: [] };
    run.rows.push(row);
  }
  closeRun();
  return result;
}

function foldedRows(agentId: string, rows: readonly AgentMessage[], options: AgentTurnFoldOptions): AgentMessage[] {
  const first = rows[0];
  if (!first) return [];
  const key = first.id;
  const expanded = options.open.has(key);
  const count = rows.filter(countableTimelineMessage).length;
  const activeTurnId = options.activeTurnId;
  const working = rows.some((row) => row.streaming === true || (activeTurnId != null && row.turnId === activeTurnId));
  const timestamp = rows.findLast((row) => row.createdAt !== undefined)?.createdAt;
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
      agentId,
      messageIds: rows.map((row) => row.id),
      count: count > 0 ? count : rows.length,
      timestamp,
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
