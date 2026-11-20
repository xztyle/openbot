import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import type { JSX } from "@solidjs/web";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  type ConversationWorkspaceLayout,
  ConversationWorkspaceLayoutContext,
} from "../../src/features/conversation/conversation-workspace-layout";
import * as Chat from "../Conversation.stories";
import { STORY_AGENTS } from "../fixtures";
import { SPANISH_DM_MESSAGES } from "./agent-dm-spanish";

/*
 * The owner's DM with an agent is the agent's chat, drawn with the workspace's rows: faces, names
 * and times, no bubbles, the action bar on hover and the sheet on a long press. Each story is a
 * state of the agent chat in that layout. `Web/Workspace/Slack workspace` shows it in the full app.
 */

const reader: WorkspaceMember = { id: "preview-user", kind: "human", name: "Preview User", presence: "active" };

const layout: ConversationWorkspaceLayout = {
  reader: () => reader,
  member: (id, fallbackName) => {
    const agent = STORY_AGENTS.find((candidate) => candidate.id === id);
    if (agent)
      return {
        id,
        kind: "agent",
        name: agent.name,
        avatarSeed: agent.avatarSeed,
        avatarHue: agent.avatarHue ?? null,
        avatarUrl: agent.avatarUrl ?? null,
      };
    return { id, kind: "human", name: fallbackName ?? id, presence: "offline" };
  },
  profile: () => null,
  quickReactions: () => ["✅", "👀", "🙌"],
  emojiPicker: { recent: ["🎉", "🚀"], skinTone: 0, onSkinToneChange: () => undefined },
  headerSlot: () => undefined,
  messageLink: (messageId) => `https://bots.example/app/agent/chief/m/${messageId}`,
  composer: {
    toolbarShown: () => true,
    setToolbarShown: () => undefined,
    emojiSearch: () => [],
    noteEmoji: () => undefined,
  },
};

function AgentDmFrame(props: { children: JSX.Element }) {
  return (
    <ConversationWorkspaceLayoutContext value={layout}>
      <section class="ws-agent-dm" style={{ height: "100vh" }}>
        <div class="ws-agent-dm-body">{props.children}</div>
      </section>
    </ConversationWorkspaceLayoutContext>
  );
}

const meta = {
  title: "Workspace/Agent DM",
  component: Chat.default.component,
  args: Chat.default.args,
  parameters: { layout: "fullscreen" },
  render: Chat.default.render,
  decorators: [(Story) => <AgentDmFrame>{Story()}</AgentDmFrame>],
} satisfies Meta<typeof Chat.default.component>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RichConversation: Story = { ...Chat.RichConversation };
export const AllAgentMessageTypes: Story = { ...Chat.AllAgentMessageTypes };
export const SeveralPeople: Story = { ...Chat.SeveralPeople };
export const UnreadMessages: Story = { ...Chat.UnreadMessages };
export const Thinking: Story = { ...Chat.Thinking };
export const ThinkingSettled: Story = { ...Chat.ThinkingSettled };
export const PromptQuestionsInChat: Story = { ...Chat.PromptQuestionsInChat };
export const QueuedDuringApproval: Story = { ...Chat.QueuedDuringApproval };
export const PlanInProgress: Story = { ...Chat.PlanInProgress };
export const MarkdownReplyQuote: Story = { ...Chat.MarkdownReplyQuote };
export const ActionMarkerHistory: Story = { ...Chat.ActionMarkerHistory };

/** A long Spanish DM with inline code, a long path and link, lists, a table and a note to two agents. Check it at phone width. */
export const SpanishLongMessages: Story = {
  ...Chat.RichConversation,
  name: "Spanish long messages",
  args: { messages: SPANISH_DM_MESSAGES },
};

/** The same DM while the agent works: the working line under the newest message. */
export const SpanishWorking: Story = {
  ...Chat.RichConversation,
  name: "Spanish while the agent works",
  args: { messages: SPANISH_DM_MESSAGES, activeTurnId: "es-turn" },
};
