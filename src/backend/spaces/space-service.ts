import { mkdir } from "node:fs/promises";
import {
  type AvatarHue,
  GENERAL_SPACE_ID,
  SPACE_LIMIT,
  type WorkspaceSpace,
  type WorkspaceSpaceAction,
  type WorkspaceSpaceActionResult,
  type WorkspaceSpaces,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Schema, Semaphore } from "effect";
import { writeJsonFileAtomically } from "../atomic-json-file";
import { followedAgentId, type SpaceChannel, type SpaceStore } from "./space-store";

export interface SpaceServiceOptions {
  store: SpaceStore;
  /** Every agent, hidden ones too. */
  agentIds: () => readonly string[];
  /** Every channel, archived ones too. */
  channels: () => readonly SpaceChannel[];
  /** After each change that a reader can see. */
  onChanged: () => void;
}

/** What the reader may see. Absent: everything (the owner on this computer, the control socket). */
export interface SpaceViewer {
  agent: (agentId: string) => boolean;
  channel: (channelId: string) => boolean;
}

/** One space of a bulk apply: found by name, made when missing, and given these agents and channels. */
export interface SpaceApplyEntry {
  name: string;
  icon?: string | null;
  hue?: AvatarHue | null;
  agentIds?: readonly string[];
  channelIds?: readonly string[];
}

export interface SpaceApplyReport {
  spaces: { id: string; name: string; slug: string; created: boolean; sharedDirectory: string }[];
  movedAgents: number;
  movedChannels: number;
  /** Ids that name no agent or channel, and DMs, which follow their agent. Nothing else was skipped. */
  skipped: { id: string; reason: "unknown-agent" | "unknown-channel" | "dm-follows-agent" }[];
}

export interface SpaceDirectory {
  spaceId: string;
  name: string;
  slug: string;
  sharedDirectory: string;
}

/** A change that the person who manages spaces can correct: its message is catalog text for them. */
export class SpaceRejectedError extends Error {}

export class SpaceFailure extends Schema.TaggedError<SpaceFailure>()("SpaceFailure", {
  cause: Schema.Defect(),
}) {}

/**
 * Owns the changes to spaces: the checks of each change, the folder of each new space, and the
 * notice to readers. It never asks who the caller is; the Team API route and the control socket do.
 * One change runs at a time, so a delete cannot race a move into the space it deletes.
 */
export class SpaceService {
  readonly #options: SpaceServiceOptions;
  readonly #changes = Semaphore.makeUnsafe(1);

  constructor(options: SpaceServiceOptions) {
    this.#options = options;
  }

  get store(): SpaceStore {
    return this.#options.store;
  }

  /** The spaces, and the space of each agent and channel the viewer sees. A DM follows its agent. */
  snapshot(viewer?: SpaceViewer): WorkspaceSpaces {
    const store = this.#options.store;
    const agents = this.#options.agentIds().filter((id) => viewer?.agent(id) ?? true);
    const channels = this.#options.channels().filter((channel) => viewer?.channel(channel.id) ?? true);
    return {
      spaces: store.list(),
      agents: agents.map((id) => ({ id, spaceId: store.agentSpaceId(id) })),
      channels: channels.map((channel) => ({ id: channel.id, spaceId: store.channelSpaceId(channel) })),
    };
  }

  directories(): SpaceDirectory[] {
    const store = this.#options.store;
    return store.list().map((space) => ({
      spaceId: space.id,
      name: space.name,
      slug: space.slug,
      sharedDirectory: store.sharedDirectory(space),
    }));
  }

