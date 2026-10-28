import { ChannelHeader } from "@openbot/ui/features/workspace/ChannelHeader";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { delynith, fonikad, orchestrator, qa } from "./workspace-fixtures";
import { CakemakerHeader, LIGHT } from "./workspace-story";

function Headers() {
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "24px", background: "var(--openbot-bg-canvas)" }}>
      <CakemakerHeader />
      <ChannelHeader
        kind="channel"
        name="leadership"
        visibility="private"
        onEditTopic={fn()}
        members={[delynith, fonikad, orchestrator]}
        memberCount={3}
        onShowMembers={fn()}
        onShowDetails={fn()}
        activePanel="details"
      />
      <ChannelHeader
        kind="dm"
        name="Orchestrator"
        dmMember={orchestrator}
        members={[orchestrator]}
        memberCount={2}
        onShowDetails={fn()}
        onShowArtifacts={fn()}
      />
      <ChannelHeader
        kind="group"
        name="Fonikad, QA"
        members={[fonikad, qa]}
        memberCount={3}
        onShowMembers={fn()}
        onShowDetails={fn()}
      />
    </div>
  );
}

const meta = {
  title: "Workspace/ChannelHeader",
  component: ChannelHeader,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ChannelHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { render: () => <Headers /> };
export const Light: Story = { ...LIGHT, render: () => <Headers /> };
