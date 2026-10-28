import { ThreadPanel } from "@openbot/ui/features/workspace/ThreadPanel";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { CakemakerThread, LIGHT, StoryFrame } from "./workspace-story";

const meta = {
  title: "Workspace/ThreadPanel",
  component: ThreadPanel,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ThreadPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

const frame = () => (
  <StoryFrame width="420px">
    <CakemakerThread />
  </StoryFrame>
);

export const Dark: Story = { render: frame };
export const Light: Story = { ...LIGHT, render: frame };
