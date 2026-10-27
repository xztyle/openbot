// Frozen optional input-escalations-v1 wire contract of this fork.
//
// What it adds, recorded here because freezing it makes it permanent: the event
// `agent-input-escalations-changed` with the whole list of requests (a question, an approval or a
// browser takeover) that wait for the user in a turn that another agent asked for. Each entry names
// the request (`kind`, `requestId`, `agentId`, `threadId`, `turnId`) and `delegatorAgentIds`: the
// agent whose request started the turn first, then each agent that delegated to the one before it,
// up to the agent at the root of the chain. A client shows the request in the chat of each of these
// agents, and answers it with the released route that answers the request in its own chat, so the
// host checks the answer as before. The entry holds no text of the request: the question, the
// approval and the takeover keep coming from their released events.
//
// The host sends the event after each runtime snapshot that it sends to a peer, and again at each
// change, to a peer that has `fork-host-v1` only. It leaves out each request of an agent that the peer
// cannot see, and each delegator that the peer cannot see. Bounds: at most 50 entries, at most 8
// delegators, identifiers of at most 128 characters. A malformed event fails closed. Widening any of
// it needs a second capability string.
//
// It adds no capability string: a released peer accepts at most 64, so it shares `fork-host-v1`
// (see `fork-host-v1.ts`). A host without it never sends the event, and a client then shows each
// request only in the chat of the agent that asks.
import {
  AGENT_INPUT_ESCALATION_CHAIN_LIMIT,
  AGENT_INPUT_ESCALATION_KINDS,
  AGENT_INPUT_ESCALATIONS_LIMIT,
  type AgentInputEscalation,
} from "../ipc-input-escalations";
import { isDynamicRecord, isNumber, isOneOf, isString } from "../runtime-values";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const INPUT_ESCALATIONS_CAPABILITY = FORK_HOST_CAPABILITY;
export const INPUT_ESCALATIONS_EVENT = "agent-input-escalations-changed";

const IDENTIFIER_LIMIT = 128;

function identifier(value: unknown): string {
  if (!isString(value) || value.length === 0 || value.length > IDENTIFIER_LIMIT)
    throw new Error("Invalid input escalation.");
  return value;
}

function requestId(value: unknown): string | number {
  if (isNumber(value) && Number.isSafeInteger(value)) return value;
  return identifier(value);
}

function escalation(value: unknown): AgentInputEscalation {
  if (!isDynamicRecord(value) || !isOneOf(AGENT_INPUT_ESCALATION_KINDS, value.kind))
    throw new Error("Invalid input escalation.");
  const delegators = value.delegatorAgentIds;
  if (!Array.isArray(delegators) || delegators.length === 0 || delegators.length > AGENT_INPUT_ESCALATION_CHAIN_LIMIT)
    throw new Error("Invalid input escalation.");
  return {
    kind: value.kind,
    requestId: requestId(value.requestId),
    agentId: identifier(value.agentId),
    threadId: identifier(value.threadId),
    turnId: identifier(value.turnId),
    delegatorAgentIds: delegators.map(identifier),
  };
}

/** The list in its wire shape. Throws on a malformed list. */
export function decodeInputEscalations(value: unknown): AgentInputEscalation[] {
  if (!Array.isArray(value) || value.length > AGENT_INPUT_ESCALATIONS_LIMIT)
    throw new Error("Invalid input escalations.");
  return value.map(escalation);
}

export type InputEscalationsEvent = {
  type: typeof INPUT_ESCALATIONS_EVENT;
  escalations: AgentInputEscalation[];
};

export function inputEscalationsEvent(input: unknown): InputEscalationsEvent | null {
  if (!isDynamicRecord(input) || input.type !== INPUT_ESCALATIONS_EVENT) return null;
  return { type: INPUT_ESCALATIONS_EVENT, escalations: decodeInputEscalations(input.escalations) };
}

/**
 * The list that one peer may see: no request of an agent in `hidden`, and no delegator in `hidden`.
 * An entry with no delegator left is left out.
 */
export function visibleInputEscalations(
  escalations: readonly AgentInputEscalation[],
  hidden: ReadonlySet<string>,
): AgentInputEscalation[] {
  return escalations.flatMap((entry) => {
    if (hidden.has(entry.agentId)) return [];
    const delegatorAgentIds = entry.delegatorAgentIds.filter((agentId) => !hidden.has(agentId));
    return delegatorAgentIds.length > 0 ? [{ ...entry, delegatorAgentIds }] : [];
  });
}
