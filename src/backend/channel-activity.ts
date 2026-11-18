import {
  CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX,
  type Channel,
  type ChannelMention,
  type ChannelMessage,
  type ChannelReaction,
  type ChannelThreadSummary,
  channelKind,
  decodeChannel,
  isChannelMention,
  isChannelMessage,
  isChannelReaction,
  isChannelThreadSummary,
  WORKSPACE_ACTIVITY_PREVIEW_LIMIT,
  WORKSPACE_ACTIVITY_THREAD_LIMIT,
  type WorkspaceActivity,
  type WorkspaceActivityActor,
  type WorkspaceActivityInput,
  type WorkspaceActivityItem,
  type WorkspaceThreadActivity,
  workspaceActivityLimit,
} from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { type ChannelReadState, threadKey } from "./channel-read-state";
import { ACTIVITY_ITEM_TYPES, type ChannelStore, channelPreviewText } from "./channel-store";
import { type ChannelViewer, canSeeChannel, isChannelPerson } from "./channel-visibility";
import {
  databaseRow,
  databaseRows,
  optionalNumberColumn,
  optionalStringColumn,
  placeholders,
  requiredNumberColumn,
  requiredStringColumn,
} from "./database/database-rows";

/** The newest messages of each channel that the activity looks at. */
const ACTIVITY_WINDOW_MESSAGES = 300;
/** Older messages are not activity. */
const ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The fields of a stored message that the activity reads. SQLite extracts them, so the text of up to
 * 300 messages per channel is not parsed; only the messages that become items are read in full.
 */
const ACTIVITY_COLUMNS = `message_id, sequence,
  json_extract(message_json, '$.author.kind') AS author_kind,
  json_extract(message_json, '$.author.id') AS author_id,
  json_extract(message_json, '$.author.name') AS author_name,
  json_extract(message_json, '$.externalAuthor.id') AS external_id,
  json_extract(message_json, '$.externalAuthor.name') AS external_name,
  json_extract(message_json, '$.threadRootId') AS thread_root_id,
  json_extract(message_json, '$.alsoInChannel') AS also_in_channel,
  json_extract(message_json, '$.deletedAt') AS deleted_at,
  json_extract(message_json, '$.mentions') AS mentions,
  json_extract(message_json, '$.reactions') AS reactions,
  json_extract(message_json, '$.threadSummary') AS thread_summary,
  json_extract(message_json, '$.message.itemType') AS item_type,
  json_extract(message_json, '$.message.status') AS status,
  json_extract(message_json, '$.message.createdAt') AS created_at`;

interface ActivityRow {
  id: string;
  sequence: number;
  author: ChannelMessage["author"];
  external: { id: string; name: string } | null;
  threadRootId: string | null;
  alsoInChannel: boolean;
  deleted: boolean;
  mentions: ChannelMention[];
  reactions: ChannelReaction[];
  threadSummary: ChannelThreadSummary | null;
  /** Thinking, narration, plans, routing events and a streaming part are not activity. */
  noise: boolean;
  createdAt: string;
  time: number;
}

interface ItemCandidate {
  item: Omit<WorkspaceActivityItem, "preview">;
  sequence: number;
  time: number;
}

/**
 * Owns the cross-channel read of the workspace for one reader: the mentions, thread replies, direct
 * messages and reactions of the Activity view, and the threads of the Threads view. It only reads.
 * It holds the store and reads `.connection` at each use; it never imports the database facade.
 */
export class ChannelActivity {
  constructor(
    readonly store: ChannelStore,
    readonly readState: ChannelReadState,
  ) {}

