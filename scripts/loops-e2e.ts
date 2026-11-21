// End-to-end check of loops on a fresh, migrated database: templates, items, exit criteria, gates that
// wait for the owner, experiments with budgets, escalation, stage actions and the agent tools.
// Run: bun scripts/loops-e2e.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { handleLoopTool } from "../src/backend/agent/loop-tools";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { LoopTicketRequest } from "../src/backend/loops/loop-service";
import { LoopService } from "../src/backend/loops/loop-service";
import { OpenBotDatabase } from "../src/backend/openbot-database";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures += 1;
  process.stdout.write(
    `${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` ${JSON.stringify(detail)}`}\n`,
  );
}

const root = mkdtempSync(join(tmpdir(), "loops-e2e-"));
const database = new OpenBotDatabase(join(root, "user-data"));
await runCauseEffect(database.initialize());
database.connection.exec(
  "INSERT INTO spaces (space_id, name, slug, icon, hue, position) VALUES ('uo', 'Universidad Online', 'uo', NULL, NULL, 1)",
);
const agents = [
  { id: "agent-lead", name: "Lead" },
  { id: "agent-buyer", name: "Media Buyer" },
  { id: "agent-other", name: "Other space" },
];
const notes: { agentId: string; text: string }[] = [];
const tickets: LoopTicketRequest[] = [];
const loops = LoopService.create(database, {
  agents: () => agents,
  agentSpace: (agentId) => (agentId === "agent-other" ? "general" : "uo"),
  spaceExists: (spaceId) => spaceId === "uo" || spaceId === "general",
  notifyAgent: (agentId, text) => notes.push({ agentId, text }),
  runRoutine: async () => undefined,
  createTicket: async (request) => {
    tickets.push(request);
    return { key: "PUO-99" };
  },
});
const owner = { kind: "person" } as const;
const lead = { kind: "agent", agentId: "agent-lead" } as const;

const board = loops.apply({ kind: "create-loop", spaceId: "uo", templateId: "affiliate-growth" }, owner);
const loopId = board.createdId ?? "";
check("create from template", board.loops.length === 1 && board.loops[0]?.stages.length === 8);
check("templates listed", board.templates.length >= 4);

// Give stage owners and a Motion project, as the owner would in the editor.
const loop = board.loops[0];
if (!loop) throw new Error("no loop");
const definition = {
  ...loop,
  motionProject: "PUO",
  stages: loop.stages.map((stage) => (stage.id === "ads-test" ? { ...stage, ownerAgentId: "agent-buyer" } : stage)),
};
loops.apply({ kind: "update-loop", loopId, definition }, owner);

const item = loops.run(
  { kind: "save-item", loopId, title: "Inglés para Abogados", values: { commission_usd: 35.63 } },
  lead,
);
const itemId = item.createdId ?? "";
check("agent adds item", itemId.length > 0);

const blocked = loops.run({ kind: "move-item", itemId, toStageId: "validate" }, lead);
check("exit criteria block", (blocked.blocked?.length ?? 0) === 3, blocked);
for (const index of [0, 1, 2]) loops.run({ kind: "check", itemId, check: `scout:${index}`, done: true }, lead);
check("move after checklist", !loops.run({ kind: "move-item", itemId, toStageId: "validate" }, lead).blocked);

const skip = loops.run({ kind: "move-item", itemId, toStageId: "scale" }, lead);
check("agent cannot skip stages", (skip.blocked?.length ?? 0) === 1, skip);

const forced = loops.run(
  { kind: "move-item", itemId, toStageId: "landing", force: true, note: "Seasonal, no time" },
  lead,
);
check("gate waits for owner", typeof forced.createdId === "string" && !forced.blocked, forced);
const pending = loops.board("uo").decisions.find((decision) => decision.status === "pending");
check("decision is listed", pending?.kind === "decision" && pending.subject === "move");
check(
  "agent cannot decide",
  (() => {
    try {
      loops.run({ kind: "decide", decisionId: pending?.id ?? "", approve: true }, lead);
      return false;
    } catch {
      return true;
    }
  })(),
);
const again = loops.run({ kind: "move-item", itemId, toStageId: "landing" }, lead);
check("second ask is blocked while pending", (again.blocked?.length ?? 0) === 1);
loops.apply({ kind: "decide", decisionId: pending?.id ?? "", approve: true, note: "Go" }, owner);
const moved = loops.board("uo").items.find((entry) => entry.id === itemId);
check("approval moves item", moved?.stageId === "landing" && moved.pendingDecisionId === undefined, moved);
check(
  "requester gets a note",
  notes.some((note) => note.agentId === "agent-lead" && note.text.includes("approved")),
);
await new Promise((resolve) => setTimeout(resolve, 10));
check(
  "stage tickets requested, by an agent",
  tickets.length === 2 && tickets.every((ticket) => ticket.actorAgentId === "agent-lead"),
  tickets,
);

