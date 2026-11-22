import type { ChannelMessage } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { HttpError } from "./http-error";

// The channels and messages of agents that a member cannot see (upstream 31b1a0396), for the channel
// and the workspace routes.

/**
 * A channel that has members, all of them agents this peer cannot see, is not in the list of this
 * peer: it has no agent there that it can use or read.
 */
export function seesChannel(members: readonly { agentId: string }[], hiddenAgentIds: ReadonlySet<string>): boolean {
  return members.length === 0 || members.some((item) => !hiddenAgentIds.has(item.agentId));
}

/** A channel that the list leaves out answers as a channel that does not exist. */
export function requireVisibleChannel(
  channels: {
    store: { exists(channelId: string): boolean; get(channelId: string): { members: readonly { agentId: string }[] } };
  },
  channelId: string,
  hiddenAgentIds: ReadonlySet<string>,
): void {
  if (hiddenAgentIds.size === 0 || !channels.store.exists(channelId)) return;
  if (!seesChannel(channels.store.get(channelId).members, hiddenAgentIds))
    throw new HttpError(404, sourceText("error.backend.channelNotFound"));
}

/**
 * A message of an agent that this peer cannot see is not on its page. The agent view removes the
 * author of that message, and the channel codec refuses a message without an author, so the whole
 * page failed for the peer.
 */
export function hiddenAuthor(message: Pick<ChannelMessage, "author">, hiddenAgentIds: ReadonlySet<string>): boolean {
  return message.author.kind === "agent" && hiddenAgentIds.has(message.author.id);
}
