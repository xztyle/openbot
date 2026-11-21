import {
  decodeTrustAuditEntries,
  decodeTrustPolicyView,
  TRUST_CONTROL_ROUTES,
} from "@openbot/contracts/team-protocol/trust-control-v1";
import type { TrustAuditEntry, TrustAuditQuery, TrustPolicy, TrustPolicyView } from "@openbot/contracts/trust-control";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";

/**
 * The trust and control calls of one host: the policy with its spend, its save, and the audit trail
 * (`trust-control-v1` under `fork-host-v1`). Only an owner or an admin gets them.
 */
export interface TrustCalls {
  policy(): Promise<TrustPolicyView>;
  save(policy: TrustPolicy): Promise<TrustPolicyView>;
  audit(query: TrustAuditQuery): Promise<TrustAuditEntry[]>;
}

/** The routes of the connected host, for the browser client. A host that is not connected rejects. */
export function hostTrustCalls(request: () => TeamApiRequest): TrustCalls {
  return {
    policy: () => request()("POST", TRUST_CONTROL_ROUTES.policy, decodeTrustPolicyView, {}),
    save: (policy) =>
      request()("POST", TRUST_CONTROL_ROUTES.savePolicy, decodeTrustPolicyView, {
        policy: JSON.parse(JSON.stringify(policy)),
      }),
    audit: async (query) =>
      (await request()("POST", TRUST_CONTROL_ROUTES.audit, decodeTrustAuditEntries, JSON.parse(JSON.stringify(query))))
        .entries,
  };
}
