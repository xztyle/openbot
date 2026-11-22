import type { PerformanceReview, RolePlaybooksSnapshot } from "@openbot/contracts/agent-efficiency";
import {
  addedLines,
  type DecisionQueueEntry,
  LEARNING_LIMITS,
  type LearningChange,
  type LearningReviewItem,
  removedLines,
} from "@openbot/contracts/agent-learning";

const DETAIL = 2_000;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One change of an item as a line of plain text. */
export function changeLine(change: LearningChange, agentName: (agentId: string) => string): string {
  switch (change.type) {
    case "memory-update":
      return `Memory: "${change.before}" → "${change.after}"`;
    case "memory-forget":
      return `Forget memory: "${change.before}"`;
    case "instructions-add":
      return `Add to instructions: ${change.text}`;
    case "playbook-add":
      return `Add to playbook ${change.slug}: ${change.text}`;
    case "skill-add":
      return `Add to skill ${change.name}: ${change.text}`;
    case "skill-copy":
      return `Install ${agentName(change.fromAgentId)}'s skill "${change.name}"`;
  }
}

/**
 * Everything that waits for the owner's yes or no about how the agents work, newest first, in one
 * shape: the pending learning items, the playbook proposals of agents, and the instruction that each
 * weekly review proposes. Each id carries its source, so one decide route serves them all.
 */
export function decisionQueue(input: {
  items: readonly LearningReviewItem[];
  playbooks: RolePlaybooksSnapshot | null;
  reviews: readonly PerformanceReview[];
  agentSpace(agentId: string): string;
  agentName(agentId: string): string;
}): DecisionQueueEntry[] {
  const entries: DecisionQueueEntry[] = [];
  for (const item of input.items) {
    if (item.state !== "pending") continue;
    entries.push({
      id: `learning:${item.id}`,
      source: "learning",
      kind: item.kind,
      agentId: item.agentId,
      spaceId: item.spaceId,
      title: item.title,
      detail: cut(
        [item.note, ...item.changes.map((change) => changeLine(change, input.agentName))].filter(Boolean).join("\n"),
        DETAIL,
      ),
      risk: item.risk,
      createdAt: item.createdAt,
    });
  }
  for (const proposal of input.playbooks?.proposals ?? []) {
    if (proposal.state !== "pending") continue;
    const playbook = input.playbooks?.playbooks.find((candidate) => candidate.id === proposal.playbookId);
    const added = addedLines(playbook?.content ?? "", proposal.content).map((line) => `+ ${line}`);
    const removed = removedLines(playbook?.content ?? "", proposal.content).map((line) => `- ${line}`);
    entries.push({
      id: `playbook:${proposal.id}`,
      source: "playbook",
      kind: "playbook",
      agentId: proposal.agentId,
      spaceId: input.agentSpace(proposal.agentId),
      title: cut(
        `${input.agentName(proposal.agentId)} proposes a change of playbook ${playbook?.slug ?? ""}`.trim(),
        LEARNING_LIMITS.title,
      ),
      detail: cut([proposal.note, ...removed, ...added].join("\n"), DETAIL),
      risk: "review",
      createdAt: proposal.createdAt,
    });
  }
  for (const review of input.reviews) {
    if (review.proposal?.state !== "pending") continue;
    entries.push({
      id: `review:${review.id}`,
      source: "review",
      kind: "instructions",
      agentId: review.agentId,
      spaceId: input.agentSpace(review.agentId),
      title: cut(`Weekly review of ${input.agentName(review.agentId)}: add an instruction`, LEARNING_LIMITS.title),
      detail: cut(`${review.summary}\nAdd to instructions: ${review.proposal.text}`, DETAIL),
      risk: "review",
      createdAt: review.createdAt,
    });
  }
  return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, LEARNING_LIMITS.items);
}
