import { ActivityView } from "@openbot/ui/features/workspace/ActivityView";
import { ThreadsView } from "@openbot/ui/features/workspace/ThreadsView";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ACTIVITY, THREADS } from "./workspace-fixtures";
import { LIGHT, StoryFrame } from "./workspace-story";

const activity = () => (
  <StoryFrame width="720px">
    <ActivityView items={ACTIVITY} onOpen={fn()} onMarkAllRead={fn()} />
  </StoryFrame>
);
const threads = () => (
  <StoryFrame width="720px">
    <ThreadsView threads={THREADS} onOpen={fn()} />
  </StoryFrame>
);

const meta = {
  title: "Workspace/ActivityAndThreads",
  component: ActivityView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ActivityView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ActivityDark: Story = { render: activity };
export const ActivityLight: Story = { ...LIGHT, render: activity };
export const ThreadsDark: Story = { render: threads };
export const ThreadsLight: Story = { ...LIGHT, render: threads };

/** The first read runs: placeholder rows, not text. */
export const ActivityLoading: Story = {
  render: () => (
    <StoryFrame width="720px">
      <ActivityView items={[]} loading onOpen={fn()} />
    </StoryFrame>
  ),
};

/** The read failed: the reason and Retry, never the empty text. */
export const ActivityFailed: Story = {
  render: () => (
    <StoryFrame width="720px">
      <ActivityView items={[]} failed onRetry={fn()} onOpen={fn()} />
    </StoryFrame>
  ),
};

/** Nothing to show: what fills the view. */
export const ActivityEmpty: Story = {
  render: () => (
    <StoryFrame width="720px">
      <ActivityView items={[]} onOpen={fn()} />
    </StoryFrame>
  ),
};
