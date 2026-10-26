// Frozen optional agent-background-v1 contract.
//
// What it adds, recorded here because freezing it makes it permanent: an agent summary can carry
// `background: boolean`, which marks a background teammate that the user's agent lists leave out.
// It rides beside the frozen agent projection of protocol 6, in the way `expectsReply` rides beside
// the queue: the shipped key lists drop it, so an older client or host reads every agent as one the
// user sees, as it always did. It rides on the agent list, create, update, avatar and duplicate
// responses and on the agents-changed event, and the agent update request can set it.
//
// It adds no capability string: a released peer accepts at most 64, so it shares `fork-host-v1`
// (see `fork-host-v1.ts`), and a client offers the toggle only to a host that advertises it. A fork
// host built before this field refuses an update that sets only `background`, so the toggle fails
// closed with an error there and changes nothing.
import { isBoolean, isDynamicRecord, isString } from "../runtime-values";
import type { TeamProtocolV6BaseJsonObject, TeamProtocolV6BaseJsonValue } from "./v6-base";

/** The routes whose successful response is an agent, a list of agents, or a duplicated agent. */
export function isAgentSummaryResponseRoute(method: string, path: string): boolean {
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  if (pathname === "/v1/agents") return method === "GET" || method === "POST";
  if (/^\/v1\/agents\/[^/]+$/u.test(pathname)) return method === "PATCH";
  if (/^\/v1\/agents\/[^/]+\/avatar$/u.test(pathname)) return method === "PUT" || method === "DELETE";
  return method === "POST" && /^\/v1\/agents\/[^/]+\/duplicate$/u.test(pathname);
}

/** The agent update route, whose request can carry `background`. */
export function isAgentUpdateRoute(method: string, path: string): boolean {
  return method === "PATCH" && /^\/v1\/agents\/[^/]+$/u.test(new URL(path, "http://openbot.invalid").pathname);
}

/**
 * The `background` field of an agent update request. A present value must be a boolean: the
 * projection removes the key, so an unchecked value would reach the host as no change at all.
 */
export function decodeAgentBackgroundRequest(value: unknown): TeamProtocolV6BaseJsonObject {
  if (!isDynamicRecord(value) || value.background === undefined) return {};
  if (!isBoolean(value.background)) throw new Error("Invalid agent background mark.");
  return { background: value.background };
}

/**
 * An update that changes only `background`. The frozen update codec refuses a body with no field it
 * knows, so this body skips it. A host built before the field refuses it.
 * `agentId` is the path in the wire and the input in the current vocabulary.
 */
export function isBackgroundOnlyUpdate(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    value.background !== undefined &&
    Object.keys(value).every((key) => key === "background" || key === "agentId")
  );
}

/** The keys under which a payload holds agents, in the wire and the current vocabulary. */
const AGENT_KEYS = ["bot", "agent"] as const;
const AGENT_LIST_KEYS = ["bots", "agents"] as const;

function agentsIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isDynamicRecord(value)) return [];
  if (isString(value.id)) return [value];
  const found: unknown[] = [];
  for (const key of AGENT_KEYS) if (isDynamicRecord(value[key])) found.push(value[key]);
  for (const key of AGENT_LIST_KEYS) {
    const list = value[key];
    if (Array.isArray(list)) found.push(...list);
  }
  return found;
}

/**
 * Puts the `background` mark of each agent in `source` on the same agent in `projected`, matched by
 * id. A present mark must be a boolean. The projection removes the key, so an unchecked value would
 * reach the client as an agent the user sees. Fail closed instead; an absent mark still means an
 * older host, or an agent the user sees.
 */
export function withAgentBackground(
  projected: TeamProtocolV6BaseJsonValue,
  source: unknown,
): TeamProtocolV6BaseJsonValue {
  const marks = new Map<string, boolean>();
  for (const agent of agentsIn(source)) {
    if (!isDynamicRecord(agent) || agent.background === undefined) continue;
    if (!isBoolean(agent.background)) throw new Error("Invalid agent background mark.");
    if (isString(agent.id)) marks.set(agent.id, agent.background);
  }
  if (marks.size === 0) return projected;
  const mark = (agent: TeamProtocolV6BaseJsonValue): TeamProtocolV6BaseJsonValue => {
    if (!isDynamicRecord(agent) || !isString(agent.id)) return agent;
    const background = marks.get(agent.id);
    return background === undefined ? agent : { ...agent, background };
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
