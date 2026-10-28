import {
  type Channel,
  canAdministerServer,
  channelKind,
  channelVisibility,
  type TeamRole,
} from "@openbot/contracts/ipc";

/**
 * The person who reads or changes a channel. `ids` holds every id that names this person in
 * `humanMemberIds` and in message authors: the host user of a computer has the signed-out id and
 * the account id as well as the team member id.
 */
export interface ChannelViewer {
  id: string;
  ids: ReadonlySet<string>;
  role: TeamRole;
}

export function channelViewer(id: string, role: TeamRole, aliases: readonly string[] = []): ChannelViewer {
  return { id, ids: new Set([id, ...aliases]), role };
}

/** Whether the viewer is one of the people of the channel. */
export function isChannelPerson(channel: Channel, viewer: ChannelViewer): boolean {
  return (channel.humanMemberIds ?? []).some((id) => viewer.ids.has(id));
}

/**
 * Who sees a channel: everyone sees a public channel. A private channel shows to its people and to
 * the owners and admins of the server. A DM or a group shows only to its people, also for an owner.
 */
export function canSeeChannel(channel: Channel, viewer: ChannelViewer): boolean {
  if (channelKind(channel) !== "channel") return isChannelPerson(channel, viewer);
  if (channelVisibility(channel) === "public") return true;
  return isChannelPerson(channel, viewer) || canAdministerServer(viewer.role);
}

/** Who changes the people, the agents or the details of a channel that they can see. */
export function canManageChannel(channel: Channel, viewer: ChannelViewer): boolean {
  if (channelVisibility(channel) === "public") return true;
  return isChannelPerson(channel, viewer) || (channelKind(channel) === "channel" && canAdministerServer(viewer.role));
}
