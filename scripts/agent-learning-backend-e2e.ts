// Drives the learning service of the host on real files with a scripted model: the nightly memory
// cleanup (a duplicate merge that applies by itself and its undo, a stale memory that waits, a rule
// after a repeated mistake), the forget of one chat, the space decision log and customer memory, the
// settings history, the "Lessons" part of a playbook, ranked recall and the decision queue.
//
// `bun scripts/agent-learning-backend-e2e.ts`
// Writes report.json to .openbot-build/agent-learning-backend-e2e.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RolePlaybooksSnapshot } from "@openbot/contracts/agent-efficiency";
import type { AgentMemory, AgentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import type { MemoryReviewBase } from "../src/backend/agent/agent-memories";
import type { MemoryReviewOperation } from "../src/backend/agent/memory-review-prompt";
import { AgentLearning, type AgentLearningHooks } from "../src/backend/agent-learning/agent-learning";
import { decisionQueue } from "../src/backend/agent-learning/decision-queue";
import { overlap, withLesson } from "../src/backend/agent-learning/learning-prompts";
import { SettingsHistory, settingsSnapshot, snapshotChanges } from "../src/backend/agent-learning/settings-history";
import { entityKey, SpaceKnowledgeStore } from "../src/backend/agent-learning/space-knowledge";
import { rankedRecall } from "../src/backend/agent-memory-store";

const logger = createOpenBotLogger("agent-learning-backend-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/agent-learning-backend-e2e");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const report: { steps: { name: string; passed: boolean; detail?: string }[]; passed: boolean } = {
  steps: [],
  passed: false,
};

/** A fresh folder for the files of one check, under the report folder. */
function folder(): string {
  return mkdtempSync(join(OUT, "data-"));
}

async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    report.steps.push({ name, passed: true });
  } catch (error) {
    report.steps.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function agent(id: string, change: Partial<AgentSummary> = {}): AgentSummary {
  const summary: AgentSummary = {
    id,
    name: `Agent ${id}`,
    title: "Writer",
    description: "Write posts.",
    notifications: true,
    provider: "claude",
    model: "claude-sonnet",
    reasoningEffort: "medium",
    threadId: `thread-${id}`,
    workspacePath: "/tmp/none",
    preview: "",
    updatedAt: null,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
    ...change,
  };
  return summary;
}

function memory(id: string, text: string, change: Partial<AgentMemory> = {}): AgentMemory {
  return {
    id,
    agentId: "a",
    text,
    origin: "automatic",
    sourceTurnId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...change,
  };
}

/** An in-memory host: memories of one agent, a scripted model, and the calls it got. */
function host(answers: string[], memories: AgentMemory[], chat: ConversationMessage[] = []) {
  const instructions: string[] = [];
  const prompts: string[] = [];
  const state = { memories: [...memories], instructions, prompts };
  const base = (): MemoryReviewBase => ({
    epoch: 0,
    limit: 100,
    essentialBytes: 0,
    memories: state.memories.map((item) => ({ memory: item, inclusion: "searchable", userControlled: false })),
  });
  const root = folder();
  const hooks: AgentLearningHooks = {
    path: join(root, "learning.json"),
    knowledgePath: join(root, "knowledge.json"),
    agents: () => [agent("a")],
    agentSpace: () => "general",
    spaces: () => [{ id: "general", name: "General" }],
    running: () => true,
    timeZone: () => "UTC",
    generate: (_agent, prompt) =>
      Effect.sync(() => {
        state.prompts.push(prompt);
        const text = answers.shift();
        return text === undefined ? null : { text };
      }),
    memoryBase: base,
    applyMemory: (_agentId, _base, operations: MemoryReviewOperation[]) => {
      for (const operation of operations) {
        if (operation.type === "forget")
          state.memories = state.memories.filter((item) => item.id !== operation.memoryId);
        else if (operation.type === "update")
          state.memories = state.memories.map((item) =>
            item.id === operation.memoryId ? { ...item, text: operation.text } : item,
          );
        else state.memories.push(memory(`new-${state.memories.length}`, operation.text));
      }
    },
    memories: () => state.memories,
    forgetMemories: (_agentId, ids) => {
      const before = state.memories.length;
      state.memories = state.memories.filter((item) => !ids.includes(item.id));
      return before - state.memories.length;
    },
    chat: () => chat,
    addInstruction: (_agentId, text) =>
      Effect.sync(() => {
        state.instructions.push(text);
      }),
    playbooks: () => Effect.succeed<RolePlaybooksSnapshot>({ playbooks: [], proposals: [], candidates: [] }),
    addPlaybookLesson: () => Effect.void,
    skills: () => Effect.succeed([]),
    addSkillLesson: () => Effect.void,
    copySkill: () => Effect.void,
    redact: (text) => text,
  };
  return { learning: new AgentLearning(hooks), state };
}

await check("applies a near-duplicate merge by itself and queues the rest for the owner", async () => {
  const { learning, state } = host(
    [
      JSON.stringify({
        merges: [{ keepId: "m1", forgetIds: ["m2"], text: "The owner prefers short weekly reports." }],
        stale: [{ memoryId: "m3", why: "The launch date passed." }],
        mistakes: [{ rule: "Check the image size before posting.", why: "Two posts failed for it." }],
      }),
    ],
    [
      memory("m1", "The owner prefers short weekly reports."),
      memory("m2", "The owner prefers short reports every week."),
      memory("m3", "The launch is on 2026-10-01."),
      memory("m4", "Manual note.", { origin: "manual" }),
    ],
  );
  const items = await Effect.runPromise(learning.dreamAgent("a", true));
  assert.deepEqual(
    items.map((item) => [item.kind, item.risk, item.state]),
    [
      ["memory", "low", "auto-applied"],
      ["memory", "review", "pending"],
      ["instructions", "review", "pending"],
    ],
  );
  assert.deepEqual(
    state.memories.map((item) => item.id),
    ["m1", "m3", "m4"],
  );

  // Undo puts the merged memory back.
  const merged = items[0];
  if (!merged) throw new Error("No merge.");
  const reverted = await Effect.runPromise(learning.decide({ itemId: merged.id, decision: "revert" }));
  assert.equal(reverted.state, "reverted");
  assert.ok(state.memories.map((item) => item.text).includes("The owner prefers short reports every week."));

  // Accepting the rule adds it through the host.
  const rule = items[2];
  if (!rule) throw new Error("No rule.");
  await Effect.runPromise(learning.decide({ itemId: rule.id, decision: "accept" }));
  assert.deepEqual(state.instructions, ["Check the image size before posting."]);
});

await check("never touches a manual memory and marks an item stale when its memory changed", async () => {
  const { learning, state } = host(
    [
      JSON.stringify({
        stale: [
          { memoryId: "m4", why: "Old." },
          { memoryId: "m3", why: "Old." },
        ],
      }),
    ],
    [memory("m3", "The launch is on 2026-10-01."), memory("m4", "Manual note.", { origin: "manual" })],
  );
  const items = await Effect.runPromise(learning.dreamAgent("a", true));
  assert.equal(items.length, 1);
  state.memories = state.memories.map((item) => (item.id === "m3" ? { ...item, text: "Moved to 2026-12-01." } : item));
  const item = items[0];
  if (!item) throw new Error("No item.");
  const decided = await Effect.runPromise(learning.decide({ itemId: item.id, decision: "accept" }));
  assert.equal(decided.state, "stale");
  assert.equal(state.memories.length, 2);
});

await check("refuses a second decision of the same item", async () => {
  const { learning } = host(
    [JSON.stringify({ stale: [{ memoryId: "m3", why: "Old." }] })],
    [memory("m3", "The launch is on 2026-10-01.")],
  );
  const [item] = await Effect.runPromise(learning.dreamAgent("a", true));
  if (!item) throw new Error("No item.");
  await Effect.runPromise(learning.decide({ itemId: item.id, decision: "dismiss" }));
  const again = await Effect.runPromise(Effect.result(learning.decide({ itemId: item.id, decision: "accept" })));
  assert.equal(again._tag, "Failure");
});

await check("finds memories saved in the chat's turns and by reviews that read them", async () => {
  const { learning, state } = host(
    [],
    [
      memory("m1", "Saved in the chat.", { sourceTurnId: "turn-1" }),
      memory("m2", "Saved by a review.", { sourceTurnId: "memory-review-x" }),
      memory("m3", "Saved elsewhere.", { sourceTurnId: "turn-9" }),
      memory("m4", "Written by hand.", { sourceTurnId: "turn-1", origin: "manual" }),
    ],
  );
  await Effect.runPromise(learning.reviewed("a", "memory-review-x", ["turn-2"]));
  await Effect.runPromise(
    learning.knowledge.remember("general", "a", {
      type: "customer",
      name: "Acme",
      fact: "Pays late.",
      sourceTurnId: "turn-2",
    }),
  );
  const turns = new Set(["turn-1", "turn-2"]);
  const dry = await Effect.runPromise(learning.forgetConversation("a", turns, false));
  assert.deepEqual(
    dry.memories.map((item) => item.id),
    ["m1", "m2"],
  );
  assert.equal(dry.facts.length, 1);
  assert.equal(dry.forgotten, 0);
  const done = await Effect.runPromise(learning.forgetConversation("a", turns, true));
  assert.equal(done.forgotten, 3);
  assert.deepEqual(
    state.memories.map((item) => item.id),
    ["m3", "m4"],
  );
});

await check("keeps one entity per spelling of a name and one copy of each fact", async () => {
  const store = new SpaceKnowledgeStore(join(folder(), "knowledge.json"));
  await Effect.runPromise(
    store.remember("s", "a", { type: "customer", name: "ACME Inc.", fact: "Wants invoices in EUR." }),
  );
  await Effect.runPromise(store.remember("s", "b", { type: "customer", name: "acme", fact: "wants invoices in EUR" }));
  await Effect.runPromise(store.remember("s", "b", { type: "customer", name: "Acme", fact: "Orders every Monday." }));
  const snapshot = await Effect.runPromise(store.snapshot("s"));
  assert.equal(snapshot.entities.length, 1);
  assert.deepEqual(
    snapshot.entities[0]?.facts.map((fact) => fact.text),
    ["Wants invoices in EUR.", "Orders every Monday."],
  );
  const found = await Effect.runPromise(store.recall("s", "acme monday"));
  assert.equal(found.entities[0]?.name, "ACME Inc.");
  assert.equal(entityKey("product", "Crème Brûlée"), entityKey("product", "creme brulee"));
  // Another space sees none of it.
  assert.deepEqual((await Effect.runPromise(store.snapshot("other"))).entities, []);
});

await check("logs decisions with their outcome", async () => {
  const store = new SpaceKnowledgeStore(join(folder(), "knowledge.json"));
  const decision = await Effect.runPromise(
    store.logDecision("s", "a", { decision: "Raise the price to 12 EUR.", why: "Costs went up." }),
  );
  assert.equal(await Effect.runPromise(store.setOutcome("other", decision.id, "Sold out.")), null);
  await Effect.runPromise(store.setOutcome("s", decision.id, "Sales held."));
  const recent = await Effect.runPromise(store.recentDecisions("s"));
  assert.equal(recent[0]?.outcome, "Sales held.");
});

await check("records the fields that changed with their author and keeps the newest", async () => {
  const history = new SettingsHistory(join(folder(), "history.json"));
  const before = agent("a");
  const after = agent("a", { description: "Write posts.\nAlways add a hashtag.", model: "claude-opus" });
  const changes = snapshotChanges(settingsSnapshot(before), settingsSnapshot(after));
  assert.deepEqual(
    changes.map((change) => change.field),
    ["instructions", "model"],
  );
  await Effect.runPromise(history.record("a", { kind: "agent", agentId: "lead" }, changes));
  assert.equal(await Effect.runPromise(history.record("a", { kind: "owner" }, [])), null);
  for (let index = 0; index < 35; index += 1)
    await Effect.runPromise(
      history.record("a", { kind: "owner" }, [{ field: "title", before: `${index}`, after: `${index + 1}` }]),
    );
  const list = await Effect.runPromise(history.list("a"));
  assert.equal(list.length, 30);
  assert.equal(list[0]?.changes[0]?.after, "35");
});

await check("adds a lesson to the Lessons part, or makes one", () => {
  assert.equal(
    withLesson("---\nname: x\n---\n\nDo it.", "Check first."),
    "---\nname: x\n---\n\nDo it.\n\n## Lessons\n\n- Check first.\n",
  );
  assert.equal(
    withLesson("Intro\n\n## Lessons\n\n- One\n\n## Other\n\nText", "Two"),
    "Intro\n\n## Lessons\n\n- One\n- Two\n\n## Other\n\nText",
  );
});

await check("measures the overlap of two texts", () => {
  assert.equal(overlap("The owner likes short reports", "short reports, the owner likes"), 1);
  assert.equal(overlap("Bakery opens at nine", "Ads budget is 20 EUR"), 0);
});

await check("ranks a recent memory before an old one of about the same relevance", () => {
  const now = Date.parse("2026-11-22T00:00:00.000Z");
  const ranked = rankedRecall(
    [
      { id: "old", rank: -2, updatedAt: "2025-01-01T00:00:00.000Z" },
      { id: "new", rank: -1.9, updatedAt: "2026-11-20T00:00:00.000Z" },
      { id: "weak", rank: -0.2, updatedAt: "2026-11-21T00:00:00.000Z" },
    ],
    now,
  );
  assert.deepEqual(
    ranked.map((item) => item.id),
    ["new", "old", "weak"],
  );
});

await check("lists every pending proposal in one queue", () => {
  const entries = decisionQueue({
    items: [],
    playbooks: {
      playbooks: [
        { id: "p", slug: "posts", roles: ["Writer"], content: "A\nB", version: 1, updatedAt: "", agentIds: ["a"] },
      ],
      proposals: [
        {
          id: "x",
          playbookId: "p",
          agentId: "a",
          content: "A\nC",
          note: "B is wrong",
          state: "pending",
          createdAt: "2026-11-02",
        },
      ],
      candidates: [],
    },
    reviews: [],
    agentSpace: () => "general",
    agentName: () => "Writer",
  });
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.source, entry.detail]),
    [["playbook:x", "playbook", "B is wrong\n- B\n+ C"]],
  );
});

report.passed = report.steps.length > 0 && report.steps.every((step) => step.passed);
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const step of report.steps)
  logger.info(`${step.passed ? "ok  " : "FAIL"} ${step.name}${step.detail ? `\n     ${step.detail}` : ""}`);
logger.info(`${report.passed ? "Passed" : "Failed"}. Report: ${resolve(OUT, "report.json")}`);
process.exit(report.passed ? 0 : 1);
