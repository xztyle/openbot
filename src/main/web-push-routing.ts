import {
  CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX,
  type Channel,
  type ChannelMessage,
  channelKind,
  type WorkspaceNotifyLevel,
} from "@openbot/contracts/ipc";
import type { WebPushLevel } from "@openbot/contracts/team-protocol/web-push-v1";
import { ACTIVITY_ITEM_TYPES } from "../backend/channel-thread-projection";
import { type ChannelViewer, canSeeChannel, isChannelPerson } from "../backend/channel-visibility";

// The decisions of the web push sender (`web-push.ts`) that need no host: which kind of notice a new
// channel message is for one reader, whether the reader's levels let it through, and the address of
// the web client that a tap opens. Scripts check them without a host.

/** A notice about a channel message, as the Activity view sorts it (`channel-activity.ts`). */
export type WebPushChannelKind = "mention" | "dm" | "reply";
/**
 * A notice about an agent event. `needs-takeover` is a browser takeover or a password or code for a
 * browser tab: the user must act, as for a question.
 */
export type WebPushAgentKind = "needs-input" | "needs-approval" | "needs-takeover" | "finished" | "failed";
export type WebPushKind = WebPushChannelKind | WebPushAgentKind;

/** A channel message that is older than this when the host first sees it is not news. */
export const WEB_PUSH_NEW_MESSAGE_MS = 10 * 60 * 1000;

/**
 * Whether a channel message is a finished message that a person reads: not one that still streams, a
 * deleted or replaced one, or thinking, plans, notes and routing events.
 */
export function isWebPushChannelMessage(message: ChannelMessage): boolean {
  if (message.superseded || message.deletedAt !== undefined || message.message.status === "streaming") return false;
  const itemType = message.message.itemType ?? "";
  return !ACTIVITY_ITEM_TYPES.includes(itemType) && !itemType.startsWith(CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX);
}

/**
 * The notice that a new message of a channel is for one reader, or null when it is none of theirs,
 * by the rules of the Activity view: a mention of the reader (or `@channel` and `@here` for a person of
 * the channel), a reply in a thread that the reader follows, or a message in a DM or a group of the
 * reader. The reader's own message, and a message of a channel they cannot see, is none.
 * `follows` says whether the reader follows the thread of a root in this channel.
 */
export function webPushChannelKind(
  message: ChannelMessage,
  channel: Channel,
  viewer: ChannelViewer,
  follows: (rootId: string) => boolean,
): WebPushChannelKind | null {
  if (channel.archived || !canSeeChannel(channel, viewer) || !isWebPushChannelMessage(message)) return null;
  if (message.author.kind === "member" && message.externalAuthor === undefined && viewer.ids.has(message.author.id))
    return null;
  const person = isChannelPerson(channel, viewer);
  const mentioned = (message.mentions ?? []).some((mention) =>
    mention.kind === "member"
      ? mention.id !== undefined && viewer.ids.has(mention.id)
      : (mention.kind === "channel" || mention.kind === "here") && person,
  );
  if (mentioned) return "mention";
  const rootId = message.threadRootId;
  if (rootId !== undefined && follows(rootId)) return "reply";
  if (channelKind(channel) !== "channel" && (rootId === undefined || message.alsoInChannel === true)) return "dm";
  return null;
}

/** A question, an approval or a takeover waits for the reader, so it counts as a mention. */
export function isWebPushRequest(kind: WebPushKind): boolean {
  return kind === "needs-input" || kind === "needs-approval" || kind === "needs-takeover";
}

/**
 * Whether the reader's levels let a notice through, as Slack's: the browser's level for the server
 * (`level`) and the bell of the conversation (`conversation`, from `workspaceNotifyLevel`; null follows
 * the server). Nothing, or a muted conversation, lets nothing through. Just mentions lets mentions,
 * questions and approvals through. With no bell, "all" lets every kind through, and "needs-me" lets
 * mentions and DMs through; the server level of an agent event is applied by
 * `notificationForAgentEvent` before this.
 */
export function webPushAllowed(
  kind: WebPushKind,
  level: WebPushLevel,
  conversation: WorkspaceNotifyLevel | null,
): boolean {
  if (level === "nothing" || conversation === "nothing") return false;
  if (conversation === "mentions") return kind === "mention" || isWebPushRequest(kind);
  if (kind === "reply") return level === "all" || conversation === "all";
  return true;
}

/** The sidebar id of a conversation: a channel id, or `agent:` and the agent id for the DM with an agent. */
export function webPushAgentConversation(agentId: string): string {
  return `agent:${agentId}`;
}

/**
 * One part of a web client path. `encodeURIComponent` leaves `!'()*` as they are; the service worker
 * takes only `[\w%.~-]` in a part, so they are encoded too.
 */
function pathPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16)}`);
}

/** `/app[/s/<host>]/<space>`, as `formatWebLocation` of the web client writes it with `includeHost`. */
function spacePath(hostId: string | null, space: string): string {
  return `/app${hostId ? `/s/${pathPart(hostId)}` : ""}/${pathPart(space)}`;
}

/**
 * The web client address of a channel, DM or group, its thread and a message in it:
 * `/app/s/<host>/<space>/c/<channel>[/t/<root>][/m/<message>]` (`web-location.ts`).
 */
export function webPushChannelPath(
  hostId: string | null,
  space: string,
  channelId: string,
  threadRootId: string | null,
  messageId: string | null,
): string {
  const thread = threadRootId ? `/t/${pathPart(threadRootId)}` : "";
  const message = messageId ? `/m/${pathPart(messageId)}` : "";
  return `${spacePath(hostId, space)}/c/${pathPart(channelId)}${thread}${message}`;
}

/** The web client address of a view of a space, such as `/app/s/<host>/<space>/activity`. */
export function webPushViewPath(hostId: string | null, space: string, view: "activity"): string {
  return `${spacePath(hostId, space)}/${view}`;
}

/** The web client address of the chat with an agent: `/app/s/<host>/<space>/dm/<agent>`. */
export function webPushAgentPath(hostId: string | null, space: string, agentId: string): string {
  return `${spacePath(hostId, space)}/dm/${pathPart(agentId)}`;
}
