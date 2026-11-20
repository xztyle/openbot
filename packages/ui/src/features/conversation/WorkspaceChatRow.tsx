import type { AttachmentSummary, InstalledSkill } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import type { AgentMessage, AgentProfile, MessageEventCheckOrigin } from "../../data";
import { Bell } from "../../icons";
import { useText } from "../../text";
import { MessageRow, type ReactionEmojiPicker } from "../workspace/MessageRow";
import type { WorkspaceMember, WorkspaceMenuItem, WorkspaceReaction } from "../workspace/workspace-types";
import type { AttachmentMediaSource } from "./AttachmentCards";
import { formatChatTimestamp } from "./chat-timestamp";
import { MessageBody } from "./MessageRendering";

export interface WorkspaceChatRowProps {
  message: AgentMessage;
  /** The face and the name of the row: the reader, the agent, or another person of the chat. */
  author: WorkspaceMember;
  /** A follow-up by the same author within minutes: no face and no name, the time in the gutter. */
  grouped?: boolean | undefined;
  animate?: boolean | undefined;
  /** Lights the row, such as a message that a link or a search opened. */
  highlighted?: boolean | undefined;
  agents: AgentProfile[];
  skills?: InstalledSkill[] | undefined;
  referencedMessage?: AgentMessage | undefined;
  referencedAuthorName?: string | undefined;
  onOpenReference?: (() => void) | undefined;
  referenceState?: "loading" | "unavailable" | undefined;
  /** The event check that woke the agent for this message: a mark over the text names it. */
  eventCheckOrigin?: MessageEventCheckOrigin | undefined;
  eventCheckIconUrl?: string | null | undefined;
  reactions?: readonly WorkspaceReaction[] | undefined;
  quickReactions?: readonly string[] | undefined;
  emojiPicker?: ReactionEmojiPicker | undefined;
  onToggleReaction?: ((emoji: string) => void) | undefined;
  /** Quotes the message in the composer, from the action bar. */
  onReply?: (() => void) | undefined;
  /** The "more" menu, the right-click menu and the long-press sheet. */
  menuItems?: readonly WorkspaceMenuItem[] | undefined;
  /** Draws the author's profile card, which the face and the name open. */
  profile?: (() => JSX.Element) | undefined;
  /** Content above the text: the steps of the turn that wrote it. */
  before?: JSX.Element;
  /** Content under the text: a voice player, the state of a send that did not go. */
  children?: JSX.Element;
  class?: string | undefined;
  onSelectAgent: (agentId: string) => void;
  onOpenLink: (url: string) => void;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal" | "download") => void;
  onOpenSharedFile?: ((path: string) => void) | undefined;
  onOpenWorkspaceFile?: ((path: string) => void) | undefined;
  onOpenQuote?: ((messageId: string, text: string) => void) | undefined;
  onDownload?: ((attachment: AttachmentSummary) => void) | undefined;
  mediaSource?: AttachmentMediaSource | undefined;
}

/**
 * One message of an agent chat, drawn as a workspace row: the face, the name and the time, the
 * text without a bubble, the action bar on hover and the sheet on a long press. The owner's DM with
 * an agent is its chat, and this row makes it look as a channel or a DM with a person does.
 */
export function WorkspaceChatRow(props: WorkspaceChatRowProps): JSX.Element {
  const { t } = useText();
  const sentAt = () => (props.message.createdAt ? Date.parse(props.message.createdAt) : Number.NaN);
  return (
    <MessageRow
      class={["ws-chat-row", props.animate ? "message-entry-animated" : undefined, props.class]
        .filter(Boolean)
        .join(" ")}
      author={
        // The face of an agent whose reply streams in talks.
        props.message.streaming && props.author.kind === "agent" ? { ...props.author, mood: "talking" } : props.author
      }
      sentAt={sentAt()}
      timeLabel={props.message.time}
      grouped={props.grouped}
      highlighted={props.highlighted}
      reactions={props.reactions}
      quickReactions={props.quickReactions}
      emojiPicker={props.emojiPicker}
      onToggleReaction={props.onToggleReaction}
      onOpenThread={props.onReply}
      replyLabel={t("chat.menu.reply")}
      menuItems={props.menuItems}
      profile={props.profile}
    >
      <Show when={props.eventCheckOrigin}>
        {(origin) => <EventCheckMark origin={origin()} iconUrl={props.eventCheckIconUrl} />}
      </Show>
      {props.before}
      <div class="ws-message-content" data-author={props.message.author === "you" ? "user" : "assistant"}>
        <MessageBody
          animate={props.animate}
          message={props.message}
          referencedMessage={props.referencedMessage}
          referencedAuthorName={props.referencedAuthorName}
          onOpenReference={props.onOpenReference}
          referenceState={props.referenceState}
          agents={props.agents}
          skills={props.skills}
          onSelectAgent={props.onSelectAgent}
          onOpenLink={props.onOpenLink}
          onPreview={props.onPreview}
          onAttachmentAction={props.onAttachmentAction}
          onOpenSharedFile={props.onOpenSharedFile}
          onOpenWorkspaceFile={props.onOpenWorkspaceFile}
          onOpenQuote={props.onOpenQuote}
          onDownload={props.onDownload}
          mediaSource={props.mediaSource}
        />
      </div>
      {props.children}
    </MessageRow>
  );
}

/** "Slack mentions and DMs · 09:03": the event check that woke the agent, over the text. */
function EventCheckMark(props: { origin: MessageEventCheckOrigin; iconUrl?: string | null | undefined }) {
  const { t, format } = useText();
  const [failed, setFailed] = createSignal<string | null>(null);
  const icon = () => (props.iconUrl && props.iconUrl !== failed() ? props.iconUrl : null);
  const label = () => {
    const date = new Date(props.origin.timestamp);
    const time = Number.isNaN(date.getTime()) ? t("chat.marker.unknownTime") : formatChatTimestamp(date, format);
    return t("chat.row.eventCheckOrigin", { name: props.origin.name, time });
  };
  return (
    <p class="ws-message-marks message-origin-chip" role="note" title={label()} aria-label={label()}>
      <span class="ws-message-mark" data-mark="origin">
        <Show when={icon()} fallback={<Bell aria-hidden="true" />} keyed>
          {(src) => (
            <img
              class="message-origin-icon"
              src={src}
              alt=""
              aria-hidden="true"
              draggable={false}
              referrerpolicy="no-referrer"
              onError={() => setFailed(src)}
            />
          )}
        </Show>
        {props.origin.name}
      </span>
    </p>
  );
}
