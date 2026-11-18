import type { DatabaseSync } from "node:sqlite";
import { CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX, type ChannelMessage } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { databaseRow, optionalStringColumn } from "./database/database-rows";

// The thread state rows that channel commits and rebuilds derive (`ChannelStore`), apart from the
// reads of `ChannelReadState`, so the store does not import the class that reads it.

/** Item types that are activity, not a message a reader counts. */
export const ACTIVITY_ITEM_TYPES = ["plan", "subagents", "channel-change", "commentary"];

export const FOLLOW_SQL = `INSERT OR IGNORE INTO projection_channel_thread_follows (channel_id, root_id, member_id, followed, explicit)
  VALUES (?, ?, ?, 1, 0)`;
export const READ_FORWARD_SQL = `INSERT INTO projection_channel_thread_reads (channel_id, root_id, member_id, through_sequence)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(channel_id, root_id, member_id) DO UPDATE SET through_sequence = MAX(through_sequence, excluded.through_sequence)`;
/** Sets a channel position exactly, also back: a person marked a message unread. */
export const CHANNEL_POSITION_SQL = `INSERT INTO projection_channel_reads (channel_id, member_id, through_sequence)
  VALUES (?, ?, ?)
  ON CONFLICT(channel_id, member_id) DO UPDATE SET through_sequence = excluded.through_sequence`;
/** Sets a thread position exactly, also back. */
export const THREAD_POSITION_SQL = `INSERT INTO projection_channel_thread_reads (channel_id, root_id, member_id, through_sequence)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(channel_id, root_id, member_id) DO UPDATE SET through_sequence = excluded.through_sequence`;
export const CHOICE_SQL = `INSERT INTO projection_channel_thread_follows (channel_id, root_id, member_id, followed, explicit)
  VALUES (?, ?, ?, ?, 1)
  ON CONFLICT(channel_id, root_id, member_id) DO UPDATE SET followed = excluded.followed, explicit = 1`;

/** Thinking, plans, notes and routing events are not replies a person reads. */
function isThreadNoise(message: ChannelMessage): boolean {
  const itemType = message.message.itemType ?? "";
  return ACTIVITY_ITEM_TYPES.includes(itemType) || itemType.startsWith(CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX);
}

/** The team member who wrote a message, or null for an agent, a coordinator or a bridged author. */
function personAuthor(message: Pick<ChannelMessage, "author" | "externalAuthor">): string | null {
  return message.author.kind === "member" && message.externalAuthor === undefined && message.author.id.length > 0
    ? message.author.id
    : null;
}

/**
 * The follows and the read position that a written message gives, inside the commit that writes it
 * (`ChannelStore.project`), so a rebuild from the events derives them again. The person who writes a
 * reply follows its thread again and has read it through the reply; the person who wrote the root and
 * each person the reply mentions follow it, unless they chose to stop following it.
 */
export function projectThreadState(db: DatabaseSync, channelId: string, message: ChannelMessage, created: boolean) {
  const rootId = message.threadRootId;
  if (rootId === undefined || isThreadNoise(message)) return;
  const follow = db.prepare(FOLLOW_SQL);
  const author = personAuthor(message);
  if (created && author) {
    db.prepare(
      `INSERT INTO projection_channel_thread_follows (channel_id, root_id, member_id, followed, explicit)
       VALUES (?, ?, ?, 1, 0)
       ON CONFLICT(channel_id, root_id, member_id) DO UPDATE SET followed = 1, explicit = 0`,
    ).run(channelId, rootId, author);
    db.prepare(READ_FORWARD_SQL).run(channelId, rootId, author, message.sequence);
  }
  const root = databaseRow(
    db
      .prepare(
        `SELECT json_extract(message_json, '$.author.kind') AS kind, json_extract(message_json, '$.author.id') AS id,
           json_extract(message_json, '$.externalAuthor') AS external
         FROM projection_channel_messages WHERE channel_id = ? AND message_id = ?`,
      )
      .get(channelId, rootId),
  );
  const rootAuthor = root ? optionalStringColumn(root, "id") : null;
  if (root && root.kind === "member" && root.external === null && rootAuthor) follow.run(channelId, rootId, rootAuthor);
  for (const mention of message.mentions ?? [])
    if (mention.kind === "member" && mention.id) follow.run(channelId, rootId, mention.id);
}

