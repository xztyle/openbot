import { ArtifactCard } from "@openbot/ui/features/workspace/ArtifactCard";
import { MessageRow } from "@openbot/ui/features/workspace/MessageRow";
import { StepTrail } from "@openbot/ui/features/workspace/StepTrail";
import { TypingIndicator } from "@openbot/ui/features/workspace/TypingIndicator";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  ARTIFACTS,
  CAKEMAKER_SITE,
  delynith,
  fonikad,
  gameDesigner,
  NOW,
  orchestrator,
  qa,
  STREAMING_STEPS,
  text,
} from "./workspace-fixtures";
import { CakemakerMessages, CakemakerTyping, LIGHT, StoryFrame } from "./workspace-story";

/* The rows of a channel: messages, grouped follow-ups, edits, deletes, reactions, threads, step trails,
   artifacts, day and "new" dividers, events and the typing line. */

const byId = (id: string) => ARTIFACTS.find((artifact) => artifact.id === id) ?? CAKEMAKER_SITE;

function Channel() {
  return (
    <StoryFrame>
      <CakemakerMessages />
      <CakemakerTyping />
    </StoryFrame>
  );
}

function AgentAtWork() {
  return (
    <StoryFrame>
      <div style={{ "padding-top": "24px" }}>
        <MessageRow
          author={qa}
          sentAt={NOW - 60_000}
          text={[text("Fixing the oven timer now. I will post the build when the tests pass.")]}
          onToggleReaction={fn()}
          onOpenThread={fn()}
        >
          <StepTrail steps={STREAMING_STEPS} durationMs={48_000} streaming />
        </MessageRow>
        <MessageRow
          author={gameDesigner}
          sentAt={NOW - 30_000}
          text={[text("Here is everything we built this week:")]}
          onToggleReaction={fn()}
        >
          <ArtifactCard artifact={byId("art-gdd")} onOpen={fn()} compact />
          <ArtifactCard artifact={byId("art-editor")} onOpen={fn()} />
        </MessageRow>
        <TypingIndicator
          humans={[delynith, fonikad]}
          agents={[
            { member: orchestrator, state: "thinking" },
            { member: qa, state: "working", label: "bun run test --filter oven" },
          ]}
        />
      </div>
    </StoryFrame>
  );
}

const meta = {
  title: "Workspace/MessageList",
  component: MessageRow,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MessageRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { render: () => <Channel /> };
export const Light: Story = { ...LIGHT, render: () => <Channel /> };
export const AgentWorkingDark: Story = { render: () => <AgentAtWork /> };
export const AgentWorkingLight: Story = { ...LIGHT, render: () => <AgentAtWork /> };