  apply(action: WorkspaceSpaceAction, viewer?: SpaceViewer): Effect.Effect<WorkspaceSpaceActionResult, SpaceFailure> {
    return this.#serialized(
      Effect.gen({ self: this }, function* () {
        const created = yield* this.#check(() => this.#applySync(action));
        if (created) yield* this.#ensureFolder(created);
        this.#options.onChanged();
        return { ...this.snapshot(viewer), ...(created ? { createdSpaceId: created.id } : {}) };
      }),
    );
  }

  /**
   * Finds each space by name, or makes it, and moves the listed agents and channels into it. Running it
   * again with the same input changes nothing. An id that names nothing, and a DM, is reported, not fatal.
   */
  applyBulk(entries: readonly SpaceApplyEntry[]): Effect.Effect<SpaceApplyReport, SpaceFailure> {
    return this.#serialized(
      Effect.gen({ self: this }, function* () {
        const store = this.#options.store;
        const agentIds = new Set(this.#options.agentIds());
        const channels = new Map(this.#options.channels().map((channel) => [channel.id, channel]));
        const report: SpaceApplyReport = { spaces: [], movedAgents: 0, movedChannels: 0, skipped: [] };
        for (const entry of entries) {
          const { space, created } = yield* this.#check(() => {
            const found = store.byName(entry.name);
            if (found) {
              const change = {
                ...(entry.icon === undefined ? {} : { icon: entry.icon }),
                ...(entry.hue === undefined ? {} : { hue: entry.hue }),
              };
              if (Object.keys(change).length > 0) store.update(found.id, change);
              return { space: found, created: false };
            }
            this.#requireRoom();
            return {
              space: store.create({ name: entry.name, icon: entry.icon ?? null, hue: entry.hue ?? null }),
              created: true,
            };
          });
          yield* this.#ensureFolder(space);
          const agents = (entry.agentIds ?? []).filter((id) => {
            if (agentIds.has(id)) return true;
            report.skipped.push({ id, reason: "unknown-agent" });
            return false;
          });
          const channelIds = (entry.channelIds ?? []).filter((id) => {
            const channel = channels.get(id);
            if (!channel) report.skipped.push({ id, reason: "unknown-channel" });
            else if (followedAgentId(channel) !== null) report.skipped.push({ id, reason: "dm-follows-agent" });
            else return true;
            return false;
          });
          yield* this.#check(() => {
            report.movedAgents += agents.filter((id) => store.agentSpaceId(id) !== space.id).length;
            report.movedChannels += channelIds.filter((id) => {
              const channel = channels.get(id);
              return channel !== undefined && store.channelSpaceId(channel) !== space.id;
            }).length;
            store.assign("agent", agents, space.id);
            store.assign("channel", channelIds, space.id);
          });
          report.spaces.push({
            id: space.id,
            name: space.name,
            slug: space.slug,
            created,
            sharedDirectory: store.sharedDirectory(space),
          });
        }
        this.#options.onChanged();
        return report;
      }),
    );
  }

  /** Writes `OpenBot/Spaces/index.json` again; see `SpaceStore.indexPath`. */
  writeIndex(): Effect.Effect<void, SpaceFailure> {
    const store = this.#options.store;
    return Effect.suspend(() => {
      const spaces = this.directories();
      const shared = new Map(spaces.map((space) => [space.spaceId, space.sharedDirectory]));
      const agents: Record<string, string> = {};
      for (const agentId of this.#options.agentIds()) {
        const spaceId = store.agentSpaceId(agentId);
        agents[agentId] = shared.get(spaceId) ?? shared.get(GENERAL_SPACE_ID) ?? "";
      }
      return writeJsonFileAtomically(
        store.indexPath,
        { version: 1, spaces, general: shared.get(GENERAL_SPACE_ID) ?? "", agents },
        { createDirectory: true },
      );
    }).pipe(Effect.mapError((cause) => new SpaceFailure({ cause })));
  }

  /** Puts a new agent or channel in a space. Unknown spaces put it in `general`. */
  place(kind: "agent" | "channel", itemId: string, spaceId: string): void {
    const store = this.#options.store;
    store.assign(kind, [itemId], store.get(spaceId) ? spaceId : GENERAL_SPACE_ID);
    this.#options.onChanged();
  }

  /** Removes the row of a deleted agent or channel, so a later item with the same id starts in `general`. */
  forget(kind: "agent" | "channel", itemId: string): void {
    this.#options.store.forget(kind, itemId);
  }

  /** The new space of a `create`, which needs its folder; null for any other action. */
  #applySync(action: WorkspaceSpaceAction): WorkspaceSpace | null {
    const store = this.#options.store;
    switch (action.kind) {
      case "create":
        this.#requireRoom();
        this.#requireFreeName(action.name);
        return store.create({ name: action.name, icon: action.icon ?? null, hue: action.hue ?? null });
      case "update":
        this.#requireSpace(action.spaceId);
        if (action.name !== undefined) this.#requireFreeName(action.name, action.spaceId);
        store.update(action.spaceId, action);
        return null;
      case "reorder": {
        const ids = store.list().map((space) => space.id);
        if (action.spaceIds.length !== ids.length || !ids.every((id) => action.spaceIds.includes(id)))
          throw new SpaceRejectedError(sourceText("error.backend.spaceOrderInvalid"));
        store.reorder(action.spaceIds);
        return null;
      }
      case "move":
        this.#requireSpace(action.spaceId);
        this.#move(action.spaceId, action.agentIds ?? [], action.channelIds ?? []);
        return null;
      case "delete":
        this.#delete(action.spaceId, action.moveTo);
        return null;
    }
  }

  #move(spaceId: string, agentIds: readonly string[], channelIds: readonly string[]): void {
    const store = this.#options.store;
    const known = new Set(this.#options.agentIds());
    const channels = new Map(this.#options.channels().map((channel) => [channel.id, channel]));
    for (const id of agentIds)
      if (!known.has(id)) throw new SpaceRejectedError(sourceText("error.backend.spaceUnknownItem", { id }));
    for (const id of channelIds) {
      const channel = channels.get(id);
      if (!channel) throw new SpaceRejectedError(sourceText("error.backend.spaceUnknownItem", { id }));
      if (followedAgentId(channel) !== null)
        throw new SpaceRejectedError(sourceText("error.backend.spaceDmFollowsAgent"));
    }
    store.assign("agent", agentIds, spaceId);
    store.assign("channel", channelIds, spaceId);
  }

  #delete(spaceId: string, moveTo: string | undefined): void {
    const store = this.#options.store;
    if (spaceId === GENERAL_SPACE_ID) throw new SpaceRejectedError(sourceText("error.backend.spaceGeneralKept"));
    this.#requireSpace(spaceId);
    if (moveTo !== undefined) {
      if (moveTo === spaceId) throw new SpaceRejectedError(sourceText("error.backend.spaceNotEmpty"));
      this.#requireSpace(moveTo);
      const snapshot = this.snapshot();
      const agents = snapshot.agents.filter((item) => item.spaceId === spaceId).map((item) => item.id);
      const channels = this.#options
        .channels()
        .filter((channel) => followedAgentId(channel) === null && store.channelSpaceId(channel) === spaceId)
        .map((channel) => channel.id);
      store.assign("agent", agents, moveTo);
      store.assign("channel", channels, moveTo);
    }
    // Rows of deleted agents or channels that a delete left behind would keep the space; they name nothing.
    this.#dropOrphans(spaceId);
    if (store.itemCount(spaceId) > 0) throw new SpaceRejectedError(sourceText("error.backend.spaceNotEmpty"));
    store.delete(spaceId);
  }

  #dropOrphans(spaceId: string): void {
    const store = this.#options.store;
    const agents = new Set(this.#options.agentIds());
    const channels = new Set(this.#options.channels().map((channel) => channel.id));
    for (const { kind, itemId } of store.rows(spaceId))
      if (!(kind === "agent" ? agents : channels).has(itemId)) store.forget(kind, itemId);
  }

  #requireSpace(spaceId: string): WorkspaceSpace {
    const space = this.#options.store.get(spaceId);
    if (!space) throw new SpaceRejectedError(sourceText("error.backend.spaceNotFound"));
    return space;
  }

  #requireRoom(): void {
    if (this.#options.store.list().length >= SPACE_LIMIT)
      throw new SpaceRejectedError(sourceText("error.backend.spaceLimit", { limit: SPACE_LIMIT }));
  }

  #requireFreeName(name: string, spaceId?: string): void {
    const taken = this.#options.store.byName(name);
    if (taken && taken.id !== spaceId) throw new SpaceRejectedError(sourceText("error.backend.spaceNameTaken"));
  }

  #ensureFolder(space: Pick<WorkspaceSpace, "slug">): Effect.Effect<void, SpaceFailure> {
    const directory = this.#options.store.sharedDirectory(space);
    return Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
      catch: (cause) => new SpaceFailure({ cause }),
    }).pipe(Effect.asVoid);
  }

  #check<T>(run: () => T): Effect.Effect<T, SpaceFailure> {
    return Effect.try({ try: run, catch: (cause) => new SpaceFailure({ cause }) });
  }

  #serialized<A>(change: Effect.Effect<A, SpaceFailure>): Effect.Effect<A, SpaceFailure> {
    return this.#changes.withPermits(1)(change).pipe(Effect.uninterruptible);
  }
}

/** The catalog text of a rejected change, or null when the failure is not one the person can correct. */
export function spaceRejection(error: unknown): string | null {
  const cause = error instanceof SpaceFailure ? error.cause : error;
  return cause instanceof SpaceRejectedError ? cause.message : null;
}
