import { ActivityView } from "@openbot/ui/features/workspace/ActivityView";
import { NeedsYouSection } from "@openbot/ui/features/workspace/NeedsYou";
import { FocusMenu, type WhenBackRow, WhenBackSection } from "@openbot/ui/features/workspace/WhenBack";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ACTIVITY, artProducer, gameDesigner, NOW, qa } from "./workspace-fixtures";
import { LIGHT, StoryFrame } from "./workspace-story";

const MINUTE = 60_000;

/** A question with choices, an approval, a page step and an FYI that agents held for the owner. */
const ROWS: readonly WhenBackRow[] = [
  {
    key: "question",
    member: gameDesigner,
    kind: "question",
    title: "Launch the Black Friday ad at €20/day? Say ok and I go with €20.",
    detail: "CPA on the test set was €4.10; the course sells at €49.",
    options: ["Ok, €20/day", "€10/day", "Wait until Monday"],
    where: "in #universidad-online",
    at: NOW - 7 * 60 * MINUTE,
  },
  {
    key: "approval",
    member: qa,
    kind: "approval",
    title: "Delete the three old landing pages on aprendivo.com",
    at: NOW - 5 * 60 * MINUTE,
  },
  {
    key: "takeover",
    member: artProducer,
    kind: "takeover",
    title: "Verify the Meta business account (needs your ID)",
    url: "https://business.facebook.com/settings/security",
    at: NOW - 3 * 60 * MINUTE,
  },
  {
    key: "fyi",
    member: gameDesigner,
    kind: "fyi",
    title: "Hotmart sales were 14 this week, up from 9.",
    at: NOW - 40 * MINUTE,
  },
];

const status = () => (
  <div class="ws-when-back-status">
    <FocusMenu labeled quiet={{ kind: "quiet-hours", until: "08:00" }} onFocus={fn()} onSettings={fn()} />
    <span>Pushes wait, except urgent alerts. Agents batch what can wait.</span>
  </div>
);

const activity = (width: string) => () => (
  <StoryFrame width={width}>
    <ActivityView
      items={ACTIVITY}
      onOpen={fn()}
      onMarkAllRead={fn()}
      needsYou={
        <>
          <WhenBackSection rows={ROWS} onAnswer={async () => undefined} onOpenLink={fn()} status={status()} />
          <NeedsYouSection rows={[]} onOpen={fn()} />
        </>
      }
    />
  </StoryFrame>
);

const topBar = () => (
  <StoryFrame width="720px">
    <div class="ws-topbar">
      <FocusMenu quiet={null} onFocus={fn()} onSettings={fn()} />
      <FocusMenu quiet={{ kind: "focus", until: "14:30" }} onFocus={fn()} onSettings={fn()} />
    </div>
  </StoryFrame>
);

const meta = {
  title: "Workspace/WhenBack",
  component: WhenBackSection,
  args: { rows: ROWS, onAnswer: async () => undefined, onOpenLink: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WhenBackSection>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Activity starts with the held requests, answered in place, under the quiet hours line. */
export const ActivityDark: Story = { render: activity("720px") };
export const ActivityLight: Story = { ...LIGHT, render: activity("720px") };
/** An iPhone's width. */
export const ActivityPhone: Story = { render: activity("390px") };
/** The focus button of the top bar, off and on. */
export const TopBarFocus: Story = { render: topBar };
export const TopBarFocusLight: Story = { ...LIGHT, render: topBar };
