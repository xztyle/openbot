import type { WorkspaceController } from "./workspace-controller";

/**
 * What waits for the reader in the open server, as the space rail, the web tab title and the Dock
 * badge count it: the mentions, DM messages and waiting agents of every space, and whether any other
 * message is unread. The rail leaves out a muted conversation, or one set to Nothing; its mentions
 * still count, as Slack's badge counts them. "Just mentions" is in the rail's count already.
 */
export function workspaceAttention(ws: Pick<WorkspaceController, "spaceUnread" | "state" | "notifyLevel">): {
  count: number;
  unread: boolean;
} {
  let count = 0;
  let unread = false;
  for (const space of ws.spaceUnread().values()) {
    count += space.mentions;
    unread ||= space.unread;
  }
  for (const item of ws.state.activity.data?.items ?? [])
    if (item.unread && item.kind === "mention" && ws.notifyLevel(item.channelId) === "nothing") count += 1;
  return { count, unread };
}
