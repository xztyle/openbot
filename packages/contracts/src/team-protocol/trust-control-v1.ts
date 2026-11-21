// Optional trust and control wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent. Every route is for the owner and
// the admins only (403 for any other member):
//
// - `POST /v1/trust/policy` `{}` answers `{ policy, spend }`: the trust policy (`TrustPolicy` of
//   `trust-control.ts`: `enabled`, rules per role, overrides per space, team and agent, budgets,
//   sandbox switches, `approvalPassMinutes`) and at most 500 spend rows `{ platform, currency,
//   agentId?, today, total }` (a row without `agentId` sums every agent).
// - `POST /v1/trust/policy/save` `{ policy }` replaces the policy and answers as above. The host
//   records the change in the audit trail.
// - `POST /v1/trust/audit` `{ limit? (1 to 2000), before?, since?, until?, category?, outcome?,
//   agentId?, text? (200) }` answers `{ entries }`, newest first: `TrustAuditEntry` rows (who, what,
//   when, the amount, and the agent, thread, turn, channel, space and ticket it belongs to).
//
// A fork host built before these routes answers 404, so a client fails closed there. A present
// malformed value fails closed.

import { isDynamicRecord } from "../runtime-values";
import {
  isTrustAuditEntry,
  isTrustSpendRow,
  normalizeTrustAuditQuery,
  normalizeTrustPolicy,
  TRUST_AUDIT_QUERY_MAX,
  type TrustAuditEntry,
  type TrustAuditQuery,
  type TrustPolicyView,
} from "../trust-control";
import { adminRoute, type OptionalRouteCodec } from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import type { TeamProtocolV2Json } from "./v2";

export const TRUST_CONTROL_CAPABILITY = FORK_HOST_CAPABILITY;

export const TRUST_CONTROL_ROUTES = {
  policy: "/v1/trust/policy",
  savePolicy: "/v1/trust/policy/save",
  audit: "/v1/trust/audit",
} as const;

/** Plain JSON of a value that is already JSON-shaped, with every other value refused. */
function protocolJson(value: unknown): TeamProtocolV2Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid trust value.");
    return value;
  }
  if (Array.isArray(value)) return value.map(protocolJson);
  if (isDynamicRecord(value)) {
    const record: { [key: string]: TeamProtocolV2Json } = {};
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) record[key] = protocolJson(entry);
    return record;
  }
  throw new Error("Invalid trust value.");
}

/** The answer of the policy routes, checked. */
export function decodeTrustPolicyView(value: unknown): TrustPolicyView {
  if (!isDynamicRecord(value)) throw new Error("Invalid trust policy.");
  const policy = normalizeTrustPolicy(value.policy);
  if (!policy || !Array.isArray(value.spend) || value.spend.length > 500 || !value.spend.every(isTrustSpendRow))
    throw new Error("Invalid trust policy.");
  return { policy, spend: value.spend };
}

export function decodeTrustAuditEntries(value: unknown): { entries: TrustAuditEntry[] } {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.entries) ||
    value.entries.length > TRUST_AUDIT_QUERY_MAX ||
    !value.entries.every(isTrustAuditEntry)
  )
    throw new Error("Invalid trust audit.");
  return { entries: value.entries };
}

export function decodeTrustPolicySave(value: unknown): {
  policy: NonNullable<ReturnType<typeof normalizeTrustPolicy>>;
} {
  const policy = isDynamicRecord(value) ? normalizeTrustPolicy(value.policy) : null;
  if (!policy) throw new Error("Invalid trust policy.");
  return { policy };
}

export function decodeTrustAuditQuery(value: unknown): TrustAuditQuery {
  return normalizeTrustAuditQuery(value);
}

export const TRUST_CONTROL_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    TRUST_CONTROL_ROUTES.policy,
    adminRoute(
      () => ({}),
      (value) => protocolJson(decodeTrustPolicyView(value)),
    ),
  ],
  [
    TRUST_CONTROL_ROUTES.savePolicy,
    adminRoute(
      (value) => protocolJson(decodeTrustPolicySave(value)),
      (value) => protocolJson(decodeTrustPolicyView(value)),
    ),
  ],
  [
    TRUST_CONTROL_ROUTES.audit,
    adminRoute(
      (value) => protocolJson(decodeTrustAuditQuery(value)),
      (value) => protocolJson(decodeTrustAuditEntries(value)),
    ),
  ],
]);