  /**
   * A reaction carries no name of its actor: an agent takes its name from `agentName`, a person the
   * name of a message they wrote in the read messages, else the id.
   */
  read(
    input: WorkspaceActivityInput,
    viewer: ChannelViewer,
    agentName: (agentId: string) => string | undefined,
  ): WorkspaceActivity {
    const limit = workspaceActivityLimit(input);
    const since = Date.now() - ACTIVITY_WINDOW_MS;
    const reads = this.#readPositions(viewer);
    const threadReads = this.readState.positions(viewer);
    const channels = this.#visibleChannels(viewer);
    const followed = this.readState.followedSet(channels, viewer);
    const own = (row: ActivityRow) => row.author.kind === "member" && !row.external && viewer.ids.has(row.author.id);
    const memberNames = new Map<string, string>();
    const candidates: ItemCandidate[] = [];
    for (const channel of channels) {
      const through = reads.get(channel.id) ?? 0;
      // A thread reply is read in its thread; one that was also sent to the channel, in both.
      const unread = (row: ActivityRow) =>
        row.threadRootId === null
          ? row.sequence > through
          : row.sequence > (threadReads.get(threadKey(channel.id, row.threadRootId)) ?? 0) &&
            (!row.alsoInChannel || row.sequence > through);
      const rows = this.#rows(channel.id).filter((row) => row.time >= since);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const roots = new Map<string, ActivityRow | null>();
      const root = (rootId: string) => {
        if (!roots.has(rootId)) roots.set(rootId, byId.get(rootId) ?? this.#row(channel.id, rootId));
        return roots.get(rootId) ?? null;
      };
      const person = isChannelPerson(channel, viewer);
      const direct = channelKind(channel) !== "channel";
      /**
       * The first reply of the reader in each thread, in the read messages. A reader who follows a
       * thread only because they replied there gets the replies after their own, not the ones before.
       */
      const firstOwnReply = new Map<string, number>();
      for (const row of rows)
        if (row.threadRootId && own(row) && !firstOwnReply.has(row.threadRootId))
          firstOwnReply.set(row.threadRootId, row.sequence);
      for (const row of rows) {
        if (row.author.kind === "member" && !row.external) memberNames.set(row.author.id, row.author.name);
        if (row.noise || row.deleted) continue;
        if (own(row)) {
          for (const reaction of row.reactions)
            for (const actor of reaction.actors) {
              if (actor.kind === "member" && viewer.ids.has(actor.id)) continue;
              candidates.push({
                item: {
                  id: `reaction:${row.id}:${reaction.emoji}:${actor.kind}:${actor.id}`,
                  kind: "reaction",
                  channelId: channel.id,
                  messageId: row.id,
                  ...(row.threadRootId ? { threadRootId: row.threadRootId } : {}),
                  actor: { kind: actor.kind, id: actor.id, name: "" },
                  emoji: reaction.emoji,
                  at: row.createdAt,
                  unread: unread(row),
                },
                sequence: row.sequence,
                time: row.time,
              });
            }
          continue;
        }
        const mentioned = row.mentions.some((mention) =>
          mention.kind === "member"
            ? mention.id !== undefined && viewer.ids.has(mention.id)
            : (mention.kind === "channel" || mention.kind === "here") && person,
        );
        const threadRoot = row.threadRootId ? root(row.threadRootId) : null;
        const firstOwn = row.threadRootId ? firstOwnReply.get(row.threadRootId) : undefined;
        const reply =
          row.threadRootId !== null &&
          followed(channel.id, row.threadRootId) &&
          ((threadRoot !== null && own(threadRoot)) || firstOwn === undefined || row.sequence > firstOwn);
        const shown = row.threadRootId === null || row.alsoInChannel;
        const kind = mentioned ? "mention" : reply ? "reply" : direct && shown ? "dm" : null;
        if (!kind) continue;
        candidates.push({
          item: {
            id: `${kind}:${row.id}`,
            kind,
            channelId: channel.id,
            messageId: row.id,
            ...(row.threadRootId ? { threadRootId: row.threadRootId } : {}),
            actor: activityActor(row),
            at: row.createdAt,
            unread: unread(row),
          },
          sequence: row.sequence,
          time: row.time,
        });
      }
    }
    const newest = (left: ItemCandidate, right: ItemCandidate) =>
      right.time - left.time || right.sequence - left.sequence || left.item.id.localeCompare(right.item.id);
    const texts = new Map<string, string>();
    const preview = (channelId: string, messageId: string) => {
      const key = `${channelId}\n${messageId}`;
      if (!texts.has(key)) texts.set(key, this.#preview(channelId, messageId));
      return texts.get(key) ?? "";
    };
    const actorName = (actor: WorkspaceActivityActor) =>
      actor.name || (actor.kind === "agent" ? agentName(actor.id) : memberNames.get(actor.id)) || actor.id;
    const items = candidates
      .sort(newest)
      .slice(0, limit)
      .map(({ item }) => ({
        ...item,
        actor: { ...item.actor, name: actorName(item.actor) },
        preview: preview(item.channelId, item.messageId),
      }));
    const byChannel = new Map(channels.map((channel) => [channel.id, channel]));
    const threadItems: WorkspaceThreadActivity[] = this.readState
      .followedThreads(channels, viewer, WORKSPACE_ACTIVITY_THREAD_LIMIT)
      .flatMap(({ channelId, rootId }) => {
        const channel = byChannel.get(channelId);
        const root = this.#row(channelId, rootId);
        const summary = root?.threadSummary;
        if (!channel || !root || root.noise || !summary || summary.replyCount === 0) return [];
        const through = threadReads.get(threadKey(channelId, rootId)) ?? 0;
        return [
          {
            channelId,
            rootId: root.id,
            rootAuthor: { kind: root.author.kind, id: root.author.id, name: root.external?.name ?? root.author.name },
            rootText: root.deleted ? "" : preview(channelId, root.id),
            replyCount: summary.replyCount,
            lastReplyAt: summary.lastReplyAt,
            participantIds: summary.participantIds,
            unreadCount: this.readState.unreadReplies(channel, root.id, through, viewer),
          },
        ];
      });
    return { items, threads: threadItems };
  }

  #visibleChannels(viewer: ChannelViewer): Channel[] {
    return databaseRows(
      this.store.database.connection
        .prepare(
          "SELECT channel_json FROM projection_channels WHERE COALESCE(json_extract(channel_json, '$.archived'), 0) = 0 ORDER BY rowid",
        )
        .all(),
    )
      .map((row) => decodeChannel(JSON.parse(requiredStringColumn(row, "channel_json"))))
      .filter((channel) => canSeeChannel(channel, viewer));
  }

  /** The read position of the reader in each channel, under any id that names them. */
  #readPositions(viewer: ChannelViewer): Map<string, number> {
    const ids = [...viewer.ids];
    const rows = databaseRows(
      this.store.database.connection
        .prepare(
          `SELECT channel_id, MAX(through_sequence) AS through FROM projection_channel_reads
            WHERE member_id IN (${placeholders(ids)}) GROUP BY channel_id`,
        )
        .all(...ids),
    );
    return new Map(rows.map((row) => [requiredStringColumn(row, "channel_id"), requiredNumberColumn(row, "through")]));
  }

