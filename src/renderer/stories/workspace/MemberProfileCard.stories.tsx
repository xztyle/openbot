import { MemberProfileCard } from "@openbot/ui/features/workspace/MemberProfileCard";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { delynith, gameDesigner, orchestrator, qa } from "./workspace-fixtures";
import { LIGHT, profileOf } from "./workspace-story";

function Cards() {
  return (
    <div
      style={{
        display: "flex",
        "flex-wrap": "wrap",
        gap: "24px",
        padding: "24px",
        background: "var(--openbot-bg-canvas)",
      }}
    >
      {[delynith, orchestrator, qa].map((member) => (
        <div class="ui-popover-menu-surface" style={{ width: "300px", overflow: "hidden" }}>
          {profileOf(member)}
        </div>
      ))}
      <div class="ui-popover-menu-surface" style={{ width: "300px", overflow: "hidden" }}>
        <MemberProfileCard
          member={gameDesigner}
          title="Game Designer"
          description="Designs levels, the economy and how the game feels."
          model="claude-sonnet-5"
          status={{ state: "waiting", personName: "delynith", channelName: "cakemaker" }}
          computer={["browser"]}
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Workspace/MemberProfileCard",
  component: MemberProfileCard,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MemberProfileCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { render: () => <Cards /> };
export const Light: Story = { ...LIGHT, render: () => <Cards /> };
