/**
 * End-to-end check of the background memory review's gates and its result, without a provider:
 * `bun scripts/memory-review-e2e.ts`.
 *
 * It drives `MemoryReview` with a fake generation and fake memories, and checks that
 * - turns without a person message start no review (talk between agents and routine runs cost nothing),
 * - the turn interval starts one review, which reads only the person's chat after the last review,
 * - the per-agent gap and the server's daily limit hold the next review back,
 * - Off starts none, and a skill lesson reaches the skill learner only in Automatic.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentModelOption,
  type AgentSummary,
  type ConversationMessage,
  DEFAULT_WORKSPACE_LEARNING,
  type WorkspaceLearningSettings,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentMemories, MemoryReviewBase } from "../src/backend/agent/agent-memories";
import { MemoryReview } from "../src/backend/agent/memory-review";
import type { MemoryReviewOperation } from "../src/backend/agent/memory-review-prompt";
import { MemoryReviewState } from "../src/backend/agent/memory-review-state";
import type { LearnedSkillDraft } from "../src/backend/agent/skill-learning";

function check(condition: boolean | undefined, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  process.stdout.write(`ok - ${message}\n`);
}

const agent = {
  id: "agent-1",
  name: "Ada",
  title: "Researcher",
  description: "",
  provider: "claude",
  model: "claude-sonnet-5-5",
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the review reads only these fields of the agent.
} as AgentSummary;
// biome-ignore lint/nursery/noUnsafeTypeAssertion: the fake generation reads nothing of the model.
const model = { id: "claude-haiku-5-5", provider: "claude" } as AgentModelOption;

let sequence = 0;
function message(author: ConversationMessage["author"], text: string): ConversationMessage {
  sequence += 1;
  return {
    id: `m-${sequence}`,
    author,
    text,
    status: "completed",
    createdAt: new Date(Date.UTC(2026, 10, 20, 0, 0, sequence)).toISOString(),
  };
}

const directory = await mkdtemp(join(tmpdir(), "memory-review-e2e-"));
try {
  const chat: ConversationMessage[] = [];
  const prompts: string[] = [];
  const applied: MemoryReviewOperation[][] = [];
  const drafts: LearnedSkillDraft[] = [];
  const lines: ConversationMessage[] = [];
  let answer = '{"operations":[]}';
  let now = Date.UTC(2026, 10, 20, 12);
  let settings: WorkspaceLearningSettings = { ...DEFAULT_WORKSPACE_LEARNING, memoryReviewTurns: 20 };
  const base: MemoryReviewBase = { epoch: 0, limit: 64, essentialBytes: 0, memories: [] };
  const memories: Pick<AgentMemories, "reviewBase" | "applyReview"> = {
    reviewBase: () => base,
    applyReview: (_agentId, _base, operations) => {
      applied.push([...operations]);
      return operations.map((operation, index) => ({
        memoryId: `memory-${index}`,
        action: "saved" as const,
        text: operation.type === "forget" ? "" : operation.text,
      }));
    },
  };
  const review = new MemoryReview({
    memories,
    profileClients: { hasSpare: () => true, run: (_client, generate) => generate(() => false) },
    state: new MemoryReviewState(join(directory, "state.json")),
    settings: () => settings,
    listAgents: () => [agent],
    model: () => Effect.succeed(model),
    createClient: () => {
      throw new Error("The script has no provider.");
    },
    usageObserver: () => () => undefined,
    chat: () => chat,
    turnActive: () => false,
    appendSystemMessage: (_agentId, line) => {
      lines.push(line);
    },
    skills: () => Effect.succeed([{ skillId: "local-skill-00000000-0000-0000-0000-000000000001", name: "Deploys" }]),
    skillLearner: {
      read: () => Effect.succeed({ description: "Deploys.", instructions: "1. Build.\n2. Ship.", revision: 3 }),
      save: (_agentId, draft) =>
        Effect.sync(() => {
          drafts.push(draft);
          return { action: "revised", skillId: "local-skill-1", revision: 4, skillName: "Deploys" } as const;
        }),
    },
    redact: (text) => text.replaceAll("sk-secret", "[REDACTED]"),
    stopping: () => false,
    now: () => now,
    generate: (_agent, _model, prompt) =>
      Effect.sync(() => {
        prompts.push(prompt);
        return prompt.startsWith("You keep the skills")
          ? '{"description":"Deploys the app.","instructions":"1. Build.\\n2. Test.\\n3. Ship."}'
          : answer;
      }),
  });
  const settle = () => Effect.runPromise(Effect.sleep(20));
  const turns = async (count: number, person: boolean) => {
    for (let index = 0; index < count; index += 1) {
      chat.push(
        person ? message("user", `Please keep answers short. Key sk-secret ${index}`) : message("agent", "FYI"),
      );
      chat.push(message("assistant", "Done."));
      await Effect.runPromise(review.turnEnded(agent.id, { counts: true, person }));
    }
    await settle();
  };

  await turns(25, false);
  check(prompts.length === 0, "25 turns of talk between agents start no review");

  answer = '{"operations":[{"type":"add","text":"The user prefers short answers.","inclusion":"searchable"}]}';
  chat.push(message("user", "Marker before the first review."));
  await turns(1, true);
  check(prompts.length === 1, "a person's turn after the interval starts one review");
  check(prompts[0]?.includes("[REDACTED]") && !prompts[0]?.includes("sk-secret"), "the review prompt is redacted");
  check(applied[0]?.[0]?.type === "add", "the review's memory goes through applyReview");
  check(
    lines.some((line) => line.itemType === "memory-changes"),
    "the chat shows the memory change line",
  );

  chat.push(message("user", "New fact after the review."));
  await turns(20, true);
  check(prompts.length === 1, "the 3-hour gap holds the next review back");

  now += 3 * 60 * 60_000 + 1;
  answer =
    '{"skill":{"action":"update","skillId":"local-skill-00000000-0000-0000-0000-000000000001","signal":"correction","name":"Deploys","message":"Run the tests before the ship step."},"operations":[]}';
  const reviewPrompt = prompts.length;
  await turns(1, true);
  check(prompts.length === reviewPrompt + 2, "a found lesson makes one more generation: the skill writer");
  check(prompts[reviewPrompt]?.includes("Skill rules:"), "Automatic adds the skill rules to the review");
  check(
    !prompts[reviewPrompt]?.includes("Marker before the first review.") &&
      prompts[reviewPrompt]?.includes("New fact after the review."),
    "a later review reads only the chat after its cursor",
  );
  check(drafts[0]?.action === "update" && drafts[0].expectedRevision === 3, "the learner saves the next revision");
  check(
    lines.some((line) => line.itemType?.startsWith("skill") === true),
    "the chat shows the revised skill line",
  );

  settings = { ...settings, memoryReviewTurns: 0 };
  now += 4 * 60 * 60_000;
  const before = prompts.length;
  await turns(30, true);
  check(prompts.length === before, "Off starts no review");

  settings = { ...DEFAULT_WORKSPACE_LEARNING, memoryReviewTurns: 20, dailyReviewLimit: 2 };
  now += 4 * 60 * 60_000;
  await turns(25, true);
  check(prompts.length === before, "the daily limit holds the review back");
  await Effect.runPromise(review.dispose());
  process.stdout.write("memory-review-e2e: all checks passed\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