  /** The newest messages of a channel, oldest first. */
  #rows(channelId: string): ActivityRow[] {
    return databaseRows(
      this.store.database.connection
        .prepare(
          `SELECT ${ACTIVITY_COLUMNS} FROM projection_channel_messages
            WHERE channel_id = ? ORDER BY sequence DESC, message_id DESC LIMIT ?`,
        )
        .all(channelId, ACTIVITY_WINDOW_MESSAGES),
    )
      .reverse()
      .flatMap((row) => activityRow(row) ?? []);
  }

  #row(channelId: string, messageId: string): ActivityRow | null {
    const row = databaseRow(
      this.store.database.connection
        .prepare(`SELECT ${ACTIVITY_COLUMNS} FROM projection_channel_messages WHERE channel_id = ? AND message_id = ?`)
        .get(channelId, messageId),
    );
    return row ? activityRow(row) : null;
  }

  #preview(channelId: string, messageId: string): string {
    const row = databaseRow(
      this.store.database.connection
        .prepare("SELECT message_json FROM projection_channel_messages WHERE channel_id = ? AND message_id = ?")
        .get(channelId, messageId),
    );
    if (!row) return "";
    const message = JSON.parse(requiredStringColumn(row, "message_json"));
    if (!isChannelMessage(message) || message.deletedAt !== undefined) return "";
    return channelPreviewText(message).replace(/\s+/gu, " ").trim().slice(0, WORKSPACE_ACTIVITY_PREVIEW_LIMIT);
  }
}

function activityActor(row: ActivityRow): WorkspaceActivityActor {
  return row.external
    ? { kind: "external", id: row.external.id, name: row.external.name }
    : { kind: row.author.kind, id: row.author.id, name: row.author.name };
}

function jsonList<T>(value: string | null, guard: (entry: unknown) => entry is T): T[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter(guard) : [];
}

/** A row that has no valid author or time is not activity: the read leaves it out. */
function activityRow(row: DynamicRecord): ActivityRow | null {
  const kind = optionalStringColumn(row, "author_kind");
  const authorId = optionalStringColumn(row, "author_id");
  const createdAt = optionalStringColumn(row, "created_at");
  const time = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (
    (kind !== "member" && kind !== "agent" && kind !== "coordinator") ||
    !authorId ||
    !createdAt ||
    Number.isNaN(time)
  )
    return null;
  const externalId = optionalStringColumn(row, "external_id");
  const itemType = optionalStringColumn(row, "item_type") ?? "";
  const summaryJson = optionalStringColumn(row, "thread_summary");
  const summary = summaryJson ? JSON.parse(summaryJson) : null;
  return {
    id: requiredStringColumn(row, "message_id"),
    sequence: requiredNumberColumn(row, "sequence"),
    author: { kind, id: authorId, name: optionalStringColumn(row, "author_name") ?? "" },
    external: externalId ? { id: externalId, name: optionalStringColumn(row, "external_name") ?? externalId } : null,
    threadRootId: optionalStringColumn(row, "thread_root_id"),
    alsoInChannel: optionalNumberColumn(row, "also_in_channel") === 1,
    deleted: optionalStringColumn(row, "deleted_at") !== null,
    mentions: jsonList(optionalStringColumn(row, "mentions"), isChannelMention),
    reactions: jsonList(optionalStringColumn(row, "reactions"), isChannelReaction),
    threadSummary: isChannelThreadSummary(summary) ? summary : null,
    noise:
      optionalStringColumn(row, "status") === "streaming" ||
      ACTIVITY_ITEM_TYPES.includes(itemType) ||
      itemType.startsWith(CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX),
    createdAt,
    time,
  };
}
