// The learning card and the agent's learning settings on fake host calls, for
// `scripts/agent-learning-e2e.ts`. Each call the page makes lands in the body's `data-learning-calls`.
// While the body has `data-hold-forget`, the forget preview waits; the "lead" link of the hash
// (`#lead`) shows the settings of another agent. The Cost and performance settings show too; the
// `#role-rolled-back` hash clears the agent's role, as a Roll back of it on the host does. The Role
// field saves with a save bar, as in the agent's settings panel.
import type { LearningReviewItem, SettingsCheckpoint } from "@openbot/contracts/agent-learning";
import { createSettingsDrafts, SettingsDraftsContext } from "@openbot/ui";
import type { AgentProfile } from "@openbot/ui/data";
import { SettingsDraftsSaveBar } from "@openbot/ui/features/settings/SettingsDialogShell";
import { render } from "@solidjs/web";
import { createSignal, createStore, For } from "solid-js";
import { AgentRoleRow } from "../src/features/efficiency/AgentEfficiencySettings";
import { AgentMemorySection, AgentSettingsHistorySection } from "../src/features/efficiency/AgentLearningSettings";
import type { EfficiencyCalls } from "../src/features/efficiency/efficiency-port";
import { LearningCard } from "../src/features/efficiency/LearningCard";
import { StaticI18nProvider } from "../src/i18n-context";
import "../src/styles.css";
import { STORY_AGENT } from "./fixtures";

/** The calls the page made, one per line in `data-learning-calls` of the body, for the script to read. */
const made: string[] = [];
function record(call: string): void {
  made.push(call);
  document.body.dataset.learningCalls = made.join("\n");
}

const items: LearningReviewItem[] = [
  {
    id: "merge",
    kind: "memory",
    source: "dreaming",
    agentId: "chief",
    spaceId: "general",
    title: "Merged 1 duplicate memory",
    note: "Near-identical memories were merged by the nightly cleanup. Undo puts them back.",
    ref: null,
    changes: [{ type: "memory-forget", memoryId: "m2", before: "The owner prefers short reports every week." }],
    risk: "low",
    state: "auto-applied",
    createdAt: "2026-11-22T03:00:00.000Z",
    decidedAt: "2026-11-22T03:00:00.000Z",
  },
  {
    id: "lesson",
    kind: "playbook",
    source: "task",
    agentId: "chief",
    spaceId: "general",
    title: "Lesson for Chief's playbook thumbnails: Check the title is readable at phone size before handing over.",
    note: "The owner sent two thumbnails back for small text.",
    ref: "YT-41 Thumbnail for the bakery video",
    changes: [
      {
        type: "playbook-add",
        playbookId: "p1",
        slug: "thumbnails",
        text: "Check the title is readable at phone size before handing over.",
      },
    ],
    risk: "review",
    state: "pending",
    createdAt: "2026-11-22T10:00:00.000Z",
  },
];

const checkpoints: SettingsCheckpoint[] = [
  {
    id: "c1",
    agentId: "chief",
    at: "2026-11-21T18:00:00.000Z",
    author: { kind: "agent", agentId: "lead" },
    changes: [
      { field: "instructions", before: "Write posts.", after: "Write posts.\nAlways add three hashtags." },
      { field: "model", before: "claude-sonnet-4-5", after: "claude-opus-4-5" },
    ],
  },
];

const unused = () => Promise.reject(new Error("Not used by this page."));
const calls: EfficiencyCalls = {
  sleep: unused,
  modelSavings: unused,
  reviews: unused,
  runReview: unused,
  decideReview: unused,
  playbooks: unused,
  savePlaybook: unused,
  importPlaybook: unused,
  removePlaybook: unused,
  decidePlaybook: unused,
  learning: unused,
  decisionQueue: unused,
  decideQueue: unused,
  decideLearning: async (itemId, decision) => {
    record(`decide:${itemId}:${decision}`);
    const item = items.find((candidate) => candidate.id === itemId) ?? items[0];
    if (!item) throw new Error("No item.");
    return { ...item, state: decision === "accept" ? "applied" : decision === "revert" ? "reverted" : "dismissed" };
  },
  settingsHistory: async () => checkpoints,
  rollback: async (checkpointId) => {
    record(`rollback:${checkpointId}`);
    const checkpoint = checkpoints[0];
    if (!checkpoint) throw new Error("No checkpoint.");
    return checkpoint;
  },
  dream: async (agentId) => {
    record(`dream:${agentId}`);
    return [];
  },
  knowledge: unused,
  removeKnowledge: unused,
  forgetConversation: async (agentId, confirm) => {
    record(`forget:${agentId}:${confirm}`);
    if (document.body.dataset.holdForget !== undefined)
      await new Promise<void>((resolve) => {
        const watch = new MutationObserver(() => {
          if (document.body.dataset.holdForget !== undefined) return;
          watch.disconnect();
          resolve();
        });
        watch.observe(document.body, { attributes: true, attributeFilter: ["data-hold-forget"] });
      });
    return {
      memories: [{ id: "m9", text: "The bakery opens at 8 on Sundays." }],
      facts: [],
      forgotten: confirm ? 1 : 0,
    };
  },
};

function Page() {
  const drafts = createSettingsDrafts((error) => String(error));
  const [list, setList] = createSignal(items);
  const agentOfHash = () => (location.hash === "#lead" ? "lead" : "chief");
  const [agentId, setAgentId] = createSignal(agentOfHash());
  const [agent, setAgent] = createStore<AgentProfile>({ ...STORY_AGENT, playbookRole: "Writer" });
  window.addEventListener("hashchange", () => {
    if (location.hash === "#role-rolled-back")
      setAgent((draft) => {
        draft.playbookRole = undefined;
      });
    else setAgentId(agentOfHash());
  });
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "16px", padding: "16px", "max-width": "880px" }}>
      <For each={list()} keyed={(item) => item.id}>
        {(item) => (
          <LearningCard
            item={item()}
            calls={calls}
            agentName="Chief"
            onDecided={(next) => setList((current) => current.map((entry) => (entry.id === next.id ? next : entry)))}
          />
        )}
      </For>
      <SettingsDraftsContext value={drafts}>
        <div class="settings-modal-card">
          <AgentRoleRow
            agent={agent}
            onUpdateAgent={async (_agentId, updates) => {
              record(`update:${JSON.stringify(updates)}`);
              setAgent((draft) => {
                if ("playbookRole" in updates) draft.playbookRole = updates.playbookRole ?? undefined;
              });
            }}
          />
        </div>
        <SettingsDraftsSaveBar drafts={drafts} label="Unsaved agent changes" />
      </SettingsDraftsContext>
      <AgentSettingsHistorySection
        agentId={agentId()}
        calls={calls}
        agentName={(id) => (id === "lead" ? "Lead" : id)}
      />
      <AgentMemorySection agentId={agentId()} calls={calls} />
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <Page />
      </StaticI18nProvider>
    ),
    root,
  );
