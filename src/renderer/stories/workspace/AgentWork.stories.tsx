import { ThreadPanel } from "@openbot/ui/features/workspace/ThreadPanel";
import { TypingIndicator } from "@openbot/ui/features/workspace/TypingIndicator";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fonikad, gameDesigner, orchestrator, qa, STREAMING_STEPS } from "./workspace-fixtures";
import { CakemakerComposer, CakemakerReplies, CakemakerRoot, LIGHT, StoryFrame } from "./workspace-story";

/* The line over the composer while agents work, with Stop; while the lead chooses who answers; and
   while an agent waits for earlier work. Also the thread panel while the reader reads above the
   newest reply. */

function WorkLine() {
  return (
    <StoryFrame height="auto">
      <div style={{ display: "flex", "flex-direction": "column", gap: "16px", padding: "16px 0" }}>
        <TypingIndicator
          humans={[]}
          agents={[{ member: qa, state: "working", label: "Running the oven timer tests", onStop: fn() }]}
        />
        <TypingIndicator
          humans={[fonikad]}
          agents={[
            {
              member: gameDesigner,
              state: "working",
              trail: { steps: STREAMING_STEPS, durationMs: 48_000 },
              onStop: fn(),
            },
            { member: qa, state: "working", onStop: fn(), stopping: true },
            { member: orchestrator, state: "thinking" },
          ]}
        />
        <TypingIndicator humans={[]} agents={[{ member: qa, state: "working", label: "Read only: no Stop" }]} />
        <TypingIndicator humans={[]} agents={[{ member: orchestrator, state: "routing" }]} />
        <TypingIndicator humans={[]} agents={[{ member: qa, state: "waiting", onStop: fn() }]} />
      </div>
    </StoryFrame>
  );
}

function ThreadAway(props: { newReplies: number }) {
  return (
    <StoryFrame width="420px">
      <ThreadPanel
        channelName="cakemaker"
        root={<CakemakerRoot />}
        replyCount={4}
        replies={<CakemakerReplies />}
        typing={
          <TypingIndicator
            humans={[]}
            agents={[{ member: orchestrator, state: "working", label: "Comparing prices", onStop: fn() }]}
          />
        }
        composer={<CakemakerComposer thread />}
        jump={{ newReplies: props.newReplies, onJump: fn() }}
        following={{ on: true, onChange: fn() }}
        onClose={fn()}
      />
    </StoryFrame>
  );
}

const meta = {
  title: "Workspace/AgentWork",
  component: TypingIndicator,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TypingIndicator>;
export default meta;
type Story = StoryObj<typeof meta>;

export const StopDark: Story = { render: () => <WorkLine /> };
export const StopLight: Story = { ...LIGHT, render: () => <WorkLine /> };
export const ThreadNewRepliesDark: Story = { render: () => <ThreadAway newReplies={3} /> };
export const ThreadNewRepliesLight: Story = { ...LIGHT, render: () => <ThreadAway newReplies={3} /> };
export const ThreadJumpToLatest: Story = { render: () => <ThreadAway newReplies={0} /> };
