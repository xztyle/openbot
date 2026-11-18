import { ActivityView } from "@openbot/ui/features/workspace/ActivityView";
import { NeedsYouButton, type NeedsYouRow, NeedsYouSection } from "@openbot/ui/features/workspace/NeedsYou";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ACTIVITY, artProducer, gameDesigner, NOW, qa } from "./workspace-fixtures";
import { LIGHT, StoryFrame } from "./workspace-story";

const MINUTE = 60_000;

/** A takeover, a password, an approval and a question that wait for the reader. */
const ROWS: readonly NeedsYouRow[] = [
  {
    key: "takeover",
    member: gameDesigner,
    kind: "sign-in",
    action: "Sign in on accounts.google.com",
    summary: "Create a Google Account",
    where: "Direct message",
    at: NOW - 3 * 60 * MINUTE,
  },
  {
    key: "secret",
    member: artProducer,
    kind: "secret",
    action: "Enter a password or a code for buffer.com",
    where: "Direct message",
    at: NOW - 40 * MINUTE,
  },
  {
    key: "approval",
    member: qa,
    kind: "approval",
    action: "Approve or decline a request",
    where: "in #cakemaker",
    at: NOW - 12 * MINUTE,
  },
  {
    key: "question",
    member: gameDesigner,
    kind: "question",
    action: "Answer a question",
    summary: "Which niche goes first: news, leaks or trailers?",
    where: "Direct message",
    at: NOW - 2 * MINUTE,
  },
];

const activity = () => (
  <StoryFrame width="720px">
    <ActivityView
      items={ACTIVITY}
      onOpen={fn()}
      onMarkAllRead={fn()}
      needsYou={<NeedsYouSection rows={ROWS} onOpen={fn()} />}
    />
  </StoryFrame>
);

/** The top bar's button; a click opens the list of what waits. */
const button = () => (
  <StoryFrame width="720px">
    <div class="ws-topbar">
      <NeedsYouButton rows={ROWS} onOpen={fn()} />
    </div>
  </StoryFrame>
);

const meta = {
  title: "Workspace/NeedsYou",
  component: NeedsYouSection,
  args: { rows: ROWS, onOpen: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof NeedsYouSection>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Activity starts with what waits for the reader, oldest first. */
export const ActivityDark: Story = { render: activity };
export const ActivityLight: Story = { ...LIGHT, render: activity };
/** An iPhone's width. */
export const ActivityPhone: Story = {
  render: () => (
    <StoryFrame width="390px">
      <ActivityView items={ACTIVITY} onOpen={fn()} needsYou={<NeedsYouSection rows={ROWS} onOpen={fn()} />} />
    </StoryFrame>
  ),
};
export const TopBarButton: Story = { render: button };
export const TopBarButtonLight: Story = { ...LIGHT, render: button };
