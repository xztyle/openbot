// The spaces routes of the local control socket. Only the service user reaches the socket, so these
// routes take no account: they are for the operator who moves the agents and channels of an existing
// install into spaces after an upgrade.
//
// - `GET /v1/spaces` answers JSON: each space with its shared folder, its agents and its channels (by
//   id and name), the old global shared folder, and the folders that OpenBot itself keeps in a shared
//   folder, so a migration script knows what to move.
// - `POST /v1/spaces/apply` takes JSON `{ spaces: [{ name, icon?, hue?, agentIds?, channelIds? }] }`.
//   Each space is found by name (case does not matter) or made, then gets the listed agents and
//   channels. Running it again changes nothing. It answers the report and the spaces again.
import {
  AVATAR_HUES,
  type AvatarHue,
  GENERAL_SPACE_ID,
  isAvatarHue,
  SPACE_ICON_LIMIT,
  SPACE_ITEM_LIMIT,
  SPACE_LIMIT,
  SPACE_NAME_LIMIT,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { SpaceApplyEntry, SpaceApplyReport, SpaceService } from "../backend/spaces/space-service";
import { spaceRejection } from "../backend/spaces/space-service";

/** The largest JSON body of a spaces request: several thousand ids. */
export const MAX_SPACES_BODY_BYTES = 1024 * 1024;

/**
 * The folders that OpenBot keeps in a shared folder. Each now lives in the shared folder of the space
 * of the agent it serves; a script that moves an old folder into a space moves these with it.
 */
const MANAGED_FOLDERS = [
  { folder: "Data", use: "the shared database (agent-data.db) of the agents' data tools" },
  { folder: "Transfers", use: "files sent to agents and files that agents made" },
  { folder: "Watchers", use: "the programs of event checks" },
  { folder: "apps", use: "apps that agents deploy with appctl" },
  { folder: "meta-ads", use: "the Meta Ads helper's settings and audit log" },
  { folder: "hotmart", use: "the Hotmart helper's settings and audit log" },
] as const;

export interface ControlSpacesOptions {
  spaces: Pick<SpaceService, "snapshot" | "directories" | "applyBulk">;
  agents: () => readonly { id: string; name: string }[];
  channels: () => readonly { id: string; name: string; kind?: string }[];
  /** The old global shared folder, `OpenBot/Shared`. */
  legacySharedRoot: string;
}

export interface ControlAnswer {
  status: number;
  body: string;
}

export function listControlSpaces(options: ControlSpacesOptions): ControlAnswer {
  return { status: 200, body: `${JSON.stringify(describe(options), null, 2)}\n` };
}

export function applyControlSpaces(options: ControlSpacesOptions, text: string): Effect.Effect<ControlAnswer> {
  let entries: SpaceApplyEntry[];
  try {
    entries = parseEntries(JSON.parse(text));
  } catch (error) {
    return Effect.succeed(json(400, { error: "invalid_request", message: errorText(error) }));
  }
  return options.spaces.applyBulk(entries).pipe(
    Effect.map((report) => json(200, { report, ...describe(options) })),
    Effect.catch((failure) =>
      Effect.succeed(json(400, { error: "rejected", message: spaceRejection(failure) ?? errorText(failure.cause) })),
    ),
  );
}

function describe(options: ControlSpacesOptions) {
  const snapshot = options.spaces.snapshot();
  const agents = new Map(options.agents().map((agent) => [agent.id, agent.name]));
  const channels = new Map(options.channels().map((channel) => [channel.id, channel]));
  const directories = new Map(options.spaces.directories().map((space) => [space.spaceId, space.sharedDirectory]));
  return {
    legacySharedRoot: options.legacySharedRoot,
    managedFolders: MANAGED_FOLDERS,
    spaces: snapshot.spaces.map((space) => ({
      ...space,
      general: space.id === GENERAL_SPACE_ID,
      sharedDirectory: directories.get(space.id) ?? null,
      agents: snapshot.agents
        .filter((item) => item.spaceId === space.id)
        .map((item) => ({ id: item.id, name: agents.get(item.id) ?? item.id })),
      channels: snapshot.channels
        .filter((item) => item.spaceId === space.id)
        .map((item) => {
          const channel = channels.get(item.id);
          return { id: item.id, name: channel?.name ?? item.id, kind: channel?.kind ?? "channel" };
        }),
    })),
  };
}

function parseEntries(value: unknown): SpaceApplyEntry[] {
  if (!isDynamicRecord(value) || !Array.isArray(value.spaces) || value.spaces.length > SPACE_LIMIT)
    throw new Error(`Send { "spaces": [...] } with at most ${SPACE_LIMIT} spaces.`);
  return value.spaces.map((entry, index) => {
    if (!isDynamicRecord(entry)) throw new Error(`spaces[${index}] is not an object.`);
    const name = isString(entry.name) ? entry.name.trim() : "";
    if (name.length === 0 || name.length > SPACE_NAME_LIMIT)
      throw new Error(`spaces[${index}].name must have 1 to ${SPACE_NAME_LIMIT} characters.`);
    return {
      name,
      ...(entry.icon === undefined ? {} : { icon: icon(entry.icon, index) }),
      ...(entry.hue === undefined ? {} : { hue: hue(entry.hue, index) }),
      agentIds: ids(entry.agentIds, `spaces[${index}].agentIds`),
      channelIds: ids(entry.channelIds, `spaces[${index}].channelIds`),
    };
  });
}

function icon(value: unknown, index: number): string | null {
  if (value === null) return null;
  if (isString(value) && value.length > 0 && value.length <= SPACE_ICON_LIMIT) return value;
  throw new Error(`spaces[${index}].icon must be an emoji or null.`);
}

function hue(value: unknown, index: number): AvatarHue | null {
  if (value === null || isAvatarHue(value)) return value;
  throw new Error(`spaces[${index}].hue must be null or one of ${AVATAR_HUES.join(", ")}.`);
}

function ids(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SPACE_ITEM_LIMIT || !value.every(isString))
    throw new Error(`${label} must be a list of ids.`);
  return [...new Set(value)];
}

type ControlBody = { error: string; message: string } | ({ report: SpaceApplyReport } & ReturnType<typeof describe>);

function json(status: number, value: ControlBody): ControlAnswer {
  return { status, body: `${JSON.stringify(value, null, 2)}\n` };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
