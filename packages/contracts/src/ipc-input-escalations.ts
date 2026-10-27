import { isIdentifier, isRequestId } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

/** The kinds of request that an escalation names: what blocks a turn until the user acts. */
export const AGENT_INPUT_ESCALATION_KINDS = ["prompt", "approval", "browser-takeover"] as const;
export type AgentInputEscalationKind = (typeof AGENT_INPUT_ESCALATION_KINDS)[number];

/** The most escalations that one list holds. More requests than this never wait at the same time. */
export const AGENT_INPUT_ESCALATIONS_LIMIT = 50;
/** The longest delegation chain that an escalation names. A longer chain stops at this length. */
export const AGENT_INPUT_ESCALATION_CHAIN_LIMIT = 8;

/**
 * A request of an agent that waits for the user while the agent works for other agents. The turn
 * that asks was started by a request of `delegatorAgentIds[0]`, and that agent did the work for the
 * next one in the list, up to the agent at the root of the chain, which the user talks to. The chat
 * of each of these agents shows the request, and an answer there answers the request itself.
 *
 * It names the request only. The question, the approval and the takeover come from their own events,
 * so no text of the request is copied here.
 */
export interface AgentInputEscalation {
  kind: AgentInputEscalationKind;
  requestId: string | number;
  agentId: string;
  threadId: string;
  turnId: string;
  delegatorAgentIds: string[];
}

export function isAgentInputEscalation(value: unknown): value is AgentInputEscalation {
  return (
    isDynamicRecord(value) &&
    isOneOf(AGENT_INPUT_ESCALATION_KINDS, value.kind) &&
    isRequestId(value.requestId) &&
    isIdentifier(value.agentId) &&
    isIdentifier(value.threadId) &&
    isIdentifier(value.turnId) &&
    Array.isArray(value.delegatorAgentIds) &&
    value.delegatorAgentIds.length > 0 &&
    value.delegatorAgentIds.length <= AGENT_INPUT_ESCALATION_CHAIN_LIMIT &&
    value.delegatorAgentIds.every(isIdentifier)
  );
}

export function isAgentInputEscalationList(value: unknown): value is AgentInputEscalation[] {
  return Array.isArray(value) && value.length <= AGENT_INPUT_ESCALATIONS_LIMIT && value.every(isAgentInputEscalation);
}

/** The escalations whose chain names `agentId`: the requests that its chat shows for its teammates. */
export function inputEscalationsForDelegator(
  escalations: readonly AgentInputEscalation[],
  agentId: string,
): AgentInputEscalation[] {
  return escalations.filter(
    (escalation) => escalation.agentId !== agentId && escalation.delegatorAgentIds.includes(agentId),
  );
}

/**
 * The escalation of one request, or undefined. A provider can use a request id again on another
 * agent, so the agent and the kind are part of the match.
 */
export function inputEscalationOf(
  escalations: readonly AgentInputEscalation[],
  kind: AgentInputEscalationKind,
  agentId: string,
  requestId: string | number,
): AgentInputEscalation | undefined {
  return escalations.find(
    (escalation) =>
      escalation.kind === kind && escalation.agentId === agentId && String(escalation.requestId) === String(requestId),
  );
}

/** The agent at the root of the chain: the one that the user talks to. */
export function inputEscalationRoot(escalation: AgentInputEscalation): string {
  return escalation.delegatorAgentIds.at(-1) ?? escalation.agentId;
}
