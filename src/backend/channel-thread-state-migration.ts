import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { CHANNEL_THREAD_STATE_SCHEMA_SQL } from "./channel-schema";

// Migration 52. It is frozen with the version: a later change of the channel rules goes into a new
// migration, not into this text.

/** A stored reply that the thread state counts: a thread reply that is not activity or a routing note. */
const V52_REPLY = `typeof(json_extract(message_json, '$.threadRootId')) = 'text'
  AND COALESCE(json_extract(message_json, '$.message.itemType'), '') NOT IN ('plan', 'subagents', 'channel-change', 'commentary')
  AND COALESCE(json_extract(message_json, '$.message.itemType'), '') NOT LIKE 'channel-routing-event:%'`;

/** The author of a reply when it is a person of the team: a member, and no message that a bridge brought. */
const V52_PERSON_AUTHOR = `json_extract(message_json, '$.author.kind') = 'member'
  AND json_extract(message_json, '$.externalAuthor') IS NULL
  AND typeof(json_extract(message_json, '$.author.id')) = 'text'
  AND json_extract(message_json, '$.author.id') != ''`;

/**
 * The people who follow each existing thread, as the channel store derives them for a new reply: the
 * author of each reply, the author of the root, and each person that a reply mentions.
 */
const V52_FOLLOWS_SQL = `
  INSERT OR IGNORE INTO projection_channel_thread_follows (channel_id, root_id, member_id, followed, explicit)
  SELECT channel_id, json_extract(message_json, '$.threadRootId'), json_extract(message_json, '$.author.id'), 1, 0
    FROM projection_channel_messages WHERE ${V52_REPLY} AND ${V52_PERSON_AUTHOR};
  INSERT OR IGNORE INTO projection_channel_thread_follows (channel_id, root_id, member_id, followed, explicit)
  SELECT root.channel_id, root.message_id, json_extract(root.message_json, '$.author.id'), 1, 0
    FROM projection_channel_messages root
   WHERE json_extract(root.message_json, '$.author.kind') = 'member'
     AND json_extract(root.message_json, '$.externalAuthor') IS NULL
     AND typeof(json_extract(root.message_json, '$.author.id')) = 'text'
     AND json_extract(root.message_json, '$.author.id') != ''
     AND EXISTS (SELECT 1 FROM projection_channel_messages
                  WHERE channel_id = root.channel_id AND ${V52_REPLY}
                    AND json_extract(message_json, '$.threadRootId') = root.message_id);
  INSERT OR IGNORE INTO projection_channel_thread_follows (channel_id, root_id, member_id, followed, explicit)
  SELECT message.channel_id, json_extract(message.message_json, '$.threadRootId'), json_extract(mention.value, '$.id'), 1, 0
    FROM projection_channel_messages message, json_each(message.message_json, '$.mentions') mention
   WHERE ${V52_REPLY.replaceAll("message_json", "message.message_json")}
     AND json_type(message.message_json, '$.mentions') = 'array'
     AND json_extract(mention.value, '$.kind') = 'member'
     AND typeof(json_extract(mention.value, '$.id')) = 'text'
     AND json_extract(mention.value, '$.id') != '';
`;

/**
 * The read position of each person in each existing thread: the position that they had in its
 * channel, which is what the thread showed them before, or their own last reply when it is later.
 */
const V52_READS_SQL = `
  INSERT INTO projection_channel_thread_reads (channel_id, root_id, member_id, through_sequence)
  SELECT channel_id, root_id, member_id, MAX(through) FROM (
    SELECT reads.channel_id AS channel_id, threads.root_id AS root_id, reads.member_id AS member_id,
           reads.through_sequence AS through
      FROM projection_channel_reads reads
      JOIN (SELECT DISTINCT channel_id, json_extract(message_json, '$.threadRootId') AS root_id
              FROM projection_channel_messages WHERE ${V52_REPLY}) threads
        ON threads.channel_id = reads.channel_id
    UNION ALL
    SELECT channel_id, json_extract(message_json, '$.threadRootId'), json_extract(message_json, '$.author.id'), sequence
      FROM projection_channel_messages WHERE ${V52_REPLY} AND ${V52_PERSON_AUTHOR}
  )
  WHERE typeof(through) = 'integer' AND through >= 0
  GROUP BY channel_id, root_id, member_id;
`;

/**
 * Adds the thread read positions and follows, fills them from the stored channels, and appends one
 * `channel.thread-state-imported` event for each channel that got rows, so a rebuild of the channel
 * from its events has them too. It runs inside the migration transaction.
 */
export function migrateChannelThreadState(db: DatabaseSync, appliedAt: string): void {
  db.exec(CHANNEL_THREAD_STATE_SCHEMA_SQL);
  db.exec(V52_FOLLOWS_SQL);
  db.exec(V52_READS_SQL);
  const rows = db
    .prepare(
      `SELECT channel.channel_id,
         (SELECT json_group_array(json_object('rootId', root_id, 'memberId', member_id, 'throughSequence', through_sequence))
            FROM projection_channel_thread_reads WHERE channel_id = channel.channel_id) AS reads,
         (SELECT json_group_array(json_object('rootId', root_id, 'memberId', member_id))
            FROM projection_channel_thread_follows WHERE channel_id = channel.channel_id) AS follows
       FROM projection_channels channel
       WHERE EXISTS (SELECT 1 FROM projection_channel_thread_reads WHERE channel_id = channel.channel_id)
          OR EXISTS (SELECT 1 FROM projection_channel_thread_follows WHERE channel_id = channel.channel_id)
       ORDER BY channel.channel_id`,
    )
    .all();
  const append = db.prepare(
    `INSERT INTO orchestration_events (event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json)
     VALUES (?, ?, 'channel', ?, 'channel.thread-state-imported', ?, ?)`,
  );
  for (const row of rows) {
    if (!isDynamicRecord(row) || !isString(row.channel_id) || !isString(row.reads) || !isString(row.follows))
      throw new Error("Migration 52 read an invalid channel row.");
    // Both lists are JSON that SQLite wrote, so the payload joins their text.
    append.run(
      randomUUID(),
      `migration:52:${row.channel_id}`,
      row.channel_id,
      appliedAt,
      `{"reads":${row.reads},"follows":${row.follows}}`,
    );
  }
}
