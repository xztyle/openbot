import {
  CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX,
  type Channel,
  type ChannelMessage,
  channelKind,
  channelMembersAnswer,
  WORKSPACE_FOLLOWED_THREADS_LIMIT,
  type WorkspaceThreadState,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { type ChannelStore, restatedResultSql } from "./channel-store";
import { ACTIVITY_ITEM_TYPES, CHOICE_SQL, READ_FORWARD_SQL } from "./channel-thread-projection";
import type { ChannelViewer } from "./channel-visibility";
import {
  databaseRow,
  databaseRows,
  optionalStringColumn,
  placeholders,
  requiredNumberColumn,
  requiredStringColumn,
} from "./database/database-rows";

/** A thread of one channel. */
export interface ChannelThreadKey {
  channelId: string;
  rootId: string;
}

/**
 * Owns the thread read positions and follows of each person: the reads that the thread panel, the
 * Threads view and the Activity view make, and the writes of a person who reads, follows or stops
 * following a thread. It holds the store and reads `.connection` at each use; it never imports the
 * database facade. It does not check who may see a channel: `ChannelService` does, before it calls.
 */
export class ChannelReadState {
  constructor(readonly store: ChannelStore) {}

  /** The root of a thread in a channel, or an error a person can read. */
  requireRoot(channelId: string, rootId: string): ChannelMessage {
    const root = this.store.message(channelId, rootId);
    if (!root || root.threadRootId !== undefined) throw new Error(sourceText("error.backend.channelThreadNotFound"));
    return root;
  }

  /** The read state of the reader in these threads of one channel. A root that is not one is left out. */
  states(channel: Channel, viewer: ChannelViewer, rootIds?: readonly string[]): WorkspaceThreadState[] {
    const roots = rootIds ?? this.#followedRoots(channel, viewer);
    if (!roots.length) return [];
    const existing = new Set(
      databaseRows(
        this.store.database.connection
          .prepare(
            `SELECT message_id FROM projection_channel_messages
              WHERE channel_id = ? AND message_id IN (${placeholders(roots)})
                AND json_extract(message_json, '$.threadRootId') IS NULL`,
          )
          .all(channel.id, ...roots),
      ).map((row) => requiredStringColumn(row, "message_id")),
    );
    const positions = this.positions(viewer, channel.id);
    const follows = this.#follows(viewer, channel.id);
    return roots
      .filter((rootId) => existing.has(rootId))
      .map((rootId) => {
        const throughSequence = positions.get(rootId) ?? 0;
        return {
          channelId: channel.id,
          rootId,
          followed: this.#isFollowed(channel, follows.get(rootId)),
          throughSequence,
          unreadCount: this.unreadReplies(channel, rootId, throughSequence, viewer),
        };
      });
  }

  /** The state of one thread, for the answer to a read or a follow. */
  state(channel: Channel, rootId: string, viewer: ChannelViewer): WorkspaceThreadState {
    const [state] = this.states(channel, viewer, [rootId]);
    if (!state) throw new Error(sourceText("error.backend.channelThreadNotFound"));
    return state;
  }

  /** The person read the thread through `throughSequence`. The position only moves forward. */
  markRead(channelId: string, rootId: string, memberId: string, throughSequence: number, operationId: string): void {
    this.requireRoot(channelId, rootId);
    const maximum = this.store.page(channelId).throughSequence;
    if (throughSequence > maximum) throw new Error("The read position exceeds the channel history.");
    this.store.database.dispatch(
      `channel-thread-read:${memberId}:${operationId}`,
      [
        {
          aggregateType: "channel",
          aggregateId: channelId,
          eventType: "channel.thread-read",
          payload: { memberId, rootId, throughSequence },
        },
      ],
      (db) => {
        db.prepare(READ_FORWARD_SQL).run(channelId, rootId, memberId, throughSequence);
        return null;
      },
    );
  }

  /** The person follows the thread, or stops following it. An automatic follow does not change the choice. */
  setFollowed(channelId: string, rootId: string, memberId: string, followed: boolean, operationId: string): void {
    this.requireRoot(channelId, rootId);
    this.store.database.dispatch(
      `channel-thread-follow:${memberId}:${operationId}`,
      [
        {
          aggregateType: "channel",
          aggregateId: channelId,
          eventType: "channel.thread-follow",
          payload: { memberId, rootId, followed },
        },
      ],
      (db) => {
        db.prepare(CHOICE_SQL).run(channelId, rootId, memberId, followed ? 1 : 0);
        return null;
      },
    );
  }

  /**
   * The read position of the reader in each thread, under any id that names them: of one channel, or
   * of every channel keyed `<channelId>\n<rootId>`.
   */
  positions(viewer: ChannelViewer, channelId: string): Map<string, number>;
  positions(viewer: ChannelViewer): Map<string, number>;
  positions(viewer: ChannelViewer, channelId?: string): Map<string, number> {
    const ids = [...viewer.ids];
    const rows = databaseRows(
      this.store.database.connection
        .prepare(
          `SELECT channel_id, root_id, MAX(through_sequence) AS through FROM projection_channel_thread_reads
            WHERE member_id IN (${placeholders(ids)}) ${channelId === undefined ? "" : "AND channel_id = ?"}
            GROUP BY channel_id, root_id`,
        )
        .all(...ids, ...(channelId === undefined ? [] : [channelId])),
    );
    return new Map(
      rows.map((row) => [
        channelId === undefined
          ? threadKey(requiredStringColumn(row, "channel_id"), requiredStringColumn(row, "root_id"))
          : requiredStringColumn(row, "root_id"),
        requiredNumberColumn(row, "through"),
      ]),
    );
  }

  /**
   * The threads that the reader follows over the given channels, newest reply first, at most `limit`:
   * the followed rows of the reader, and each thread of a DM or a group that they did not stop
   * following. Each has at least one reply.
   */
  followedThreads(channels: readonly Channel[], viewer: ChannelViewer, limit: number): ChannelThreadKey[] {
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const follows = this.#follows(viewer);
    const candidates = new Set<string>();
    for (const [key, choice] of follows) {
      const channel = byId.get(key.slice(0, key.indexOf("\n")));
      if (channel && this.#isFollowed(channel, choice)) candidates.add(key);
    }
    for (const channel of channels) {
      if (channelKind(channel) === "channel") continue;
      for (const rootId of this.#threadRoots(channel.id)) {
        const key = threadKey(channel.id, rootId);
        if (!follows.has(key)) candidates.add(key);
      }
    }
    if (!candidates.size) return [];
    // The last reply time of each candidate root, through the primary key.
    const keys = [...candidates].map((key) => {
      const split = key.indexOf("\n");
      return { channelId: key.slice(0, split), rootId: key.slice(split + 1) };
    });
    const latest = new Map<string, string>();
    const read = this.store.database.connection.prepare(
      `SELECT json_extract(message_json, '$.threadSummary.lastReplyAt') AS last FROM projection_channel_messages
        WHERE channel_id = ? AND message_id = ? AND COALESCE(json_extract(message_json, '$.threadSummary.replyCount'), 0) > 0`,
    );
    for (const key of keys) {
      const row = databaseRow(read.get(key.channelId, key.rootId));
      if (row) latest.set(threadKey(key.channelId, key.rootId), optionalStringColumn(row, "last") ?? "");
    }
    return keys
      .filter((key) => latest.has(threadKey(key.channelId, key.rootId)))
      .sort((left, right) =>
        (latest.get(threadKey(right.channelId, right.rootId)) ?? "").localeCompare(
          latest.get(threadKey(left.channelId, left.rootId)) ?? "",
        ),
      )
      .slice(0, limit);
  }

  /** Whether the reader follows a thread of one of the given channels. */
  followedSet(channels: readonly Channel[], viewer: ChannelViewer): (channelId: string, rootId: string) => boolean {
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const follows = this.#follows(viewer);
    return (channelId, rootId) => {
      const channel = byId.get(channelId);
      return channel !== undefined && this.#isFollowed(channel, follows.get(threadKey(channelId, rootId)));
    };
  }

  /** The replies of a thread after `through` that the reader did not write, through the thread index. */
  unreadReplies(channel: Channel, rootId: string, through: number, viewer: ChannelViewer): number {
    const ids = [...viewer.ids];
    // A result note that restates an answer is not a reply.
    const restated = channelMembersAnswer(channel) ? `AND NOT ${restatedResultSql("reply")}` : "";
    const row = databaseRow(
      this.store.database.connection
        .prepare(
          `SELECT COUNT(*) AS unread FROM projection_channel_messages reply
            WHERE reply.channel_id = ? AND json_extract(reply.message_json, '$.threadRootId') = ? AND reply.sequence > ?
              AND json_extract(reply.message_json, '$.deletedAt') IS NULL
              AND COALESCE(json_extract(reply.message_json, '$.message.status'), '') != 'streaming'
              AND COALESCE(json_extract(reply.message_json, '$.message.itemType'), '') NOT IN (${placeholders(ACTIVITY_ITEM_TYPES)})
              AND COALESCE(json_extract(reply.message_json, '$.message.itemType'), '') NOT LIKE ?
              ${restated}
              AND NOT (json_extract(reply.message_json, '$.author.kind') = 'member'
                AND json_extract(reply.message_json, '$.externalAuthor') IS NULL
                AND json_extract(reply.message_json, '$.author.id') IN (${placeholders(ids)}))`,
        )
        .get(channel.id, rootId, through, ...ACTIVITY_ITEM_TYPES, `${CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX}%`, ...ids),
    );
    return row ? requiredNumberColumn(row, "unread") : 0;
  }

  /**
   * The follow rows of the reader, by `<channelId>\n<rootId>`: the choice under the reader's own id
   * wins over a row under another id that names them, and any followed row counts.
   */
  #follows(viewer: ChannelViewer, channelId?: string): Map<string, boolean> {
    const ids = [...viewer.ids];
    const rows = databaseRows(
      this.store.database.connection
        .prepare(
          `SELECT channel_id, root_id, member_id, followed, explicit FROM projection_channel_thread_follows
            WHERE member_id IN (${placeholders(ids)}) ${channelId === undefined ? "" : "AND channel_id = ?"}`,
        )
        .all(...ids, ...(channelId === undefined ? [] : [channelId])),
    );
    const own = new Map<string, boolean>();
    const other = new Map<string, boolean>();
    for (const row of rows) {
      const key =
        channelId === undefined
          ? threadKey(requiredStringColumn(row, "channel_id"), requiredStringColumn(row, "root_id"))
          : requiredStringColumn(row, "root_id");
      const followed = requiredNumberColumn(row, "followed") === 1;
      if (requiredStringColumn(row, "member_id") === viewer.id) own.set(key, followed);
      else other.set(key, (other.get(key) ?? false) || followed);
    }
    return new Map([...other, ...own]);
  }

  /** A thread is followed by its row; with none, every thread of a DM or a group is. */
  #isFollowed(channel: Channel, choice: boolean | undefined): boolean {
    return choice ?? channelKind(channel) !== "channel";
  }

  /** The followed roots of one channel, newest reply first, at most `WORKSPACE_FOLLOWED_THREADS_LIMIT`. */
  #followedRoots(channel: Channel, viewer: ChannelViewer): string[] {
    return this.followedThreads([channel], viewer, WORKSPACE_FOLLOWED_THREADS_LIMIT).map((key) => key.rootId);
  }

  /** The roots of a channel that have replies, through the thread index. */
  #threadRoots(channelId: string): string[] {
    return databaseRows(
      this.store.database.connection
        .prepare(
          `SELECT DISTINCT json_extract(message_json, '$.threadRootId') AS root_id FROM projection_channel_messages
            WHERE channel_id = ? AND json_extract(message_json, '$.threadRootId') IS NOT NULL`,
        )
        .all(channelId),
    ).flatMap((row) => optionalStringColumn(row, "root_id") ?? []);
  }
}

export function threadKey(channelId: string, rootId: string): string {
  return `${channelId}\n${rootId}`;
}
