import { createContext, useContext } from "solid-js";

/**
 * How a message names people and channels of the workspace. The workspace view provides it around
 * its message list; an agent chat has none, and a member tag then shows as `@name` text.
 */
export interface MessageMentions {
  /** Whether a member tag names the reader, so the mention is drawn as theirs. */
  isReader: (memberId: string) => boolean;
  /** Opens a channel that a `#channel` link names. */
  onOpenChannel?: ((channelId: string) => void) | undefined;
}

export const MessageMentionsContext = createContext<MessageMentions | null>(null);

export function useMessageMentions(): MessageMentions | null {
  return useContext(MessageMentionsContext);
}