// An agent cannot remove a gate.
const current = loops.board("uo").loops[0];
if (!current) throw new Error("no loop");
const weakened = {
  ...current,
  stages: current.stages.map((stage) => {
    if (stage.id !== "ads-test") return stage;
    const { gate: _gate, ...rest } = stage;
    return rest;
  }),
};
check(
  "agent cannot remove a gate",
  (() => {
    try {
      loops.run({ kind: "update-loop", loopId, definition: weakened }, lead);
      return false;
    } catch {
      return true;
    }
  })(),
);

// Experiments.
const proposed = loops.proposeExperiment("agent-lead", {
  itemId,
  title: "Angle test",
  hypothesis: "Fear of failing an interview sells more than career growth",
  variants: [{ name: "Fear" }, { name: "Growth" }],
  metric: "cost per sale",
  budgetUsd: 49,
  durationDays: 7,
});
check("budget experiment waits", proposed.experiment.status === "proposed" && Boolean(proposed.decisionId));
check(
  "cannot run before approval",
  (() => {
    try {
      loops.run({ kind: "update-experiment", experimentId: proposed.experiment.id, status: "running" }, lead);
      return false;
    } catch {
      return true;
    }
  })(),
);
loops.apply({ kind: "decide", decisionId: proposed.decisionId ?? "", approve: true }, owner);
loops.run({ kind: "update-experiment", experimentId: proposed.experiment.id, status: "running" }, lead);
loops.run(
  {
    kind: "update-experiment",
    experimentId: proposed.experiment.id,
    status: "done",
    winner: "Fear",
    result: "CPA 18 vs 31 USD",
  },
  lead,
);
const finished = loops.board("uo").experiments.find((entry) => entry.id === proposed.experiment.id);
check("experiment result recorded", finished?.status === "done" && finished.winner === "Fear", finished);

// Escalation.
const question = loops.escalate("agent-lead", itemId, "A buyer asks for an invoice with VAT. Can we give one?");
check(
  "escalation is a pending decision",
  loops.board("uo").decisions.some((entry) => entry.id === question.id && entry.status === "pending"),
);

// Space isolation.
check(
  "other space refused",
  (() => {
    try {
      loops.run({ kind: "save-item", loopId, title: "x" }, { kind: "agent", agentId: "agent-other" });
      return false;
    } catch {
      return true;
    }
  })(),
);

// Agent tools.
const listed = await Effect.runPromise(handleLoopTool("list_loops", {}, "agent-lead", loops));
check("list_loops answers", JSON.stringify(listed).includes("Affiliate course growth loop"));
const external = await Effect.runPromise(
  handleLoopTool(
    "save_loop_item",
    { loopId, externalId: "X53389153C", title: "Abogados", values: { sales: 0 } },
    "agent-lead",
    loops,
  ),
);
const externalAgain = await Effect.runPromise(
  handleLoopTool("save_loop_item", { loopId, externalId: "X53389153C", values: { sales: 2 } }, "agent-lead", loops),
);
check(
  "externalId updates the same item",
  JSON.stringify(external).match(/itemId[^,}]*/)?.[0] === JSON.stringify(externalAgain).match(/itemId[^,}]*/)?.[0],
);
const badMove = await Effect.runPromise(
  handleLoopTool("move_loop_item", { itemId: "nope", toStageId: "scale" }, "agent-lead", loops),
);
check("refusal is a tool result", JSON.stringify(badMove).includes("does not exist"));

const history = loops.board("uo").events.filter((event) => event.itemId === itemId);
check("history recorded", history.length >= 8, history.length);

database.close();
rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  process.stderr.write(`${failures} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("all loop checks passed\n");
