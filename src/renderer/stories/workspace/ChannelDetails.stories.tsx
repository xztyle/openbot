import { Button } from "@openbot/ui";
import { ChannelDetails, type ChannelDetailsTab } from "@openbot/ui/features/workspace/ChannelDetails";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { DETAILS_MEMBERS, delynith, NOW } from "./workspace-fixtures";
import { LIGHT, StoryFrame } from "./workspace-story";

function Details(props: { tab: ChannelDetailsTab }) {
  return (
    <StoryFrame width="420px">
      <ChannelDetails
        defaultTab={props.tab}
        channel={{
          name: "cakemaker",
          visibility: "public",
          topic: "Ship the web build of Cakemaker by Friday 🎂",
          description: "Everything about the Cakemaker game: design, art, builds and QA.",
          createdBy: delynith,
          createdAt: NOW - 9 * 86_400_000,
          coordinatorRouting: false,
        }}
        members={DETAILS_MEMBERS}
        onClose={fn()}
        onEditTopic={fn()}
        onEditDescription={fn()}
        onAddMembers={fn()}
        onRemoveMember={fn()}
        onAnswerModeChange={fn()}
        onFocusChange={fn()}
        onGateChange={fn()}
        integrations={
          <div style={{ display: "flex", "align-items": "center", gap: "12px", padding: "12px 16px" }}>
            <span style={{ flex: "1" }}>Discord · #cakemaker-dev</span>
            <Button size="xs" variant="secondary">
              Unlink
            </Button>
          </div>
        }
        onVisibilityChange={fn()}
        onCoordinatorRoutingChange={fn()}
        onArchive={fn()}
        onLeave={fn()}
      />
    </StoryFrame>
  );
}

const meta = {
  title: "Workspace/ChannelDetails",
  component: ChannelDetails,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ChannelDetails>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AboutDark: Story = { render: () => <Details tab="about" /> };
export const AboutLight: Story = { ...LIGHT, render: () => <Details tab="about" /> };
export const MembersDark: Story = { render: () => <Details tab="members" /> };
export const MembersLight: Story = { ...LIGHT, render: () => <Details tab="members" /> };
export const Integrations: Story = { render: () => <Details tab="integrations" /> };
export const Settings: Story = { render: () => <Details tab="settings" /> };
