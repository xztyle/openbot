import { z } from "zod";

export const AGENT_SELECTION_STORAGE_KEY = "openbot:selected-agent:v1";

type AgentSelectionStorage = Pick<Storage, "getItem" | "setItem">;

const selectionSchema = z.record(z.string().min(1), z.string().min(1).nullable().catch(null));

export function readAgentSelection(storage?: AgentSelectionStorage): Record<string, string> {
  try {
    const value = (storage ?? window.localStorage).getItem(AGENT_SELECTION_STORAGE_KEY);
    const parsed = selectionSchema.safeParse(JSON.parse(value ?? "{}"));
    if (!parsed.success) return {};
    return Object.fromEntries(
      Object.entries(parsed.data).flatMap(([serverId, agentId]) => (agentId ? [[serverId, agentId]] : [])),
    );
  } catch {
    return {};
  }
}

export function writeAgentSelection(serverId: string, agentId: string, storage?: AgentSelectionStorage): void {
  try {
    const target = storage ?? window.localStorage;
    const selections = readAgentSelection(target);
    if (agentId) selections[serverId] = agentId;
    else delete selections[serverId];
    target.setItem(AGENT_SELECTION_STORAGE_KEY, JSON.stringify(selections));
  } catch {
    // A local display preference must not block agent navigation.
  }
}

/** The selection key of the web client: one chat for each account and host. Desktop servers use their own ids. */
export function webAgentSelectionKey(accountId: string, hostId: string): string {
  return `web:${accountId}:${hostId}`;
}

/**
 * The agent to open when a workspace has no selection: the saved one while it still exists, else the
 * first in the order the sidebar draws. The sidebar sorts by `agentOrder`; an agent that the layout does
 * not name yet follows the named ones, in the order the host listed them.
 */
export function initialAgentId(
  agentIds: readonly string[],
  layout: { agentOrder: readonly string[] },
  savedAgentId?: string | null,
): string | null {
  if (savedAgentId && agentIds.includes(savedAgentId)) return savedAgentId;
  const orderIndex = new Map(layout.agentOrder.map((id, index) => [id, index]));
  let first: string | null = null;
  let firstRank = Number.POSITIVE_INFINITY;
  agentIds.forEach((id, index) => {
    const rank = orderIndex.get(id) ?? layout.agentOrder.length + index;
    if (rank < firstRank) {
      first = id;
      firstRank = rank;
    }
  });
  return first;
}
