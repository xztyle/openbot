import type { AgentRuntimeSnapshot } from "@openbot/contracts/ipc";

/** The most agents, active turns, latest messages and failed turns that a Team protocol snapshot holds. */
export const TEAM_RUNTIME_SNAPSHOT_AGENTS_LIMIT = 100;

/**
 * Fits a runtime snapshot to the Team protocol's roster limit. Every released Team codec refuses a
 * snapshot with more than 100 agents, so a host with more could not send one at all: the event
 * stream closed, and no client learned of an approval, a question or a takeover from a snapshot.
 *
 * The agents that keep their place are the ones a person must see first: those that wait for the
 * person, run a turn or failed one, then the most recently updated. The other agents leave the
 * snapshot's lists only; the roster reads and the agent events still carry them.
 */
export function fitTeamRuntimeSnapshot(snapshot: AgentRuntimeSnapshot): AgentRuntimeSnapshot {
  const limit = TEAM_RUNTIME_SNAPSHOT_AGENTS_LIMIT;
  if (
    snapshot.agents.length <= limit &&
    snapshot.activeTurns.length <= limit &&
    snapshot.latestMessages.length <= limit &&
    snapshot.failedTurns.length <= limit
  )
    return snapshot;
  const rank = new Map<string, number>();
  const raise = (agentId: string, value: number) => rank.set(agentId, Math.max(rank.get(agentId) ?? 0, value));
  for (const item of [...snapshot.pendingPrompts, ...snapshot.pendingApprovals, ...snapshot.pendingBrowserTakeovers])
    raise(item.agentId, 3);
  for (const turn of snapshot.activeTurns) raise(turn.agentId, 2);
  for (const turn of snapshot.failedTurns) raise(turn.agentId, 1);
  const kept = new Set(
    [...snapshot.agents]
      .sort(
        (left, right) =>
          (rank.get(right.id) ?? 0) - (rank.get(left.id) ?? 0) ||
          (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
      )
      .slice(0, limit)
      .map((agent) => agent.id),
  );
  const keep = <Item extends { agentId: string }>(items: readonly Item[]) =>
    items.filter((item) => kept.has(item.agentId)).slice(0, limit);
  return {
    ...snapshot,
    agents: snapshot.agents.filter((agent) => kept.has(agent.id)),
    activeTurns: keep(snapshot.activeTurns),
    latestMessages: keep(snapshot.latestMessages),
    failedTurns: keep(snapshot.failedTurns),
  };
}
