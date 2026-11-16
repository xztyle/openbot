import { isDynamicRecord } from "../runtime-values";
import type { TeamProtocolV6BaseJsonValue } from "./v6-base";

/**
 * `agentTalk` rides beside the frozen `turn-completed` projection, as `moreWork` does (see
 * `more-work-turn-v6.ts`). It marks a turn of an agent's talk with another agent, which shows no
 * "Finished" notification. A host sends it only to a peer that advertises `fork-host-v1`; a peer that
 * does not know the key drops it and notifies as before. Only `true` is a value; any other present
 * value is a protocol error.
 */
export function withAgentTalkTurn(
  projected: TeamProtocolV6BaseJsonValue,
  source: unknown,
): TeamProtocolV6BaseJsonValue {
  if (!isDynamicRecord(projected) || projected.type !== "turn-completed") return projected;
  if (!isDynamicRecord(source) || source.agentTalk === undefined) return projected;
  if (source.agentTalk !== true) throw new Error("Invalid agent talk turn marker.");
  return { ...projected, agentTalk: true };
}
