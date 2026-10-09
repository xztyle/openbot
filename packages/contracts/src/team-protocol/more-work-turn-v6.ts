import { isDynamicRecord } from "../runtime-values";
import type { TeamProtocolV6BaseJsonValue } from "./v6-base";

/**
 * `moreWork` rides beside the frozen `turn-completed` projection in the same way as `quiet`. It marks
 * a turn after which the agent still has queued work or waits for a teammate's reply, so a client
 * that raises a "Finished" notification can wait for the turn after which the agent is idle. A peer
 * that does not know the key drops it and reads the turn as before, so no protocol bump and no
 * capability are needed: it loses only the quiet. Only `true` is a value; any other present value is
 * a protocol error, as for `quiet`.
 */
export function withMoreWorkTurn(projected: TeamProtocolV6BaseJsonValue, source: unknown): TeamProtocolV6BaseJsonValue {
  if (!isDynamicRecord(projected) || projected.type !== "turn-completed") return projected;
  if (!isDynamicRecord(source) || source.moreWork === undefined) return projected;
  if (source.moreWork !== true) throw new Error("Invalid more-work turn marker.");
  return { ...projected, moreWork: true };
}
