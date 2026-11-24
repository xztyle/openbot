/**
 * Tier 1 of `docs/approvals.md` for lessons: a proposed change of an agent's instructions, a role
 * playbook or a skill (the decision queue of `decision-queue.ts`) goes to the agent's manager, not to
 * the owner. Each minute the host routes the entries that are new; the manager's answer applies or
 * dismisses the entry through the same owners as the owner's Apply and Dismiss. An entry that no
 * agent may answer, that a manager escalates, or that nobody answered up to the top stays with the
 * owner, in Today and the inbox.
 */
import { Effect } from "effect";
import { decisionQueue } from "../backend/agent-learning/decision-queue";
import type { AgentService } from "../backend/agent-service";
import type { ApprovalRouter } from "../backend/approvals/approval-router";

const SYNC_MS = 60_000;

function lessonRequestId(queueId: string): string {
  return `lesson:${queueId}`;
}

export interface LessonApprovals {
  /** Whether a manager has the entry now or decided it: the owner's queue leaves it out. */
  withManager(queueId: string): boolean;
  dispose(): void;
}

export function startLessonApprovals(options: {
  service: Pick<AgentService, "learning" | "playbooks" | "reviews">;
  approvals: ApprovalRouter;
  log: (message: string) => void;
}): LessonApprovals {
  const { service, approvals } = options;
  /** The entries that went to the owner: asked again only after a restart. */
  const owner = new Set<string>();
  const decide = (queueId: string, approve: boolean) => {
    const separator = queueId.indexOf(":");
    const source = queueId.slice(0, separator);
    const id = queueId.slice(separator + 1);
    if (source === "learning")
      return service.learning.decide({ itemId: id, decision: approve ? "accept" : "dismiss" }).pipe(Effect.asVoid);
    if (source === "playbook")
      return service.playbooks
        .decide({ proposalId: id, decision: approve ? "approve" : "dismiss" })
        .pipe(Effect.asVoid);
    return service.reviews.decide({ reviewId: id, decision: approve ? "approve" : "dismiss" }).pipe(Effect.asVoid);
  };
  approvals.handle("lesson", {
    settle: async (request, answer) => {
      await Effect.runPromise(decide(request.id.slice("lesson:".length), answer.verdict === "approve"));
    },
    toOwner: (request) => {
      owner.add(request.id);
    },
  });
  let running = false;
  const sync = async () => {
    if (running) return;
    running = true;
    try {
      const items = await Effect.runPromise(service.learning.pending());
      const snapshot = await Effect.runPromise(service.playbooks.snapshot()).catch(() => null);
      const page = await Effect.runPromise(service.reviews.list({ pendingOnly: true })).catch(() => ({
        reviews: [],
      }));
      const entries = decisionQueue({
        items,
        playbooks: snapshot,
        reviews: page.reviews,
        agentSpace: (agentId) => service.learning.spaceOf(agentId),
        agentName: (agentId) => service.learning.agentName(agentId),
      });
      for (const entry of entries) {
        const id = lessonRequestId(entry.id);
        if (!entry.agentId || owner.has(id) || approvals.isPending(id) || approvals.isDecided(id)) continue;
        const result = await approvals.route({
          id,
          source: "lesson",
          askerId: entry.agentId,
          title: entry.title,
          reason: "A lesson for the agent's instructions, playbook or skill: apply it or not.",
          evidence: entry.detail,
        });
        if (result.approver === "owner") owner.add(id);
      }
    } catch (error) {
      options.log(`Could not route the lessons to managers: ${error instanceof Error ? error.message : "failed"}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void sync(), SYNC_MS);
  timer.unref?.();
  void sync();
  return {
    withManager: (queueId) => {
      const id = lessonRequestId(queueId);
      return approvals.isPending(id) || approvals.isDecided(id);
    },
    dispose: () => clearInterval(timer),
  };
}
