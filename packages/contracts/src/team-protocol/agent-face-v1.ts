// Optional agent-face-v1 contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent: an agent summary can carry
// `faceStyle` (`portrait`, `sketch`, `flat`, `clay`, `character`), the agent's own family of Atelier
// face, `faceSeed` (1 to 64 characters), a re-rolled face, and `faceSkin` (`1` to `8`), its skin tone. They ride beside the frozen agent
// projection exactly as `reportsToAgentId` does (see `agent-reports-to-v1.ts`): on the agent list,
// create, update, avatar and duplicate responses and on the agents-changed event. The agent update
// request can set them, or clear them with `null`. An older client or host drops both keys, so it
// shows the workspace's default face.
//
// A value that this build does not know, such as a family that a later build adds, is dropped from
// an agent summary rather than failing the list: the agent then wears the default family. An update
// request must carry a known value or `null`.
import { isAgentFaceSeed, isAgentFaceSkin, isAgentFaceStyle } from "../agent-face";
import { isDynamicRecord, isString } from "../runtime-values";
import { AGENT_KEYS, AGENT_LIST_KEYS, agentsIn } from "./agent-background-v1";
import type { TeamProtocolV6BaseJsonObject, TeamProtocolV6BaseJsonValue } from "./v6-base";

/** The fields of an agent update request that this contract adds. */
export const AGENT_FACE_UPDATE_KEYS = ["faceStyle", "faceSeed", "faceSkin"] as const;

/** The `faceStyle` and `faceSeed` fields of an agent update request: a known value, or `null` to clear. */
export function decodeAgentFaceRequest(value: unknown): TeamProtocolV6BaseJsonObject {
  if (!isDynamicRecord(value)) return {};
  const result: TeamProtocolV6BaseJsonObject = {};
  if (value.faceStyle !== undefined) {
    if (value.faceStyle !== null && !isAgentFaceStyle(value.faceStyle)) throw new Error("Invalid agent face.");
    result.faceStyle = value.faceStyle;
  }
  if (value.faceSeed !== undefined) {
    if (value.faceSeed !== null && !isAgentFaceSeed(value.faceSeed)) throw new Error("Invalid agent face.");
    result.faceSeed = value.faceSeed;
  }
  if (value.faceSkin !== undefined) {
    if (value.faceSkin !== null && !isAgentFaceSkin(value.faceSkin)) throw new Error("Invalid agent face.");
    result.faceSkin = value.faceSkin;
  }
  return result;
}

/** Puts the face of each agent in `source` on the same agent in `projected`, matched by id. */
export function withAgentFace(projected: TeamProtocolV6BaseJsonValue, source: unknown): TeamProtocolV6BaseJsonValue {
  const faces = new Map<string, TeamProtocolV6BaseJsonObject>();
  for (const agent of agentsIn(source)) {
    if (!isDynamicRecord(agent) || !isString(agent.id)) continue;
    const face: TeamProtocolV6BaseJsonObject = {};
    if (isAgentFaceStyle(agent.faceStyle)) face.faceStyle = agent.faceStyle;
    if (isAgentFaceSeed(agent.faceSeed)) face.faceSeed = agent.faceSeed;
    if (isAgentFaceSkin(agent.faceSkin)) face.faceSkin = agent.faceSkin;
    if (Object.keys(face).length > 0) faces.set(agent.id, face);
  }
  if (faces.size === 0) return projected;
  const mark = (agent: TeamProtocolV6BaseJsonValue): TeamProtocolV6BaseJsonValue => {
    if (!isDynamicRecord(agent) || !isString(agent.id)) return agent;
    const face = faces.get(agent.id);
    return face === undefined ? agent : { ...agent, ...face };
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
