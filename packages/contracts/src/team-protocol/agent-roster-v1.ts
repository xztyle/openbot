// Fork optional agent-roster-changed event, on `fork-host-v1` (see `fork-host-v1.ts`).
//
// What it adds, recorded here because shipping it makes it permanent: the frozen `bots-changed`
// event holds at most 100 agents. A host with more agents could not encode it, so no roster change
// reached a client until its next full read: a new agent showed with no name, and a changed model,
// name or face stayed as it was. This event carries the whole roster that the member can see, each
// agent exactly as the agent list response (`GET /v1/agents`) encodes it on protocol 8, so a client
// decodes it with the same codec. Clients read it as `agents-changed`.
//
// A host sends it in place of `bots-changed` to a peer with `fork-host-v1` on protocol 8. A fork
// client built before it treats it as an unknown event and keeps the roster of its last read.
import { INPUT_LIMITS } from "../input-limits";
import { type ClientAgentSummary, isClientAgentSummary } from "../ipc-agents";
import { isDynamicRecord } from "../runtime-values";
import { TEAM_API_ROUTES } from "../team-api-routes";
import { decodeTeamProtocolV8CurrentHttpResponse } from "./v8-adapter";

export const AGENT_ROSTER_EVENT = "agent-roster-changed";

/** The wire event: the agents as the agent list response encodes them. */
export type AgentRosterEvent = { type: typeof AGENT_ROSTER_EVENT; agents: unknown[] };

/** The agents of a roster event, as a client reads them. Throws on a roster that the codec refuses. */
export function decodeAgentRoster(agents: readonly unknown[]): ClientAgentSummary[] {
  const decoded = decodeTeamProtocolV8CurrentHttpResponse("GET", TEAM_API_ROUTES.agents.all, 200, agents);
  if (!Array.isArray(decoded)) throw new Error("Invalid agent roster event.");
  return decoded.map((agent) => {
    if (!isClientAgentSummary(agent)) throw new Error("Invalid agent roster event.");
    return agent;
  });
}

/**
 * The roster event in `input`, or null for any other event. The agents stay in their wire form, so a
 * relay that decodes the event and sends it on sends what it got. A malformed roster throws.
 */
export function agentRosterEvent(input: unknown): AgentRosterEvent | null {
  if (!isDynamicRecord(input) || input.type !== AGENT_ROSTER_EVENT) return null;
  const { agents } = input;
  if (Object.keys(input).some((key) => key !== "type" && key !== "agents"))
    throw new Error("Invalid agent roster event.");
  if (!Array.isArray(agents) || agents.length > INPUT_LIMITS.agents) throw new Error("Invalid agent roster event.");
  decodeAgentRoster(agents);
  return { type: AGENT_ROSTER_EVENT, agents };
}
