import { DraftsView } from "@openbot/ui/features/workspace/DraftsView";
import { SidebarSectionDialog } from "@openbot/ui/features/workspace/SidebarSectionDialog";
import {
  type SidebarChannel,
  type SidebarDirectMessage,
  type SidebarSection,
  WorkspaceSidebar,
} from "@openbot/ui/features/workspace/WorkspaceSidebar";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { CHANNELS, DIRECT_MESSAGES, NOW } from "./workspace-fixtures";
import { CakemakerSidebar, LIGHT, PHONE, PHONE_VIEWPORTS, StoryFrame } from "./workspace-story";

const MINUTE = 60_000;

const meta = {
  title: "Workspace/Sidebar",
  component: WorkspaceSidebar,
  parameters: { layout: "fullscreen", ...PHONE_VIEWPORTS },
} satisfies Meta<typeof WorkspaceSidebar>;
export default meta;
type Story = StoryObj<typeof meta>;

const frame = (activeView?: "fleet") => (
  <StoryFrame width="280px">
    <div style={{ height: "100%", background: "var(--openbot-bg-sidebar)" }}>
      <CakemakerSidebar activeView={activeView} />
    </div>
  </StoryFrame>
);

export const Dark: Story = { render: () => frame() };
export const Light: Story = { ...LIGHT, render: () => frame() };
export const FleetActive: Story = { render: () => frame("fleet") };

const FALLBACK_CHANNEL: SidebarChannel = { id: "c-general", name: "general", visibility: "public" };
const channel = (id: string): SidebarChannel => CHANNELS.find((row) => row.id === id) ?? FALLBACK_CHANNEL;
const direct = (id: string): SidebarDirectMessage =>
  DIRECT_MESSAGES.find((row) => row.id === id) ?? { id, kind: "dm", members: [] };

/**
 * Slack's sections: Starred, a section the reader made with a draft in it, Channels sorted by name,
 * and Direct messages that show only unread conversations.
 */
const SECTIONS: readonly SidebarSection[] = [
  { id: "starred", kind: "starred", items: [{ type: "direct", row: direct("dm-orchestrator") }] },
  {
    id: "section-launch",
    kind: "custom",
    name: "Launch 🚀",
    items: [
      { type: "channel", row: { ...channel("c-cakemaker"), draft: true } },
      { type: "direct", row: { ...direct("group-art"), draft: true } },
    ],
  },
  {
    id: "channels",
    kind: "channels",
    sort: "alpha",
    items: [channel("c-general"), channel("c-leadership"), channel("c-random")].map((row) => ({
      type: "channel" as const,
      row,
    })),
  },
  {
    id: "direct",
    kind: "direct",
    show: "unreads",
    items: [{ type: "direct", row: direct("dm-fonikad") }],
  },
];

const sections = () => (
  <StoryFrame width="280px">
    <div style={{ height: "100%", background: "var(--openbot-bg-sidebar)" }}>
      <WorkspaceSidebar
        workspaceName="Cakemaker"
        onNewMessage={fn()}
        activeConversationId="c-general"
        onSelectView={fn()}
        onSelectConversation={fn()}
        activityCount={3}
        draftCount={2}
        channels={CHANNELS}
        directMessages={DIRECT_MESSAGES}
        sections={SECTIONS}
        onSectionOptions={fn()}
        onCreateSection={fn()}
        onRenameSection={fn()}
        onDeleteSection={fn()}
        onMoveToSection={fn()}
        onReorder={fn()}
        rowMenu={() => [{ id: "star", label: "Star conversation", onSelect: fn() }]}
        onAddChannel={fn()}
        onAddTeammate={fn()}
      />
    </div>
  </StoryFrame>
);

export const Sections: Story = { render: sections };
export const SectionsLight: Story = { ...LIGHT, render: sections };
export const SectionsPhone: Story = { ...PHONE, render: sections };

export const NewSectionDialog: Story = {
  render: () => (
    <SidebarSectionDialog open initialName={null} takenNames={["Launch 🚀"]} onOpenChange={fn()} onSave={fn()} />
  ),
};

const drafts = (tab: "drafts" | "sent") => (
  <StoryFrame width="720px">
    <DraftsView
      tab={tab}
      onTabChange={fn()}
      drafts={[
        {
          id: "c-cakemaker",
          place: { name: "#cakemaker", kind: "channel", inThread: false },
          text: "@Orchestrator the leaderboard still shows yesterday's scores, can you check the cache?",
          at: NOW - 4 * MINUTE,
        },
        {
          id: "group-art/root-1",
          place: { name: "Fonikad, Art Producer, Game Designer", kind: "direct", inThread: true },
          text: "Love the frosting colours. One more pass on the cherry?",
          at: NOW - 3 * 60 * MINUTE,
          fileCount: 2,
        },
      ]}
      onOpenDraft={fn()}
      onDeleteDraft={fn()}
      sent={[
        {
          id: "c-general/m1",
          place: { name: "#general", kind: "channel", inThread: false },
          text: "Ship it on Friday. Thanks, everyone!",
          at: NOW - 30 * MINUTE,
        },
        {
          id: "c-leadership/m2",
          place: { name: "#leadership", kind: "private-channel", inThread: true },
          text: "Budget approved for the web build.",
          at: NOW - 26 * 60 * MINUTE,
        },
      ]}
      onOpenSent={fn()}
    />
  </StoryFrame>
);

export const DraftsAndSent: Story = { render: () => drafts("drafts") };
export const SentMessages: Story = { render: () => drafts("sent") };
