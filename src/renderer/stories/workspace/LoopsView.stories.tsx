import type { Loop, LoopDecision, LoopItem, WorkspaceLoops } from "@openbot/contracts/ipc";
import { LoopsView } from "@openbot/ui/features/workspace/LoopsView";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AGENTS, artProducer, gameDesigner, NOW, orchestrator, qa } from "./workspace-fixtures";
import { LIGHT, PHONE, PHONE_VIEWPORTS, StoryFrame } from "./workspace-story";

const DAY = 86_400_000;

const loop: Loop = {
  id: "loop-affiliate",
  spaceId: "uo",
  templateId: "affiliate-growth",
  name: "Affiliate course growth loop",
  motionProject: "PUO",
  createdAt: NOW - 20 * DAY,
  updatedAt: NOW - DAY,
  fields: [
    { key: "product_id", label: "Product ID", type: "text", card: true },
    { key: "commission_usd", label: "Commission", type: "money", card: true },
    { key: "budget_usd", label: "Approved budget", type: "money" },
    { key: "spend_usd", label: "Spend", type: "money", card: true },
    { key: "sales", label: "Sales", type: "number", card: true },
    { key: "roas", label: "ROAS", type: "number", card: true },
  ],
  stages: [
    {
      id: "scout",
      name: "Scout",
      ownerAgentId: orchestrator.id,
      checklist: ["Affiliate link works", "Price and commission read"],
      slaDays: 3,
    },
    {
      id: "validate",
      name: "Validate",
      ownerRole: "Niche lead",
      checklist: ["Demand checked", "Competitor ads reviewed"],
      slaDays: 5,
    },
    { id: "landing", name: "Landing", ownerAgentId: gameDesigner.id, gate: { kind: "decision" }, slaDays: 7 },
    {
      id: "ads-test",
      name: "Ads test",
      ownerAgentId: qa.id,
      gate: { kind: "money", amountField: "budget_usd" },
      slaDays: 10,
    },
    {
      id: "measure",
      name: "Measure",
      ownerAgentId: artProducer.id,
      exitMetrics: [{ field: "sales", op: ">=", value: 1 }],
      next: ["scale", "killed"],
    },
    { id: "scale", name: "Scale", gate: { kind: "money" }, next: ["killed", "done"] },
    { id: "done", name: "Done", outcome: "won" },
    { id: "killed", name: "Killed", outcome: "killed" },
  ],
};

const item = (
  id: string,
  title: string,
  stageId: string,
  values: LoopItem["values"],
  extra: Partial<LoopItem> = {},
): LoopItem => ({
  id,
  loopId: loop.id,
  title,
  stageId,
  values,
  checks: [],
  enteredAt: NOW - 2 * DAY,
  createdAt: NOW - 9 * DAY,
  updatedAt: NOW - DAY,
  ...extra,
});

const items: LoopItem[] = [
  item(
    "i1",
    "Inglés para Abogados",
    "validate",
    { product_id: "X53389153C", commission_usd: 35.63 },
    { checks: ["validate:0"] },
  ),
  item("i2", "Cena Navideña", "ads-test", {
    product_id: "C1",
    commission_usd: 12,
    budget_usd: 98,
    spend_usd: 21.4,
    sales: 1,
  }),
  item("i3", "De no hablar nada a hablar inglés", "measure", {
    product_id: "U88029920I",
    spend_usd: 49,
    sales: 4,
    roas: 1.8,
  }),
  item("i4", "Mascotas felices", "scout", {}, { enteredAt: NOW - 6 * DAY }),
  item("i5", "Inglés médico", "landing", { product_id: "M2" }, { pendingDecisionId: "d1" }),
  item("i6", "Alemán para viajar", "killed", { spend_usd: 30, sales: 0 }),
];

const decisions: LoopDecision[] = [
  {
    id: "d2",
    spaceId: "uo",
    loopId: loop.id,
    itemId: "i3",
    kind: "money",
    subject: "experiment",
    title: "Experiment budget: Fear vs growth angle (De no hablar nada a hablar inglés)",
    detail:
      "Fear of failing an interview sells more than career growth.\nVariants: Fear, Growth. Metric: cost per sale. 7 days.",
    amountUsd: 49,
    requestedBy: artProducer.id,
    status: "pending",
    createdAt: NOW - 3_600_000,
  },
  {
    id: "d1",
    spaceId: "uo",
    loopId: loop.id,
    itemId: "i5",
    kind: "decision",
    subject: "move",
    title: "Inglés médico: move to Landing",
    detail: "Select this product and approve the affiliation.",
    requestedBy: orchestrator.id,
    toStageId: "landing",
    status: "pending",
    createdAt: NOW - 7_200_000,
  },
];

const board: WorkspaceLoops = {
  spaceId: "uo",
  loops: [
    loop,
    {
      ...loop,
      id: "loop-inbox",
      name: "Customer inbox",
      stages: [
        { id: "new", name: "New" },
        { id: "closed", name: "Closed", outcome: "done" },
      ],
      fields: [],
    },
  ],
  items,
  experiments: [
    {
      id: "e1",
      loopId: loop.id,
      itemId: "i3",
      title: "Landing headline",
      hypothesis: "A promise in days beats a promise of fluency.",
      variants: [{ name: "30 days" }, { name: "Fluent" }],
      metric: "cost per sale",
      budgetUsd: 20,
      durationDays: 5,
      status: "done",
      winner: "30 days",
      result: "CPA 14 vs 22 USD on 3,100 visits.",
      createdAt: NOW - 8 * DAY,
      updatedAt: NOW - 2 * DAY,
    },
  ],
  decisions,
  events: [
    {
      id: "ev1",
      loopId: loop.id,
      itemId: "i3",
      at: NOW - 2 * DAY,
      kind: "moved",
      actorKind: "agent",
      actorId: qa.id,
      from: "ads-test",
      to: "measure",
    },
    {
      id: "ev2",
      loopId: loop.id,
      itemId: "i3",
      at: NOW - 3 * DAY,
      kind: "updated",
      actorKind: "agent",
      actorId: artProducer.id,
      text: "Updated spend_usd, sales",
    },
  ],
  templates: [
    {
      id: "affiliate-growth",
      name: "Affiliate course growth loop",
      description: "Find a course, validate, landing, paid test, measure, scale or kill.",
      stageNames: ["Scout", "Validate", "Landing", "Ads test", "Measure", "Scale", "Done", "Killed"],
    },
    {
      id: "content-pipeline",
      name: "Content pipeline",
      description: "Idea to script to edit to publish to measure.",
      stageNames: ["Idea", "Script", "Edit", "Publish", "Measure", "Done"],
    },
  ],
};

const render = (args: { board: WorkspaceLoops | null }) => (
  <StoryFrame>
    <LoopsView board={args.board} agents={AGENTS} canEdit onAction={fn(async () => board)} onBack={fn()} />
  </StoryFrame>
);

const meta = {
  title: "Workspace/LoopsView",
  component: LoopsView,
  parameters: { layout: "fullscreen", ...PHONE_VIEWPORTS },
} satisfies Meta<typeof LoopsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Board: Story = { render: () => render({ board }) };
export const BoardLight: Story = { ...LIGHT, render: () => render({ board }) };
export const Phone: Story = { ...PHONE, render: () => render({ board }) };
export const Empty: Story = {
  render: () => render({ board: { ...board, loops: [], items: [], decisions: [], events: [], experiments: [] } }),
};
