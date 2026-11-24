import { type AgentApprovalsView, decodeAgentApprovalsView } from "@openbot/contracts/agent-approvals";
import type { GuardrailPolicy, GuardrailsView } from "@openbot/contracts/guardrails";
import { decodeGuardrailsViewAnswer, GUARDRAILS_ROUTES } from "@openbot/contracts/team-protocol/guardrails-v1";
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
  /** What waits on managers, what they decided, and the owner's interventions by week. */
  approvals(): Promise<AgentApprovalsView>;
  /** Puts a request that a manager decided back in the owner's Needs you. */
  reopenApproval(id: string): Promise<AgentApprovalsView>;
  /** The guardrails of the host (`guardrails-v1`): budgets, pauses, the meter and the events. */
  guardrails: GuardrailCalls;
}

export interface GuardrailCalls {
  view(): Promise<GuardrailsView>;
  save(policy: GuardrailPolicy): Promise<GuardrailsView>;
  resume(scope: "agent" | "space", id: string): Promise<GuardrailsView>;
  /** Allows an action that the injection monitor blocked, once. Only the owner may. */
  allowOnce?(eventId: string): Promise<GuardrailsView>;
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
    approvals: () => request()("POST", TRUST_CONTROL_ROUTES.approvals, decodeAgentApprovalsView, {}),
    reopenApproval: (id) => request()("POST", TRUST_CONTROL_ROUTES.reopenApproval, decodeAgentApprovalsView, { id }),
    guardrails: {
      view: () => request()("POST", GUARDRAILS_ROUTES.view, decodeGuardrailsViewAnswer, {}),
      save: (policy) =>
        request()("POST", GUARDRAILS_ROUTES.savePolicy, decodeGuardrailsViewAnswer, {
          policy: JSON.parse(JSON.stringify(policy)),
        }),
      resume: (scope, id) => request()("POST", GUARDRAILS_ROUTES.resume, decodeGuardrailsViewAnswer, { scope, id }),
      allowOnce: (eventId) => request()("POST", GUARDRAILS_ROUTES.allowOnce, decodeGuardrailsViewAnswer, { eventId }),
    },
  };
}
