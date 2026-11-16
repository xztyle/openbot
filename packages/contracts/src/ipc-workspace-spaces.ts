// Spaces: the parts of one OpenBot that keep unrelated projects apart. Each agent and each channel is in
// exactly one space; a DM with one agent is in the space of that agent. An agent sees and reaches only
// the agents and channels of its own space. The host always has the space `general`, which holds every
// agent and channel that no one moved. A client that does not know a space id shows it in `general`.

import { type AvatarHue, isAvatarHue } from "./ipc-agent-identity";
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { type DynamicRecord, isDynamicRecord, isNumber } from "./runtime-values";

/** The space that every host has. It cannot be deleted, and an item with no other space is in it. */
export const GENERAL_SPACE_ID = "general";
export const SPACE_NAME_LIMIT = 60;
/** An emoji, with its modifiers and joiners. */
export const SPACE_ICON_LIMIT = 32;
/** The most spaces on one host. */
export const SPACE_LIMIT = 100;
/** The most agent or channel ids in one assignment list. */
export const SPACE_ITEM_LIMIT = 5000;

export interface WorkspaceSpace {
  id: string;
  name: string;
  /** The folder name under `OpenBot/Spaces`. It does not change when the space is renamed. */
  slug: string;
  icon: string | null;
  hue: AvatarHue | null;
  position: number;
}

export interface WorkspaceSpaceItem {
  id: string;
  spaceId: string;
}

/** The spaces of a host, in order, and the space of each agent and channel that the reader can see. */
export interface WorkspaceSpaces {
  spaces: WorkspaceSpace[];
  agents: WorkspaceSpaceItem[];
  channels: WorkspaceSpaceItem[];
}

export type WorkspaceSpaceAction =
  | { kind: "create"; name: string; icon?: string | null; hue?: AvatarHue | null }
  | { kind: "update"; spaceId: string; name?: string; icon?: string | null; hue?: AvatarHue | null }
  /** Never `general`. With `moveTo`, its agents and channels go there first; without it, only an empty space. */
  | { kind: "delete"; spaceId: string; moveTo?: string }
  /** Every space id once, in the new order. */
  | { kind: "reorder"; spaceIds: string[] }
  | { kind: "move"; spaceId: string; agentIds?: string[]; channelIds?: string[] }
  /**
   * Puts a channel that the client creates next in a space, so its first members are checked against
   * that space. The client makes the id. A channel that exists already is moved with `move`.
   */
  | { kind: "place-channel"; spaceId: string; channelId: string };

/** The spaces after the action. `createdSpaceId` names the space that a `create` added. */
export interface WorkspaceSpaceActionResult extends WorkspaceSpaces {
  createdSpaceId?: string;
}

function isSpaceName(value: unknown): value is string {
  return isBoundedString(value, SPACE_NAME_LIMIT) && value.trim().length > 0;
}

function isSpaceIcon(value: unknown): value is string | null {
  return value === null || (isBoundedString(value, SPACE_ICON_LIMIT) && value.length > 0);
}

function isSpaceHue(value: unknown): value is AvatarHue | null {
  return value === null || isAvatarHue(value);
}

function isWorkspaceSpace(value: unknown): value is WorkspaceSpace {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isSpaceName(value.name) &&
    isIdentifier(value.slug) &&
    isSpaceIcon(value.icon) &&
    isSpaceHue(value.hue) &&
    isNumber(value.position) &&
    Number.isInteger(value.position)
  );
}

function isSpaceItem(value: unknown): value is WorkspaceSpaceItem {
  return isDynamicRecord(value) && isIdentifier(value.id) && isIdentifier(value.spaceId);
}

function itemList(value: unknown): WorkspaceSpaceItem[] {
  if (!Array.isArray(value) || value.length > SPACE_ITEM_LIMIT || !value.every(isSpaceItem))
    throw new Error("Invalid space assignments.");
  return value.map(({ id, spaceId }) => ({ id, spaceId }));
}

