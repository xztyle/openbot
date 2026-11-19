/**
 * The reporting lines of the agents of a space, for the org chart and the checks of a manager change.
 *
 * An agent reports to the manager it names in `reportsToAgentId`. `null` puts it at the top level.
 * Absent, it reports to the agent that created it with the `create_agent` tool. A manager that is
 * not in the same list, such as a deleted agent or an agent of another space, puts the agent at the
 * top level. The host refuses a change that makes a loop, but a later move of an agent to another
 * space or a deleted agent can still close one through a default line; `agentManagers` cuts it.
 */

import { isIdentifier } from "./ipc-bounded-values";

/** The fields of an agent that place it in the org chart. */
export interface AgentReportingFields {
  id: string;
  /** Set: the manager. Null: the top level. Absent: the agent that created it. */
  reportsToAgentId?: string | null | undefined;
  createdBy?: { agentId: string } | undefined;
}

/** A manager as an update carries it: an agent id, or null for the top level. */
export function isAgentManagerValue(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

/** Why the host refuses a manager. */
export type AgentManagerRefusal = "self" | "unknown" | "other-space" | "cycle";

/**
 * The manager of each agent of `agents`, or null for an agent at the top level. Pass the agents of
 * one space. A loop is cut at a line that comes from the creator before a line that someone set,
 * then at the agent that comes first in `agents`.
 */
export function agentManagers(agents: readonly AgentReportingFields[]): Map<string, string | null> {
  const order = new Map(agents.map((agent, index) => [agent.id, index]));
  const managers = new Map<string, string | null>();
  const defaulted = new Set<string>();
  for (const agent of agents) {
    const explicit = agent.reportsToAgentId !== undefined;
    const manager = explicit ? agent.reportsToAgentId : (agent.createdBy?.agentId ?? null);
    const known = manager !== null && manager !== undefined && manager !== agent.id && order.has(manager);
    managers.set(agent.id, known ? manager : null);
    if (known && !explicit) defaulted.add(agent.id);
  }
  // 1 while the walk is on the agent, 2 when its line to the top is known to end.
  const state = new Map<string, 1 | 2>();
  for (const agent of agents) {
    const path: string[] = [];
    let current: string | null | undefined = agent.id;
    while (current && !state.has(current)) {
      state.set(current, 1);
      path.push(current);
      current = managers.get(current);
    }
    if (current && state.get(current) === 1) {
      const loop = path.slice(path.indexOf(current));
      const byOrder = (left: string, right: string) => (order.get(left) ?? 0) - (order.get(right) ?? 0);
      const cut = loop.filter((id) => defaulted.has(id)).sort(byOrder)[0] ?? [...loop].sort(byOrder)[0];
      if (cut) managers.set(cut, null);
    }
    for (const id of path) state.set(id, 2);
  }
  return managers;
}

/**
 * Why `managerId` cannot be the manager of `agentId`, or null when it can. `null` (the top level)
 * is always allowed. `sameSpace` tells whether two agents are in the same space.
 */
export function agentManagerRefusal(
  agents: readonly AgentReportingFields[],
  agentId: string,
  managerId: string | null,
  sameSpace: (agentId: string, otherAgentId: string) => boolean,
): AgentManagerRefusal | null {
  if (managerId === null) return null;
  if (managerId === agentId) return "self";
  if (!agents.some((agent) => agent.id === managerId)) return "unknown";
  if (!sameSpace(agentId, managerId)) return "other-space";
  const managers = agentManagers(agents.filter((agent) => sameSpace(agentId, agent.id)));
  // The lines above the new manager have no loop, so the walk ends.
  for (let current: string | null | undefined = managerId; current; current = managers.get(current)) {
    if (current === agentId) return "cycle";
  }
  return null;
}
