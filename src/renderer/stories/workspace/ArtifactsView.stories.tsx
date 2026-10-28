import { ArtifactsView } from "@openbot/ui/features/workspace/ArtifactsView";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ARTIFACTS } from "./workspace-fixtures";
import { LIGHT, StoryFrame } from "./workspace-story";

const gallery = () => (
  <StoryFrame>
    <ArtifactsView artifacts={ARTIFACTS} onOpen={fn()} />
  </StoryFrame>
);
const empty = () => (
  <StoryFrame>
    <ArtifactsView artifacts={[]} channelName="leadership" onOpen={fn()} onClose={fn()} />
  </StoryFrame>
);

const meta = {
  title: "Workspace/ArtifactsView",
  component: ArtifactsView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ArtifactsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { render: gallery };
export const Light: Story = { ...LIGHT, render: gallery };
export const Empty: Story = { render: empty };
