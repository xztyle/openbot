import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type AvatarHue,
  type ChannelKind,
  GENERAL_SPACE_ID,
  isAvatarHue,
  type WorkspaceSpace,
} from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import {
  databaseRows,
  optionalNumberColumn,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../database/database-rows";
import { withDatabaseTransaction } from "../database-transaction";
import type { OpenBotDatabase } from "../openbot-database";

export type SpaceItemKind = "agent" | "channel";

/** The fields of a channel that decide its space: a DM with one agent follows that agent. */
export interface SpaceChannel {
  id: string;
  kind?: ChannelKind;
  members: readonly { agentId: string }[];
  humanMemberIds?: readonly string[];
}

/** The folder of all spaces, beside `Agents` and the old global `Shared`. */
export const SPACES_DIRECTORY = "Spaces";
/** The shared folder of a space, under its slug. */
export const SPACE_SHARED_DIRECTORY = "Shared";

/**
 * Owns the `spaces` and `space_assignments` rows: which spaces exist, their order and look, and the space
 * of each agent and channel. It also names each space's shared folder. It does not create folders, check
 * who asks, or tell anyone of a change; `SpaceService` does. Configuration, so it writes directly, as
 * `BrowserProfileStore` does.
 *
 * Every enforcement point reads the space of an agent here, often several times in one tool call, so the
 * assignments are cached per connection. Only this class writes them.
 */
export class SpaceStore {
  readonly #database: OpenBotDatabase;
  readonly #spacesRoot: string;
  #cache: { connection: DatabaseSync; agents: Map<string, string>; channels: Map<string, string> } | null = null;

  /** `openbotRoot` is the `OpenBot` folder that holds `Agents` and `Shared`. */
  constructor(database: OpenBotDatabase, openbotRoot: string) {
    this.#database = database;
    this.#spacesRoot = join(openbotRoot, SPACES_DIRECTORY);
  }

  list(): WorkspaceSpace[] {
    return databaseRows(
      this.#database.connection
        .prepare("SELECT space_id, name, slug, icon, hue, position FROM spaces ORDER BY position, name COLLATE NOCASE")
        .all(),
    ).map(spaceRecord);
  }

  get(id: string): WorkspaceSpace | undefined {
    return this.list().find((space) => space.id === id);
  }

  byName(name: string): WorkspaceSpace | undefined {
    const wanted = name.trim().toLocaleLowerCase();
    return this.list().find((space) => space.name.toLocaleLowerCase() === wanted);
  }

  /** Adds a space at the end, with a new id and a slug no other space has. The caller checks the name. */
  create(input: { name: string; icon?: string | null; hue?: AvatarHue | null }): WorkspaceSpace {
    const spaces = this.list();
    const id = randomBytes(16).toString("hex");
    const slug = uniqueSlug(spaceSlug(input.name), new Set(spaces.map((space) => space.slug)));
    const position = spaces.reduce((last, space) => Math.max(last, space.position), 0) + 1;
    const icon = input.icon ?? null;
    const hue = input.hue ?? null;
    this.#database.connection
      .prepare("INSERT INTO spaces (space_id, name, slug, icon, hue, position) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.name, slug, icon, hue, position);
    return { id, name: input.name, slug, icon, hue, position };
  }

  update(id: string, change: { name?: string; icon?: string | null; hue?: AvatarHue | null }): void {
    const connection = this.#database.connection;
    if (change.name !== undefined)
      connection.prepare("UPDATE spaces SET name = ? WHERE space_id = ?").run(change.name, id);
    if (change.icon !== undefined)
      connection.prepare("UPDATE spaces SET icon = ? WHERE space_id = ?").run(change.icon, id);
    if (change.hue !== undefined)
      connection.prepare("UPDATE spaces SET hue = ? WHERE space_id = ?").run(change.hue, id);
  }

  /** Sets the order. `ids` holds every space once; the caller checks that. */
  reorder(ids: readonly string[]): void {
    const statement = this.#database.connection.prepare("UPDATE spaces SET position = ? WHERE space_id = ?");
    this.#write(() => {
      for (const [index, id] of ids.entries()) statement.run(index, id);
    });
  }

  /** Deletes an empty space. The caller checks that it is empty and is not `general`. */
  delete(id: string): void {
    this.#database.connection.prepare("DELETE FROM spaces WHERE space_id = ?").run(id);
  }

  /** How many agents and channels have a row in the space. A DM follows its agent and has none. */
  itemCount(id: string): number {
    const [row] = databaseRows(
      this.#database.connection.prepare("SELECT COUNT(*) AS count FROM space_assignments WHERE space_id = ?").all(id),
    );
    return row ? requiredNumberColumn(row, "count") : 0;
  }

  /** The rows of a space. */
  rows(spaceId: string): { kind: SpaceItemKind; itemId: string }[] {
    return databaseRows(
      this.#database.connection.prepare("SELECT kind, item_id FROM space_assignments WHERE space_id = ?").all(spaceId),
    ).map((row) => ({
      kind: requiredStringColumn(row, "kind") === "agent" ? "agent" : "channel",
      itemId: requiredStringColumn(row, "item_id"),
    }));
  }

  /** Puts the items in a space. `general` removes the row: an item with none is in `general`. */
  assign(kind: SpaceItemKind, itemIds: readonly string[], spaceId: string): void {
    const connection = this.#database.connection;
    const remove = connection.prepare("DELETE FROM space_assignments WHERE kind = ? AND item_id = ?");
    const upsert = connection.prepare(
      `INSERT INTO space_assignments (kind, item_id, space_id) VALUES (?, ?, ?)
       ON CONFLICT(kind, item_id) DO UPDATE SET space_id = excluded.space_id`,
    );
    this.#write(() => {
      for (const id of itemIds) {
        if (spaceId === GENERAL_SPACE_ID) remove.run(kind, id);
        else upsert.run(kind, id, spaceId);
      }
    });
  }

  /** Removes the row of a deleted agent or channel. */
  forget(kind: SpaceItemKind, itemId: string): void {
    this.assign(kind, [itemId], GENERAL_SPACE_ID);
  }

  agentSpaceId(agentId: string): string {
    return this.#assignments().agents.get(agentId) ?? GENERAL_SPACE_ID;
  }

  /** The space of a channel. A DM or a group with one agent and no other person follows that agent. */
  channelSpaceId(channel: SpaceChannel): string {
    const followed = followedAgentId(channel);
    if (followed !== null) return this.agentSpaceId(followed);
    return this.#assignments().channels.get(channel.id) ?? GENERAL_SPACE_ID;
  }

  sameSpace(agentId: string, otherAgentId: string): boolean {
    return this.agentSpaceId(agentId) === this.agentSpaceId(otherAgentId);
  }

  /** The folder that the agents of the space share: `OpenBot/Spaces/<slug>/Shared`. */
  sharedDirectory(space: Pick<WorkspaceSpace, "slug">): string {
    return join(this.#spacesRoot, space.slug, SPACE_SHARED_DIRECTORY);
  }

  /** The shared folder of the agent's space. An agent whose space row is gone uses `general`'s. */
  agentSharedDirectory(agentId: string): string {
    const space = this.get(this.agentSpaceId(agentId)) ?? this.get(GENERAL_SPACE_ID);
    return this.sharedDirectory(space ?? { slug: GENERAL_SPACE_ID });
  }

  #assignments(): { agents: Map<string, string>; channels: Map<string, string> } {
    const connection = this.#database.connection;
    if (this.#cache?.connection === connection) return this.#cache;
    const agents = new Map<string, string>();
    const channels = new Map<string, string>();
    for (const row of databaseRows(connection.prepare("SELECT kind, item_id, space_id FROM space_assignments").all())) {
      const target = requiredStringColumn(row, "kind") === "agent" ? agents : channels;
      target.set(requiredStringColumn(row, "item_id"), requiredStringColumn(row, "space_id"));
    }
    this.#cache = { connection, agents, channels };
    return this.#cache;
  }

  /** One write, in a transaction unless the caller has one. The cache is read again after it either way. */
  #write(write: () => void): void {
    const clear = () => {
      this.#cache = null;
    };
    withDatabaseTransaction(this.#database, write, clear, clear);
    clear();
  }
}

/** The one agent a DM or a group follows, or null for a named channel or a conversation with other people. */
export function followedAgentId(channel: SpaceChannel): string | null {
  if ((channel.kind ?? "channel") === "channel") return null;
  if (channel.members.length !== 1) return null;
  return channel.members[0]?.agentId ?? null;
}

/** A folder name from a space name: lower case ASCII letters, digits and dashes. */
export function spaceSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");
  return slug === "" ? "space" : slug;
}

function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function spaceRecord(row: DynamicRecord): WorkspaceSpace {
  const hue = optionalNumberColumn(row, "hue");
  return {
    id: requiredStringColumn(row, "space_id"),
    name: requiredStringColumn(row, "name"),
    slug: requiredStringColumn(row, "slug"),
    icon: optionalStringColumn(row, "icon"),
    // The column CHECK keeps the hue in the list.
    hue: hue !== null && isAvatarHue(hue) ? hue : null,
    position: requiredNumberColumn(row, "position"),
  };
}
