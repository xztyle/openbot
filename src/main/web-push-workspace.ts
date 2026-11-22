import { type Channel, type TeamRole, workspaceAgentNoise, workspaceNotifyLevel } from "@openbot/contracts/ipc";
import type { ChannelService } from "../backend/channel-service";
import { type ChannelViewer, channelViewer } from "../backend/channel-visibility";
import type { SpaceService } from "../backend/spaces/space-service";
import type { WebPushWorkspace } from "./web-push";
import type { WorkspaceSidebarStore } from "./workspace-sidebar-store";

export interface WebPushWorkspaceSources {
  channels: Pick<ChannelService, "store" | "readState">;
  spaces: Pick<SpaceService, "store">;
  sidebar: Pick<WorkspaceSidebarStore, "get">;
  /** The role of an active member, or null for a removed or disabled one. */
  memberRole(memberId: string): TeamRole | null;
  /**
   * The host user of this computer as a channel reader, with the other ids that name them, or null
   * before the host runs. Their own messages can carry those ids.
   */
  hostViewer(): ChannelViewer | null;
}

/** The workspace reads of the web push sender (`WebPushWorkspace`), over the host's stores. */
export function webPushWorkspace(sources: WebPushWorkspaceSources): WebPushWorkspace {
  const { channels, spaces, sidebar } = sources;
  const channel = (channelId: string): Channel | null =>
    channels.store.exists(channelId) ? channels.store.get(channelId) : null;
  const slug = (spaceId: string) => spaces.store.get(spaceId)?.slug ?? spaceId;
  return {
    channel,
    channelForThread: (threadId) => {
      const channelId = channels.store.channelForThread(threadId);
      return channelId ? channel(channelId) : null;
    },
    viewer: (memberId) => {
      const role = sources.memberRole(memberId);
      if (!role) return null;
      const host = sources.hostViewer();
      return host?.id === memberId ? host : channelViewer(memberId, role);
    },
    follows: (target, viewer, rootId) => channels.readState.followedSet([target], viewer)(target.id, rootId),
    notifyLevel: (memberId, conversationId) => {
      const prefs = sidebar.get(memberId);
      return prefs ? workspaceNotifyLevel(prefs, conversationId) : null;
    },
    agentNoise: (memberId, agentId) => {
      const prefs = sidebar.get(memberId);
      return prefs ? workspaceAgentNoise(prefs, agentId) : "all";
    },
    channelSpace: (target) => slug(spaces.store.channelSpaceId(target)),
    agentSpace: (agentId) => spaces.store.agentSpace(agentId).slug,
  };
}
