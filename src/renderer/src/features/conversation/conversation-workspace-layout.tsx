import type { ComposerEmoji } from "@openbot/ui/features/conversation/composer-picker";
import type { ReactionEmojiPicker } from "@openbot/ui/features/workspace/MessageRow";
import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import type { JSX } from "@solidjs/web";
import { createContext, useContext } from "solid-js";

/**
 * How an agent chat looks as a workspace conversation. The owner's DM with an agent is the agent's
 * chat; the workspace provides this around it, so the DM has the rows of a channel (faces, names,
 * grouping, the action bar and the long-press sheet) and its message box (the formatting toolbar,
 * emoji). A chat without it keeps its bubbles and its own box.
 */
export interface ConversationWorkspaceLayout {
  /** The reader, as the workspace names and draws them. */
  reader: () => WorkspaceMember;
  /** An agent or a person of the workspace by id. `fallbackName` names one the workspace no longer has. */
  member: (id: string, fallbackName?: string) => WorkspaceMember;
  /** The profile card that a face or a name opens. */
  profile: (member: WorkspaceMember) => JSX.Element;
  /** The one-click reactions of the action bar, as in the workspace's messages. */
  quickReactions: () => readonly string[];
  /** The full emoji picker behind the action bar's react button and the box's emoji button. */
  emojiPicker: ReactionEmojiPicker;
  /** A link that opens a message of this chat again, for "Copy link". Null where the client has none. */
  messageLink: (messageId: string) => string | null;
  /**
   * Where the chat's controls (the model, search, the side panel) go: the workspace's header of the
   * DM. One header row then names the agent and holds its controls, as a channel's header does.
   */
  headerSlot: () => HTMLElement | undefined;
  /** The message box of the workspace. */
  composer: {
    /** Whether the formatting toolbar shows: one choice for every message box, as Slack's "Aa". */
    toolbarShown: () => boolean;
    setToolbarShown: (shown: boolean) => void;
    /** Slack's `:smile`: the emoji whose short code starts with the letters. */
    emojiSearch: (query: string) => ComposerEmoji[];
    /** Notes an emoji the reader picked, so it leads the recent ones. */
    noteEmoji: (emoji: string) => void;
  };
}

export const ConversationWorkspaceLayoutContext = createContext<ConversationWorkspaceLayout | null>(null);

export function useConversationWorkspaceLayout(): ConversationWorkspaceLayout | null {
  return useContext(ConversationWorkspaceLayoutContext);
}
