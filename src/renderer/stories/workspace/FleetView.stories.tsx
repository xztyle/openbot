import { FleetView } from "@openbot/ui/features/workspace/FleetView";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { FLEET } from "./workspace-fixtures";
import { LIGHT, StoryFrame } from "./workspace-story";

const fleet = () => (
  <StoryFrame>
    <FleetView agents={FLEET} onMessage={fn()} onSettings={fn()} onAddAgent={fn()} />
  </StoryFrame>
);

const meta = {
  title: "Workspace/FleetView",
  component: FleetView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FleetView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { render: fleet };
export const Light: Story = { ...LIGHT, render: fleet };

/** A space with no agents: the empty state offers New agent. */
export const NoAgents: Story = {
  render: () => (
    <StoryFrame>
      <FleetView agents={[]} onMessage={fn()} onSettings={fn()} onAddAgent={fn()} />
    </StoryFrame>
  ),
};