export function decodeWorkspaceSpaces(value: unknown): WorkspaceSpaceActionResult {
  if (!isDynamicRecord(value) || !Array.isArray(value.spaces) || value.spaces.length > SPACE_LIMIT)
    throw new Error("Invalid spaces.");
  if (!value.spaces.every(isWorkspaceSpace)) throw new Error("Invalid spaces.");
  const created = value.createdSpaceId;
  if (created !== undefined && !isIdentifier(created)) throw new Error("Invalid spaces.");
  return {
    spaces: value.spaces.map(({ id, name, slug, icon, hue, position }) => ({ id, name, slug, icon, hue, position })),
    agents: itemList(value.agents),
    channels: itemList(value.channels),
    ...(created === undefined ? {} : { createdSpaceId: created }),
  };
}

function optionalIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > SPACE_ITEM_LIMIT || !value.every(isIdentifier))
    throw new Error("Invalid space action.");
  return [...new Set(value)];
}

function optionalLook(value: DynamicRecord): { icon?: string | null; hue?: AvatarHue | null } {
  if (value.icon !== undefined && !isSpaceIcon(value.icon)) throw new Error("Invalid space action.");
  if (value.hue !== undefined && !isSpaceHue(value.hue)) throw new Error("Invalid space action.");
  return {
    ...(value.icon === undefined ? {} : { icon: value.icon }),
    ...(value.hue === undefined ? {} : { hue: value.hue }),
  };
}

/** A space action from an untrusted sender. It throws on any value outside the limits. */
export function parseWorkspaceSpaceAction(value: unknown): WorkspaceSpaceAction {
  if (!isDynamicRecord(value)) throw new Error("Invalid space action.");
  switch (value.kind) {
    case "create":
      if (!isSpaceName(value.name)) throw new Error("Invalid space action.");
      return { kind: "create", name: value.name.trim(), ...optionalLook(value) };
    case "update": {
      if (!isIdentifier(value.spaceId)) throw new Error("Invalid space action.");
      if (value.name !== undefined && !isSpaceName(value.name)) throw new Error("Invalid space action.");
      return {
        kind: "update",
        spaceId: value.spaceId,
        ...(value.name === undefined ? {} : { name: value.name.trim() }),
        ...optionalLook(value),
      };
    }
    case "delete":
      if (!isIdentifier(value.spaceId)) throw new Error("Invalid space action.");
      if (value.moveTo !== undefined && !isIdentifier(value.moveTo)) throw new Error("Invalid space action.");
      return {
        kind: "delete",
        spaceId: value.spaceId,
        ...(value.moveTo === undefined ? {} : { moveTo: value.moveTo }),
      };
    case "reorder": {
      const spaceIds = optionalIds(value.spaceIds);
      if (!spaceIds || spaceIds.length > SPACE_LIMIT) throw new Error("Invalid space action.");
      return { kind: "reorder", spaceIds };
    }
    case "move": {
      if (!isIdentifier(value.spaceId)) throw new Error("Invalid space action.");
      const agentIds = optionalIds(value.agentIds);
      const channelIds = optionalIds(value.channelIds);
      return {
        kind: "move",
        spaceId: value.spaceId,
        ...(agentIds ? { agentIds } : {}),
        ...(channelIds ? { channelIds } : {}),
      };
    }
    case "place-channel":
      if (!isIdentifier(value.spaceId) || !isIdentifier(value.channelId)) throw new Error("Invalid space action.");
      return { kind: "place-channel", spaceId: value.spaceId, channelId: value.channelId };
    default:
      throw new Error("Invalid space action.");
  }
}

/** The space of each id, for a client that joins the assignment lists to its own rows. Unknown: `general`. */
export function spaceLookup(items: readonly WorkspaceSpaceItem[]): (id: string) => string {
  const map = new Map(items.map((item) => [item.id, item.spaceId]));
  return (id) => map.get(id) ?? GENERAL_SPACE_ID;
}