/**
 * Applies one stored read state event of a channel during a rebuild (`ChannelStore.rebuild`): a thread
 * read, a follow, an unread mark or the import of migration 52.
 * Answers false for an event that is not one of them.
 */
export function replayReadStateEvent(db: DatabaseSync, channelId: string, type: unknown, value: unknown): boolean {
  if (!isDynamicRecord(value)) return false;
  switch (type) {
    case "channel.thread-read":
      if (!isString(value.memberId) || !isString(value.rootId) || typeof value.throughSequence !== "number")
        throw new Error("Invalid thread read event.");
      db.prepare(READ_FORWARD_SQL).run(channelId, value.rootId, value.memberId, value.throughSequence);
      return true;
    case "channel.thread-follow":
      if (!isString(value.memberId) || !isString(value.rootId) || typeof value.followed !== "boolean")
        throw new Error("Invalid thread follow event.");
      db.prepare(CHOICE_SQL).run(channelId, value.rootId, value.memberId, value.followed ? 1 : 0);
      return true;
    case "channel.unread":
    case "channel.thread-unread": {
      const memberIds = Array.isArray(value.memberIds) ? value.memberIds : [];
      if (!memberIds.length || !memberIds.every(isString) || typeof value.throughSequence !== "number")
        throw new Error("Invalid unread event.");
      const rootId = value.rootId;
      if (type === "channel.unread") {
        for (const memberId of memberIds)
          db.prepare(CHANNEL_POSITION_SQL).run(channelId, memberId, value.throughSequence);
        return true;
      }
      if (!isString(rootId)) throw new Error("Invalid unread event.");
      for (const memberId of memberIds)
        db.prepare(THREAD_POSITION_SQL).run(channelId, rootId, memberId, value.throughSequence);
      return true;
    }
    case "channel.thread-state-imported": {
      const reads = Array.isArray(value.reads) ? value.reads : [];
      const follows = Array.isArray(value.follows) ? value.follows : [];
      for (const read of reads) {
        if (!isDynamicRecord(read) || !isString(read.rootId) || !isString(read.memberId))
          throw new Error("Invalid imported thread state event.");
        if (typeof read.throughSequence !== "number") throw new Error("Invalid imported thread state event.");
        db.prepare(READ_FORWARD_SQL).run(channelId, read.rootId, read.memberId, read.throughSequence);
      }
      for (const entry of follows) {
        if (!isDynamicRecord(entry) || !isString(entry.rootId) || !isString(entry.memberId))
          throw new Error("Invalid imported thread state event.");
        db.prepare(FOLLOW_SQL).run(channelId, entry.rootId, entry.memberId);
      }
      return true;
    }
    default:
      return false;
  }
}

export const SAVE_SQL = `INSERT INTO projection_channel_saved (member_id, channel_id, message_id, state, saved_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(member_id, channel_id, message_id) DO UPDATE SET state = excluded.state`;
export const UNSAVE_SQL =
  "DELETE FROM projection_channel_saved WHERE member_id = ? AND channel_id = ? AND message_id = ?";

/** Applies one stored `channel.saved` event during a rebuild. Answers false for any other event. */
export function replaySavedEvent(db: DatabaseSync, channelId: string, type: unknown, value: unknown): boolean {
  if (type !== "channel.saved") return false;
  if (
    !isDynamicRecord(value) ||
    !isString(value.memberId) ||
    !isString(value.messageId) ||
    !isString(value.at) ||
    !(value.state === null || value.state === "saved" || value.state === "done")
  )
    throw new Error("Invalid saved item event.");
  if (value.state === null) db.prepare(UNSAVE_SQL).run(value.memberId, channelId, value.messageId);
  else db.prepare(SAVE_SQL).run(value.memberId, channelId, value.messageId, value.state, value.at);
  return true;
}
