import type { ReactionEmojiPicker } from "@openbot/ui/features/workspace/MessageRow";
import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import type { JSX } from "@solidjs/web";
import { createContext, useContext } from "solid-js";

/**
 * How an agent chat draws its messages as workspace rows. The owner's DM with an agent is the
 * agent's chat; the workspace provides this around it, so the DM has the faces, names, grouping,
 * action bar and long-press sheet of a channel. A chat without it keeps its bubbles.
 */
export interface ConversationRowLayout {
  /** The reader, as the workspace names and draws them. */
  reader: () => WorkspaceMember;
  /** An agent or a person of the workspace by id. `fallbackName` names one the workspace no longer has. */
  member: (id: string, fallbackName?: string) => WorkspaceMember;
  /** The profile card that a face or a name opens. */
  profile: (member: WorkspaceMember) => JSX.Element;
  /** The one-click reactions of the action bar, as in the workspace's messages. */
  quickReactions: () => readonly string[];
  /** The full emoji picker behind the action bar's react button. */
  emojiPicker: ReactionEmojiPicker;
}

export const ConversationRowLayoutContext = createContext<ConversationRowLayout | null>(null);

export function useConversationRowLayout(): ConversationRowLayout | null {
  return useContext(ConversationRowLayoutContext);
}
