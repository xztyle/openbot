import {
  type AgentApproval,
  type AgentEvent,
  type AgentInputEscalation,
  type BrowserTakeoverRequest,
  inputEscalationsForDelegator,
} from "@openbot/contracts/ipc";
import { classifyFailure } from "@openbot/telemetry";
import { toast } from "@openbot/ui";
import type { AgentProfile } from "@openbot/ui/data";
import { currentText } from "@openbot/ui/text";
import type { TeammateRequest } from "./conversation-types";

type PromptEvent = Extract<AgentEvent, { type: "prompt" }>;

/** A request of a teammate that waits for the user, found for the chat of an agent in its chain. */
export type TeammateRequestSource =
  | { kind: "prompt"; key: string; agentId: string; agent: AgentProfile | undefined; prompt: PromptEvent }
  | { kind: "approval"; key: string; agentId: string; agent: AgentProfile | undefined; approval: AgentApproval }
  | {
      kind: "browser-takeover";
      key: string;
      agentId: string;
      agent: AgentProfile | undefined;
      request: BrowserTakeoverRequest;
    };

export interface TeammateRequestInput {
  escalations: readonly AgentInputEscalation[];
  agents: readonly AgentProfile[];
  prompts: readonly PromptEvent[];
  approvals: readonly AgentApproval[];
  takeovers: readonly BrowserTakeoverRequest[];
}

const same = (a: string | number, b: string | number) => String(a) === String(b);

/**
 * The requests that the chat of `delegatorId` shows for its teammates. Each comes from the client's
 * own pending requests, so a request that is answered or cancelled anywhere leaves the list with it.
 */
export function teammateRequestsFor(
  delegatorId: string | undefined,
  input: TeammateRequestInput,
): TeammateRequestSource[] {
  if (!delegatorId) return [];
  const requests: TeammateRequestSource[] = [];
  for (const escalation of inputEscalationsForDelegator(input.escalations, delegatorId)) {
    const found = findRequest(escalation, input);
    if (found) requests.push(found);
  }
  return requests;
}

function findRequest(escalation: AgentInputEscalation, input: TeammateRequestInput): TeammateRequestSource | null {
  const { agentId, requestId } = escalation;
  const agent = input.agents.find((candidate) => candidate.id === agentId);
  const key = `${escalation.kind}\n${agentId}\n${String(requestId)}`;
  if (escalation.kind === "prompt") {
    const prompt = input.prompts.find((item) => item.agentId === agentId && same(item.requestId, requestId));
    return prompt ? { kind: "prompt", key, agentId, agent, prompt } : null;
  }
  if (escalation.kind === "approval") {
    const approval = input.approvals.find((item) => item.agentId === agentId && same(item.requestId, requestId));
    return approval ? { kind: "approval", key, agentId, agent, approval } : null;
  }
  const request = input.takeovers.find((item) => item.agentId === agentId && same(item.requestId, requestId));
  return request ? { kind: "browser-takeover", key, agentId, agent, request } : null;
}

/** Whether the user can answer the question in another chat: a private answer stays in the teammate's chat. */
export function promptAnswersElsewhere(prompt: PromptEvent): boolean {
  return !prompt.questions.some((question) => question.isSecret);
}

/** A teammate's question or browser takeover, as a delegator's entry of the sidebar attention. */
type MirroredPrompt = PromptEvent | { type: "browser-takeover-requested"; request: BrowserTakeoverRequest };

/**
 * The sidebar attention with each delegator marked as waiting for its teammates' requests, where it
 * has no wait of its own. So "Needs you" shows the agent that the user talks to. A private question
 * gives no question text.
 */
export function withTeammateAttention<P = never, A = never>(
  attention: {
    pendingPrompts: Record<string, P | MirroredPrompt | undefined>;
    pendingApprovals: Record<string, A | AgentApproval | undefined>;
  },
  input: TeammateRequestInput,
): {
  pendingPrompts: Record<string, P | MirroredPrompt | undefined>;
  pendingApprovals: Record<string, A | AgentApproval | undefined>;
} {
  if (input.escalations.length === 0) return attention;
  const pendingPrompts = { ...attention.pendingPrompts };
  const pendingApprovals = { ...attention.pendingApprovals };
  for (const escalation of input.escalations) {
    const found = findRequest(escalation, input);
    if (!found) continue;
    for (const delegatorId of escalation.delegatorAgentIds) {
      if (pendingPrompts[delegatorId] || pendingApprovals[delegatorId]) continue;
      if (found.kind === "prompt")
        pendingPrompts[delegatorId] = promptAnswersElsewhere(found.prompt)
          ? found.prompt
          : { ...found.prompt, questions: [] };
      else if (found.kind === "browser-takeover")
        pendingPrompts[delegatorId] = { type: "browser-takeover-requested", request: found.request };
      else pendingApprovals[delegatorId] = found.approval;
    }
  }
  return { pendingPrompts, pendingApprovals };
}

export interface TeammateRequestActions {
  /** The teammate's name, or a fallback for an agent that the list no longer has. */
  name(agent: AgentProfile | undefined): string;
  answer(agentId: string, requestId: string | number, answers: Record<string, string[]>): Promise<boolean>;
  respondToApproval(agentId: string, requestId: string | number, decision: "accept" | "decline"): Promise<boolean>;
  open(agentId: string): void;
}

/** The cards of the requests, with the same answer paths as the teammate's own chat. */
export function teammateRequestViews(
  sources: readonly TeammateRequestSource[],
  actions: TeammateRequestActions,
): TeammateRequest[] {
  return sources.map((source) => {
    const base = {
      key: source.key,
      agentId: source.agentId,
      name: actions.name(source.agent),
      agent: source.agent,
      kind: source.kind,
      onOpen: () => actions.open(source.agentId),
    };
    if (source.kind === "prompt") {
      const { requestId, questions } = source.prompt;
      return promptAnswersElsewhere(source.prompt)
        ? {
            ...base,
            questions,
            onAnswer: (answers: Record<string, string[]>) => actions.answer(source.agentId, requestId, answers),
          }
        : base;
    }
    if (source.kind === "approval") {
      const { requestId } = source.approval;
      return {
        ...base,
        approval: source.approval,
        onApprove: () => actions.respondToApproval(source.agentId, requestId, "accept"),
        onReject: () => actions.respondToApproval(source.agentId, requestId, "decline"),
      };
    }
    return base;
  });
}

/**
 * Shows a failed answer to a teammate's question. The teammate's own chat would show it, but the user
 * answered in another chat; the question card stays open for another try.
 */
export function toastTeammateAnswerError(error: unknown): void {
  const { t, errorMessage } = currentText();
  toast.error(errorMessage(error, t("app.errorStatus.answer")), {
    report: { operation: "turn", source: "system", cause_code: classifyFailure(error) },
  });
}
