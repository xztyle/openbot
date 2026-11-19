import {
  type OrgChartAgent,
  type OrgChartAgentState,
  type OrgChartMessage,
  OrgChartView,
} from "@openbot/ui/features/org-chart/OrgChartView";
import type { AgentWorkStatus } from "@openbot/ui/features/workspace/workspace-types";
import { createSignal, onSettled } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { LIGHT, StoryFrame } from "./workspace-story";

/** One agent of the story org: id, name, title, manager, state and what it does. */
type Seed = [id: string, name: string, title: string, manager: string | null, state: OrgChartAgentState, now?: string];

/** Two roots, three levels under each, 26 agents, as a sales and a landing-page team. */
const SEEDS: readonly Seed[] = [
  ["cso", "CSO", "Director de Ventas", null, "working", "Reviewing the Q4 pipeline with the product leads"],
  ["lead-cursos", "Líder de Producto", "Cursos online", "cso", "working", "Writing the brief for the spring launch"],
  ["lead-master", "Líder de Producto", "Másteres", "cso", "waiting", "Approve the ad budget for November"],
  ["lead-becas", "Líder de Producto", "Becas", "cso", "idle"],
  ["data", "Analista de Datos", "Funnel and cohort reports", "cso", "idle"],
  ["ux", "Diseñador UX", "Course landing pages", "lead-cursos", "working", "Editing checkout-flow.fig"],
  ["qa-web", "QA Web", "Regression on the course site", "lead-cursos", "idle"],
  ["meta-ads", "Media Buyer Meta", "Paid social", "lead-cursos", "working", "Searching the web for CPM benchmarks"],
  ["copy", "Copywriter", "Ads and emails", "lead-cursos", "idle"],
  ["research", "Investigador de Mercado", "Competitor pricing", "lead-cursos", "idle"],
  ["visual", "Diseñadora Visual", "Brand and banners", "lead-master", "working", "Exporting 12 banner sizes"],
  ["qa-app", "QA App", "Mobile app checks", "lead-master", "idle"],
  [
    "google-ads",
    "Media Buyer Google",
    "Search and YouTube",
    "lead-master",
    "failed",
    "The last turn stopped: quota exceeded",
  ],
  ["seo", "Analista SEO", "Organic search", "lead-master", "idle"],
  ["community", "Community Manager", "Instagram and TikTok", "lead-becas", "idle"],
  ["video", "Editor de Vídeo", "Reels and shorts", "lead-becas", "working", "Rendering reel-03.mp4"],
  ["translate", "Traductor", "EN and PT versions", "lead-becas", "idle"],
  ["email", "Gestor de Email", "Campaigns and flows", "lead-becas", "idle"],
  ["puo", "PUO", "Director de Diseño de Landings", null, "idle"],
  ["layout-a", "Maquetador A", "Landing builds", "puo", "working", "Running npm run build"],
  ["layout-b", "Maquetador B", "Landing builds", "puo", "idle"],
  ["cro", "Revisor de Conversión", "CRO audits", "puo", "waiting", "Sign in on analytics.google.com"],
  ["illustrator", "Ilustrador", "Spot illustrations", "puo", "idle"],
  ["experiments", "Jefa de Experimentos", "A/B tests", "puo", "working", "Comparing variant B against control"],
  ["ab", "Analista A/B", "Test statistics", "experiments", "idle"],
  ["variants", "Diseñador de Variantes", "Test variants", "experiments", "working", "Drawing variant C of the hero"],
];

const MODELS = [
  ["gpt-5.5", "High"],
  ["claude-opus-4-1", "Medium"],
  ["gpt-5.5-mini", "Low"],
] as const;

function status(state: OrgChartAgentState, now: string | undefined): AgentWorkStatus {
  if (state === "working") return { state: "working", task: now ?? "", channelName: "lanzamiento" };
  if (state === "waiting") return { state: "waiting", personName: "Alejandro" };
  return { state: "idle" };
}

const AGENTS: OrgChartAgent[] = SEEDS.map(([id, name, title, manager, state, now], index) => {
  const [model, effort] = MODELS[index % MODELS.length] ?? MODELS[0];
  return {
    member: { id, kind: "agent", name, avatarSeed: id, avatarHue: null, working: state === "working" },
    title,
    managerId: manager,
    model,
    effort,
    state,
    status: status(state, now),
    activity: state === "idle" ? undefined : now,
    queued: state === "working" && index % 3 === 0 ? 2 : undefined,
    preview: "Done: the November report is in the shared folder.",
    background: id === "ab",
  };
});

/** Sends a message between two agents every two seconds, so the pulses show. */
function LiveChart(props: { initialAgentId?: string; light?: boolean }) {
  const [agents, setAgents] = createSignal(AGENTS);
  const [messages, setMessages] = createSignal<readonly OrgChartMessage[]>([]);
  const pairs = [
    ["cso", "lead-master"],
    ["ux", "lead-cursos"],
    ["experiments", "variants"],
    ["lead-becas", "video"],
    ["cro", "puo"],
  ] as const;
  onSettled(() => {
    let count = 0;
    const timer = setInterval(() => {
      const [from, to] = pairs[count % pairs.length] ?? pairs[0];
      count += 1;
      setMessages((current) => [...current.slice(-10), { id: `message-${count}`, from, to }]);
    }, 2_000);
    return () => clearInterval(timer);
  });
  return (
    <StoryFrame>
      <OrgChartView
        agents={agents()}
        messages={messages()}
        initialAgentId={props.initialAgentId}
        onOpenChat={fn()}
        onChangeManager={async (agentId, managerId) => {
          setAgents((current) =>
            current.map((agent) => (agent.member.id === agentId ? { ...agent, managerId } : agent)),
          );
        }}
      />
    </StoryFrame>
  );
}

const meta = {
  title: "Workspace/OrgChart",
  component: OrgChartView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof OrgChartView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { render: () => <LiveChart /> };
export const Light: Story = { ...LIGHT, render: () => <LiveChart /> };

/** An agent's panel: what it does now, its manager and its reports. */
export const AgentPanel: Story = { render: () => <LiveChart initialAgentId="lead-master" /> };
export const AgentPanelLight: Story = { ...LIGHT, render: () => <LiveChart initialAgentId="lead-master" /> };

/** Read-only: a reader who cannot change the agents gets no drag and no Change manager. */
export const ReadOnly: Story = {
  render: () => (
    <StoryFrame>
      <OrgChartView agents={AGENTS} onOpenChat={fn()} />
    </StoryFrame>
  ),
};

/** A space with no agents. */
export const NoAgents: Story = {
  render: () => (
    <StoryFrame>
      <OrgChartView agents={[]} onOpenChat={fn()} />
    </StoryFrame>
  ),
};
