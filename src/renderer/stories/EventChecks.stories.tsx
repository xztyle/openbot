import type { EventCheckInput } from "@openbot/contracts/event-checks";
import { EventChecksSettings } from "@openbot/ui/features/conversation/EventChecksSettings";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createMockEventChecks } from "../src/preview/mock-event-checks";

const linearIssues: EventCheckInput = {
  agentId: "chief",
  name: "New Linear issues",
  instruction: "Read each new issue, label it, and tell me when it needs my answer.",
  active: true,
  timezone: "Europe/Warsaw",
  schedule: { kind: "interval", amount: 60, unit: "seconds", anchorAt: "2026-10-09T08:00:00.000Z" },
  selfEvents: { mode: "exclude", connectionId: "preview-linear", actorPointer: "/creator/id", accountActorIds: [] },
  source: {
    kind: "mcp",
    connectionId: "preview-linear",
    toolName: "list_issues",
    argumentsJson: '{"team":"ENG"}',
    cursorArgument: "cursor",
    nextCursorPointer: "/cursor",
  },
  selection: { itemsPointer: "/issues", idPointer: "/id", revisionPointer: "/updatedAt" },
};

const assignedIntake: EventCheckInput = {
  agentId: "chief",
  name: "Assigned Linear intake",
  instruction: "Triage each issue that is newly assigned to me.",
  active: false,
  timezone: "Europe/Warsaw",
  schedule: { kind: "weekdays", time: "09:00" },
  selfEvents: { mode: "exclude", connectionId: "API account", actorPointer: "", accountActorIds: [] },
  source: {
    kind: "api",
    connectionId: "Linear workspace",
    toolName: "linear-assigned-intake.mjs",
    argumentsJson: "{}",
    cursorArgument: "cursor",
    nextCursorPointer: "/cursor",
    variables: ["LINEAR_API_KEY"],
    configuration: [
      { name: "team", label: "Team key", description: "The team whose issues the watcher reads.", value: "ENG" },
      { name: "state", label: "Issue state", description: "Only issues in this state start the agent.", value: "" },
    ],
  },
  selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" },
};

function EventChecksStory(props: { checks: EventCheckInput[] }) {
  const api = createMockEventChecks();
  for (const check of props.checks) void api.save(check);
  return (
    <main style={{ position: "relative", width: "380px", height: "720px", background: "var(--openbot-bg-canvas)" }}>
      <div class="agent-routines-overlay">
        <EventChecksSettings api={api} agentId="chief" onBack={fn()} onClose={fn()} onCountChange={fn()} />
      </div>
    </main>
  );
}

const meta = {
  title: "Agent settings/Event checks",
  component: EventChecksSettings,
  parameters: { layout: "centered", a11y: { test: "error" } },
} satisfies Meta<typeof EventChecksSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CheckList: Story = {
  render: () => <EventChecksStory checks={[linearIssues, assignedIntake]} />,
};

export const Empty: Story = {
  render: () => <EventChecksStory checks={[]} />,
};
