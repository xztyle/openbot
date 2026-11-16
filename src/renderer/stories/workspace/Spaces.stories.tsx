import { type SpaceAgentRow, SpaceAgentsView } from "@openbot/ui/features/spaces/SpaceAgentsView";
import { DeleteSpaceDialog, MoveToSpaceDialog, SpaceDialog } from "@openbot/ui/features/spaces/SpaceDialogs";
import { SpaceRail, type SpaceRailItem } from "@openbot/ui/features/spaces/SpaceRail";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { CakemakerSidebar, LIGHT, StoryFrame } from "./workspace-story";

const meta = {
  title: "Workspace/Spaces",
  component: SpaceRail,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SpaceRail>;
export default meta;
type Story = StoryObj<typeof meta>;

const SPACES: SpaceRailItem[] = [
  { id: "general", name: "General", icon: null, hue: null, unread: false, mentionCount: 0, general: true },
  { id: "trading", name: "Market Sniper", icon: "📈", hue: 215, unread: true, mentionCount: 3, general: false },
  { id: "sales", name: "Universidad Online", icon: null, hue: 30, unread: true, mentionCount: 0, general: false },
  { id: "cakemaker", name: "Cakemaker", icon: "🎂", hue: null, unread: false, mentionCount: 0, general: false },
  { id: "piks", name: "Piks", icon: null, hue: 150, unread: false, mentionCount: 0, general: false },
];

const manage = { onCreate: fn(), onEdit: fn(), onDelete: fn(), onMove: fn() };

const frame = () => (
  <StoryFrame width="340px">
    <div class="ws-spaces-layout" style={{ background: "var(--openbot-bg-sidebar)" }}>
      <SpaceRail spaces={SPACES} activeId="cakemaker" onSelect={fn()} onOpenAgents={fn()} manage={manage} />
      <CakemakerSidebar />
    </div>
  </StoryFrame>
);

/** The rail beside the sidebar: a bar marks the space that shows, a count its mentions, a dot unread messages. */
export const Rail: Story = { render: frame };
export const RailLight: Story = { ...LIGHT, render: frame };

const agents: SpaceAgentRow[] = [
  {
    member: {
      id: "scout",
      kind: "agent" as const,
      name: "Scout",
      avatarSeed: "scout",
      avatarHue: 215,
      avatarUrl: null,
    },
    title: "Market data",
    model: "Codex · gpt-6-luna",
    lastActivityAt: Date.now() - 5 * 60_000,
  },
  {
    member: { id: "risk", kind: "agent" as const, name: "Risk", avatarSeed: "risk", avatarHue: 0, avatarUrl: null },
    title: "Position sizing and limits",
    model: "Claude · claude-opus-5-5",
    lastActivityAt: Date.now() - 3 * 3_600_000,
  },
  {
    member: {
      id: "exec",
      kind: "agent" as const,
      name: "Executor",
      avatarSeed: "exec",
      avatarHue: 150,
      avatarUrl: null,
    },
    title: "",
    model: "Codex · gpt-5.6-terra",
    lastActivityAt: null,
  },
];

/** The Agents view of a space: search, open, move and delete, one or several at once. */
export const Agents: Story = {
  render: () => (
    <StoryFrame>
      <SpaceAgentsView
        spaceName="Market Sniper"
        agents={agents}
        onOpenChat={fn()}
        onMove={fn()}
        onDelete={async () => undefined}
        onAddAgent={fn()}
        onBack={fn()}
      />
    </StoryFrame>
  ),
};

export const CreateDialog: Story = {
  render: () => <SpaceDialog open initial={null} onOpenChange={fn()} onSave={fn()} />,
};

export const EditDialog: Story = {
  render: () => (
    <SpaceDialog open initial={{ name: "Market Sniper", icon: "📈", hue: 215 }} onOpenChange={fn()} onSave={fn()} />
  ),
};

export const MoveDialog: Story = {
  render: () => (
    <MoveToSpaceDialog
      open
      subject="Scout"
      currentId="trading"
      spaces={SPACES.map((space) => ({ id: space.id, name: space.name }))}
      onOpenChange={fn()}
      onMove={fn()}
    />
  ),
};

export const DeleteDialog: Story = {
  render: () => (
    <DeleteSpaceDialog
      open
      name="Piks"
      agentCount={4}
      channelCount={2}
      spaces={SPACES.filter((space) => space.id !== "piks").map((space) => ({ id: space.id, name: space.name }))}
      onOpenChange={fn()}
      onDelete={fn()}
    />
  ),
};
