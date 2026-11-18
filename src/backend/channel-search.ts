import type { Channel, WorkspaceSearchHit, WorkspaceSearchInput, WorkspaceSearchPage } from "@openbot/contracts/ipc";
import { workspaceSearchLimit } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { type ChannelOperationError, channelSync } from "./channel-effects";
import type { ChannelStore } from "./channel-store";
import { type ChannelViewer, canSeeChannel } from "./channel-visibility";
import {
  ChannelSearchQueries,
  type ChannelSearchRequest,
  type ChannelSearchRow,
  channelSearchPlan,
} from "./database/channel-search-queries";

export interface ChannelSearchOptions {
  store: ChannelStore;
  /** The space of a channel. Omitted, the host has no spaces: a search with `spaceId` finds nothing. */
  channelSpaceId?: (channel: Channel) => string;
}

/**
 * Owns the workspace message search: which channels a reader may search (the ones they can see, in
 * the space and the channels they name), and the page of hits. The full-text read runs on a database
 * read worker when one runs, else on the main connection; both give the same answer. It never
 * imports the database facade.
 */
export class ChannelSearch {
  readonly #store: ChannelStore;
  readonly #channelSpaceId: ((channel: Channel) => string) | undefined;
  readonly #queries: ChannelSearchQueries;

  constructor(options: ChannelSearchOptions) {
    this.#store = options.store;
    this.#channelSpaceId = options.channelSpaceId;
    this.#queries = new ChannelSearchQueries({ core: options.store.database });
  }

  /**
   * One page of the messages that match, in the channels, groups and DMs the reader can see, archived
   * ones too. `excludedAgentIds` are agents that the reader's peer cannot see: their messages stay out.
   */
  search(
    input: WorkspaceSearchInput,
    viewer: ChannelViewer,
    excludedAgentIds: ReadonlySet<string> = new Set(),
  ): Effect.Effect<WorkspaceSearchPage, ChannelOperationError> {
    return Effect.gen({ self: this }, function* () {
      const plan = channelSearchPlan(input.query);
      // A search with no words lists the messages of the authors it names, newest first, as Slack's
      // Sent list does. Without words or authors there is nothing to find.
      const listing = !plan && !input.query.trim() && Boolean(input.authorIds?.length);
      if (!plan && !listing) return { hits: [], total: 0, nextCursor: null };
      const spaces = new Map<string, string>();
      const named = input.channelIds ? new Set(input.channelIds) : null;
      const channels = yield* channelSync(() =>
        this.#store.ids().flatMap((id) => {
          if (named && !named.has(id)) return [];
          const channel = this.#store.get(id);
          if (!canSeeChannel(channel, viewer)) return [];
          const spaceId = this.#channelSpaceId?.(channel);
          if (input.spaceId !== undefined && spaceId !== input.spaceId) return [];
          if (spaceId !== undefined) spaces.set(id, spaceId);
          return [id];
        }),
      );
      if (!channels.length) return { hits: [], total: 0, nextCursor: null };
      const offset = input.cursor ? Number(input.cursor) : 0;
      const request: ChannelSearchRequest = {
        plan,
        channelIds: channels,
        ...(input.authorIds?.length ? { authorIds: input.authorIds } : {}),
        ...(excludedAgentIds.size ? { excludedAgentIds: [...excludedAgentIds] } : {}),
        ...(input.after ? { after: input.after } : {}),
        ...(input.before ? { before: input.before } : {}),
        ...(input.threadsOnly ? { threadsOnly: true } : {}),
        sort: input.sort ?? "relevance",
        offset,
        limit: workspaceSearchLimit(input),
      };
      const offMain = yield* this.#store.database.readOffMain((reader) =>
        reader.searchChannelMessages({ kind: "search-channel-messages", request }),
      );
      const result = offMain ?? (yield* channelSync(() => this.#queries.search(request)));
      const next = offset + result.rows.length;
      return {
        hits: result.rows.map((row) => searchHit(row, spaces.get(row.message.channelId))),
        total: result.total,
        nextCursor: result.rows.length > 0 && next < result.total ? String(next) : null,
      };
    });
  }
}

function searchHit(
  { message, snippet, highlights }: ChannelSearchRow,
  spaceId: string | undefined,
): WorkspaceSearchHit {
  const external = message.externalAuthor;
  return {
    channelId: message.channelId,
    messageId: message.id,
    sequence: message.sequence,
    ...(message.threadRootId === undefined ? {} : { threadRootId: message.threadRootId }),
    author: external
      ? { kind: "external", id: external.id, name: external.name }
      : { kind: message.author.kind, id: message.author.id, name: message.author.name.slice(0, 120) },
    at: message.message.createdAt,
    snippet,
    highlights,
    ...(spaceId === undefined ? {} : { spaceId }),
  };
}
