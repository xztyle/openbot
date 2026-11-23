// Optional guardrails wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent. Every route is for the owner and
// the admins only (403 for any other member):
//
// - `POST /v1/guardrails/view` `{}` answers the `GuardrailsView` of `guardrails.ts`: the policy, today's
//   usage of each agent and space against its limits, the pauses, the subscription meter with its
//   forecast, the agents that the failover moved, the newest events and the counts of the last week.
// - `POST /v1/guardrails/policy/save` `{ policy }` replaces the policy and answers the view.
// - `POST /v1/guardrails/resume` `{ scope: "agent" | "space", id }` ends a pause and answers the view.
//   The scope does not pause again for the same limit until the next day or window.
// - `POST /v1/guardrails/allow-once` `{ eventId }` allows an action that the injection monitor
//   blocked once: the agent hears it may run it again, the trust log keeps who allowed it, and the
//   view comes back. An event that is not a blocked action is a 404.
//
// A fork host built before these routes answers 404, so a client fails closed there. A present
// malformed value fails closed.

import { decodeGuardrailsView, type GuardrailsView, normalizeGuardrailPolicy } from "../guardrails";
import { isIdentifier } from "../ipc-bounded-values";
import { isDynamicRecord } from "../runtime-values";
import { adminRoute, type OptionalRouteCodec } from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import type { TeamProtocolV2Json } from "./v2";

export const GUARDRAILS_CAPABILITY = FORK_HOST_CAPABILITY;

export const GUARDRAILS_ROUTES = {
  view: "/v1/guardrails/view",
  savePolicy: "/v1/guardrails/policy/save",
  resume: "/v1/guardrails/resume",
  allowOnce: "/v1/guardrails/allow-once",
} as const;

/** Plain JSON of a value that is already JSON-shaped, with every other value refused. */
function protocolJson(value: unknown): TeamProtocolV2Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid guardrails value.");
    return value;
  }
  if (Array.isArray(value)) return value.map(protocolJson);
  if (isDynamicRecord(value)) {
    const record: { [key: string]: TeamProtocolV2Json } = {};
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) record[key] = protocolJson(entry);
    return record;
  }
  throw new Error("Invalid guardrails value.");
}

export function decodeGuardrailsViewAnswer(value: unknown): GuardrailsView {
  const view = decodeGuardrailsView(value);
  if (!view) throw new Error("Invalid guardrails view.");
  return view;
}

export function decodeGuardrailPolicySave(value: unknown): {
  policy: NonNullable<ReturnType<typeof normalizeGuardrailPolicy>>;
} {
  const policy = isDynamicRecord(value) ? normalizeGuardrailPolicy(value.policy) : null;
  if (!policy) throw new Error("Invalid guardrails policy.");
  return { policy };
}

export function decodeGuardrailResume(value: unknown): { scope: "agent" | "space"; id: string } {
  if (!isDynamicRecord(value) || (value.scope !== "agent" && value.scope !== "space") || !isIdentifier(value.id))
    throw new Error("Invalid guardrails resume.");
  return { scope: value.scope, id: value.id };
}

export function decodeGuardrailAllowOnce(value: unknown): { eventId: string } {
  if (!isDynamicRecord(value) || !isIdentifier(value.eventId)) throw new Error("Invalid guardrails allow.");
  return { eventId: value.eventId };
}

const viewAnswer = (value: unknown) => protocolJson(decodeGuardrailsViewAnswer(value));

export const GUARDRAILS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [GUARDRAILS_ROUTES.view, adminRoute(() => ({}), viewAnswer)],
  [GUARDRAILS_ROUTES.savePolicy, adminRoute((value) => protocolJson(decodeGuardrailPolicySave(value)), viewAnswer)],
  [GUARDRAILS_ROUTES.resume, adminRoute((value) => protocolJson(decodeGuardrailResume(value)), viewAnswer)],
  [GUARDRAILS_ROUTES.allowOnce, adminRoute((value) => protocolJson(decodeGuardrailAllowOnce(value)), viewAnswer)],
]);
