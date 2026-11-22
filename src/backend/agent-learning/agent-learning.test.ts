import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RolePlaybooksSnapshot } from "@openbot/contracts/agent-efficiency";
import type { AgentMemory, AgentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryReviewBase } from "../agent/agent-memories";
import type { MemoryReviewOperation } from "../agent/memory-review-prompt";
import { rankedRecall } from "../agent-memory-store";
import { AgentLearning, type AgentLearningHooks } from "./agent-learning";
import { decisionQueue } from "./decision-queue";
import { overlap, withLesson } from "./learning-prompts";
import { SettingsHistory, settingsSnapshot, snapshotChanges } from "./settings-history";
import { entityKey, SpaceKnowledgeStore } from "./space-knowledge";

const roots: string[] = [];

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "openbot-learning-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

describe("the nightly memory cleanup", () => {
  it("applies a near-duplicate merge by itself and queues the rest for the owner", async () => {
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
    expect(items.map((item) => [item.kind, item.risk, item.state])).toEqual([
      ["memory", "low", "auto-applied"],
      ["memory", "review", "pending"],
      ["instructions", "review", "pending"],
    ]);
    expect(state.memories.map((item) => item.id)).toEqual(["m1", "m3", "m4"]);

    // Undo puts the merged memory back.
    const merged = items[0];
    if (!merged) throw new Error("No merge.");
    const reverted = await Effect.runPromise(learning.decide({ itemId: merged.id, decision: "revert" }));
    expect(reverted.state).toBe("reverted");
    expect(state.memories.map((item) => item.text)).toContain("The owner prefers short reports every week.");

    // Accepting the rule adds it through the host.
    const rule = items[2];
    if (!rule) throw new Error("No rule.");
    await Effect.runPromise(learning.decide({ itemId: rule.id, decision: "accept" }));
    expect(state.instructions).toEqual(["Check the image size before posting."]);
  });

  it("never touches a manual memory and marks an item stale when its memory changed", async () => {
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
    expect(items).toHaveLength(1);
    state.memories = state.memories.map((item) =>
      item.id === "m3" ? { ...item, text: "Moved to 2026-12-01." } : item,
    );
    const item = items[0];
    if (!item) throw new Error("No item.");
    const decided = await Effect.runPromise(learning.decide({ itemId: item.id, decision: "accept" }));
    expect(decided.state).toBe("stale");
    expect(state.memories).toHaveLength(2);
  });

  it("refuses a second decision of the same item", async () => {
    const { learning } = host(
      [JSON.stringify({ stale: [{ memoryId: "m3", why: "Old." }] })],
      [memory("m3", "The launch is on 2026-10-01.")],
    );
    const [item] = await Effect.runPromise(learning.dreamAgent("a", true));
    if (!item) throw new Error("No item.");
    await Effect.runPromise(learning.decide({ itemId: item.id, decision: "dismiss" }));
    const again = await Effect.runPromise(Effect.result(learning.decide({ itemId: item.id, decision: "accept" })));
    expect(again._tag).toBe("Failure");
  });
});

