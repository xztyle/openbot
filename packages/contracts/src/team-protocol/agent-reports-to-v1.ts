// Frozen optional agent-reports-to-v1 contract.
//
// What it adds, recorded here because freezing it makes it permanent: an agent summary can carry
// `reportsToAgentId: string | null`, the agent's manager in the org chart, and `createdBy:
// { agentId, at }`, the agent that created it. They ride beside the frozen agent projection exactly
// as `background` does (see `agent-background-v1.ts`): on the agent list, create, update, avatar and
// duplicate responses and on the agents-changed event. The agent update request can set
// `reportsToAgentId`. An older client or host drops both keys, so it shows no org chart lines.
//
// It adds no capability string: it shares `fork-host-v1` (see `fork-host-v1.ts`). A fork host built
// before this field refuses an update that sets only `reportsToAgentId`, so a manager change fails
// closed with an error there and changes nothing.
import { isAgentManagerValue } from "../agent-org";
import { isAgentCreator } from "../ipc-agents";
import { isDynamicRecord, isString } from "../runtime-values";
import {
  AGENT_KEYS,
  AGENT_LIST_KEYS,
  agentsIn,
  decodeAgentBackgroundRequest,
  withAgentBackground,
} from "./agent-background-v1";
import { AGENT_EFFICIENCY_UPDATE_KEYS, decodeAgentEfficiencyRequest, withAgentEfficiency } from "./agent-efficiency-v1";
import { AGENT_FACE_UPDATE_KEYS, decodeAgentFaceRequest, withAgentFace } from "./agent-face-v1";
import type { TeamProtocolV6BaseJsonObject, TeamProtocolV6BaseJsonValue } from "./v6-base";

/** The fields of an agent update request that ride beside the frozen update projection. */
const SIDE_UPDATE_KEYS = [
  "background",
  "reportsToAgentId",
  ...AGENT_FACE_UPDATE_KEYS,
  ...AGENT_EFFICIENCY_UPDATE_KEYS,
] as const;

/**
 * The `reportsToAgentId` field of an agent update request. A present value must be an id or null:
 * the projection removes the key, so an unchecked value would reach the host as no change at all.
 */
export function decodeAgentReportsToRequest(value: unknown): TeamProtocolV6BaseJsonObject {
  if (!isDynamicRecord(value) || value.reportsToAgentId === undefined) return {};
  if (!isAgentManagerValue(value.reportsToAgentId)) throw new Error("Invalid agent manager.");
  return { reportsToAgentId: value.reportsToAgentId };
}

/**
 * The fields of an agent update request that ride beside the frozen projection: `background`, the
 * manager, and the face (`agent-face-v1.ts`).
 */
export function decodeAgentSideFieldsRequest(value: unknown): TeamProtocolV6BaseJsonObject {
  return {
    ...decodeAgentBackgroundRequest(value),
    ...decodeAgentReportsToRequest(value),
    ...decodeAgentFaceRequest(value),
    ...decodeAgentEfficiencyRequest(value),
  };
}

/**
 * An update that changes only `background` or the manager. The frozen update codec refuses a body
 * with no field it knows, so this body skips it. A host built before the fields refuses it.
 */
export function isAgentSideFieldsOnlyUpdate(value: unknown): boolean {
  if (!isDynamicRecord(value)) return false;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  return (
    keys.some((key) => SIDE_UPDATE_KEYS.some((side) => side === key)) &&
    keys.every((key) => key === "agentId" || SIDE_UPDATE_KEYS.some((side) => side === key))
  );
}

/**
 * Puts the manager and the creator of each agent in `source` on the same agent in `projected`,
 * matched by id. A present value must be valid; fail closed instead of showing a wrong line.
 */
export function withAgentReportsTo(
  projected: TeamProtocolV6BaseJsonValue,
  source: unknown,
): TeamProtocolV6BaseJsonValue {
  const lines = new Map<string, TeamProtocolV6BaseJsonObject>();
  for (const agent of agentsIn(source)) {
    if (!isDynamicRecord(agent) || !isString(agent.id)) continue;
    const line: TeamProtocolV6BaseJsonObject = {};
    if (agent.reportsToAgentId !== undefined) {
      if (!isAgentManagerValue(agent.reportsToAgentId)) throw new Error("Invalid agent manager.");
      line.reportsToAgentId = agent.reportsToAgentId;
    }
    if (agent.createdBy !== undefined) {
      if (!isAgentCreator(agent.createdBy)) throw new Error("Invalid agent creator.");
      line.createdBy = { agentId: agent.createdBy.agentId, at: agent.createdBy.at };
    }
    if (Object.keys(line).length > 0) lines.set(agent.id, line);
  }
  if (lines.size === 0) return projected;
  const mark = (agent: TeamProtocolV6BaseJsonValue): TeamProtocolV6BaseJsonValue => {
    if (!isDynamicRecord(agent) || !isString(agent.id)) return agent;
    const line = lines.get(agent.id);
    return line === undefined ? agent : { ...agent, ...line };
  };
  if (Array.isArray(projected)) return projected.map(mark);
  if (!isDynamicRecord(projected)) return projected;
  if (isString(projected.id)) return mark(projected);
  const result: TeamProtocolV6BaseJsonObject = { ...projected };
  for (const key of AGENT_KEYS) if (isDynamicRecord(result[key])) result[key] = mark(result[key]);
  for (const key of AGENT_LIST_KEYS) {
    const list = result[key];
    if (Array.isArray(list)) result[key] = list.map(mark);
  }
  return result;
}

/** The background mark, the manager, the creator and the face of each agent, beside the frozen projection. */
export function withAgentSideFields(
  projected: TeamProtocolV6BaseJsonValue,
  source: unknown,
): TeamProtocolV6BaseJsonValue {
  return withAgentEfficiency(
    withAgentFace(withAgentReportsTo(withAgentBackground(projected, source), source), source),
    source,
  );
}
