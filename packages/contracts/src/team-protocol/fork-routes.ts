import { isDynamicRecord } from "../runtime-values";
import { AGENT_EFFICIENCY_ROUTES } from "./agent-efficiency-v1";
import { AGENT_LEARNING_ROUTES } from "./agent-learning-v1";
import { GUARDRAILS_ROUTES } from "./guardrails-v1";
import { PORTFOLIO_ROUTES } from "./portfolio-v1";
import { TRUST_CONTROL_ROUTES } from "./trust-control-v1";
import { decodeTeamProtocolV2Json, type TeamProtocolV2Json } from "./v2";

/**
 * The owner routes of a fork host that the desktop sends through main to a joined server: sleep,
 * reviews and playbooks, learning, the decision queue and knowledge, the portfolio, trust and the
 * guardrails. The browser client sends them itself. Each is a POST, and the host checks the role.
 */
export const FORK_OWNER_ROUTES: ReadonlySet<string> = new Set<string>([
  ...Object.values(AGENT_EFFICIENCY_ROUTES),
  ...Object.values(AGENT_LEARNING_ROUTES),
  ...Object.values(PORTFOLIO_ROUTES),
  ...Object.values(TRUST_CONTROL_ROUTES),
  ...Object.values(GUARDRAILS_ROUTES),
]);

export interface ForkRouteRequest {
  path: string;
  body: TeamProtocolV2Json;
}

/** A request of the window for one of the routes above; any other path is refused. */
export function parseForkRouteRequest(value: unknown): ForkRouteRequest {
  if (!isDynamicRecord(value) || typeof value.path !== "string" || !FORK_OWNER_ROUTES.has(value.path))
    throw new Error("Invalid host route.");
  return { path: value.path, body: decodeTeamProtocolV2Json(value.body ?? {}) };
}