describe("the forget of one chat", () => {
  it("finds memories saved in the chat's turns and by reviews that read them", async () => {
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
    expect(dry.memories.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(dry.facts).toHaveLength(1);
    expect(dry.forgotten).toBe(0);
    const done = await Effect.runPromise(learning.forgetConversation("a", turns, true));
    expect(done.forgotten).toBe(3);
    expect(state.memories.map((item) => item.id)).toEqual(["m3", "m4"]);
  });
});

describe("space knowledge", () => {
  it("keeps one entity per spelling of a name and one copy of each fact", async () => {
    const store = new SpaceKnowledgeStore(join(folder(), "knowledge.json"));
    await Effect.runPromise(
      store.remember("s", "a", { type: "customer", name: "ACME Inc.", fact: "Wants invoices in EUR." }),
    );
    await Effect.runPromise(
      store.remember("s", "b", { type: "customer", name: "acme", fact: "wants invoices in EUR" }),
    );
    await Effect.runPromise(store.remember("s", "b", { type: "customer", name: "Acme", fact: "Orders every Monday." }));
    const snapshot = await Effect.runPromise(store.snapshot("s"));
    expect(snapshot.entities).toHaveLength(1);
    expect(snapshot.entities[0]?.facts.map((fact) => fact.text)).toEqual([
      "Wants invoices in EUR.",
      "Orders every Monday.",
    ]);
    const found = await Effect.runPromise(store.recall("s", "acme monday"));
    expect(found.entities[0]?.name).toBe("ACME Inc.");
    expect(entityKey("product", "Crème Brûlée")).toBe(entityKey("product", "creme brulee"));
    // Another space sees none of it.
    expect((await Effect.runPromise(store.snapshot("other"))).entities).toEqual([]);
  });

  it("logs decisions with their outcome", async () => {
    const store = new SpaceKnowledgeStore(join(folder(), "knowledge.json"));
    const decision = await Effect.runPromise(
      store.logDecision("s", "a", { decision: "Raise the price to 12 EUR.", why: "Costs went up." }),
    );
    expect(await Effect.runPromise(store.setOutcome("other", decision.id, "Sold out."))).toBeNull();
    await Effect.runPromise(store.setOutcome("s", decision.id, "Sales held."));
    const recent = await Effect.runPromise(store.recentDecisions("s"));
    expect(recent[0]?.outcome).toBe("Sales held.");
  });
});

describe("settings history", () => {
  it("records the fields that changed with their author and keeps the newest", async () => {
    const history = new SettingsHistory(join(folder(), "history.json"));
    const before = agent("a");
    const after = agent("a", { description: "Write posts.\nAlways add a hashtag.", model: "claude-opus" });
    const changes = snapshotChanges(settingsSnapshot(before), settingsSnapshot(after));
    expect(changes.map((change) => change.field)).toEqual(["instructions", "model"]);
    await Effect.runPromise(history.record("a", { kind: "agent", agentId: "lead" }, changes));
    expect(await Effect.runPromise(history.record("a", { kind: "owner" }, []))).toBeNull();
    for (let index = 0; index < 35; index += 1)
      await Effect.runPromise(
        history.record("a", { kind: "owner" }, [{ field: "title", before: `${index}`, after: `${index + 1}` }]),
      );
    const list = await Effect.runPromise(history.list("a"));
    expect(list).toHaveLength(30);
    expect(list[0]?.changes[0]?.after).toBe("35");
  });
});

describe("helpers", () => {
  it("adds a lesson to the Lessons part, or makes one", () => {
    expect(withLesson("---\nname: x\n---\n\nDo it.", "Check first.")).toBe(
      "---\nname: x\n---\n\nDo it.\n\n## Lessons\n\n- Check first.\n",
    );
    expect(withLesson("Intro\n\n## Lessons\n\n- One\n\n## Other\n\nText", "Two")).toBe(
      "Intro\n\n## Lessons\n\n- One\n- Two\n\n## Other\n\nText",
    );
  });

  it("measures the overlap of two texts", () => {
    expect(overlap("The owner likes short reports", "short reports, the owner likes")).toBe(1);
    expect(overlap("Bakery opens at nine", "Ads budget is 20 EUR")).toBe(0);
  });

  it("ranks a recent memory before an old one of about the same relevance", () => {
    const now = Date.parse("2026-11-22T00:00:00.000Z");
    const ranked = rankedRecall(
      [
        { id: "old", rank: -2, updatedAt: "2025-01-01T00:00:00.000Z" },
        { id: "new", rank: -1.9, updatedAt: "2026-11-20T00:00:00.000Z" },
        { id: "weak", rank: -0.2, updatedAt: "2026-11-21T00:00:00.000Z" },
      ],
      now,
    );
    expect(ranked.map((item) => item.id)).toEqual(["new", "old", "weak"]);
  });

  it("lists every pending proposal in one queue", () => {
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
    expect(entries).toEqual([
      expect.objectContaining({ id: "playbook:x", source: "playbook", detail: "B is wrong\n- B\n+ C" }),
    ]);
  });
});
