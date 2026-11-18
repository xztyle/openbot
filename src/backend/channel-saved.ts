import {
  type Channel,
  type ChannelMessage,
  decodeChannel,
  isChannelMessage,
  WORKSPACE_PIN_LIMIT,
  WORKSPACE_SAVED_PREVIEW_LIMIT,
  type WorkspaceMessageAuthor,
  type WorkspacePin,
  type WorkspacePins,
  type WorkspaceSavedInput,
  type WorkspaceSavedItem,
  type WorkspaceSavedPage,
  type WorkspaceSavedState,
  workspaceSavedLimit,
} from "@openbot/contracts/ipc";
import { type ChannelStore, channelPreviewText } from "./channel-store";
import { SAVE_SQL, UNSAVE_SQL } from "./channel-thread-projection";
import { type ChannelViewer, canSeeChannel } from "./channel-visibility";
import {
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "./database/database-rows";

/** The pinned messages of a channel that a person reads, newest pin first, through the pinned index. */
const PINNED_SQL = `SELECT message_json FROM projection_channel_messages
  WHERE channel_id = ? AND json_extract(message_json, '$.pinned') IS NOT NULL
    AND json_extract(message_json, '$.deletedAt') IS NULL
  ORDER BY json_extract(message_json, '$.pinned.at') DESC LIMIT ?`;

function authorOf(message: ChannelMessage): WorkspaceMessageAuthor {
  const external = message.externalAuthor;
  return external
    ? { kind: "external", id: external.id, name: external.name }
    : { kind: message.author.kind, id: message.author.id, name: message.author.name };
}

function preview(message: ChannelMessage): string {
  return channelPreviewText(message).replace(/\s+/gu, " ").trim().slice(0, WORKSPACE_SAVED_PREVIEW_LIMIT);
}

/**
 * Owns the saved items ("Later") of each person and the reads of the pins of each channel. A pin is
 * on the message; `ChannelService` writes it as a quiet change of the message. It holds the store and
 * reads `.connection` at each use; it never imports the database facade. It does not check who may
 * see a channel before a write: `ChannelService` does.
 */
export class ChannelSaved {
  constructor(readonly store: ChannelStore) {}

  /** A page of the person's saved items, newest first, in the channels they can still see. */
  list(input: WorkspaceSavedInput, memberId: string, viewer: ChannelViewer): WorkspaceSavedPage {
    const filters = [...(input.state ? ["saved.state = ?"] : []), ...(input.channelId ? ["saved.channel_id = ?"] : [])];
    const rows = databaseRows(
      this.store.database.connection
        .prepare(
          `SELECT saved.channel_id, saved.message_id, saved.state, saved.saved_at, message.message_json,
             channel.channel_json
           FROM projection_channel_saved saved
           JOIN projection_channels channel ON channel.channel_id = saved.channel_id
           LEFT JOIN projection_channel_messages message
             ON message.channel_id = saved.channel_id AND message.message_id = saved.message_id
           WHERE saved.member_id = ? ${filters.map((filter) => `AND ${filter}`).join(" ")}
           ORDER BY saved.saved_at DESC, saved.channel_id, saved.message_id`,
        )
        .all(memberId, ...(input.state ? [input.state] : []), ...(input.channelId ? [input.channelId] : [])),
    );
    const visible = new Map<string, boolean>();
    const items = rows.flatMap((row) => {
      const channelId = requiredStringColumn(row, "channel_id");
      if (!visible.has(channelId))
        visible.set(
          channelId,
          canSeeChannel(decodeChannel(JSON.parse(requiredStringColumn(row, "channel_json"))), viewer),
        );
      if (!visible.get(channelId)) return [];
      const json = optionalStringColumn(row, "message_json");
      const message = json ? JSON.parse(json) : null;
      if (!isChannelMessage(message)) return [];
      return [this.#item(message, requiredStringColumn(row, "state"), requiredStringColumn(row, "saved_at"))];
    });
    const offset = input.cursor ? Number(input.cursor) : 0;
    const page = items.slice(offset, offset + workspaceSavedLimit(input));
    const next = offset + page.length;
    return {
      items: page,
      total: items.length,
      nextCursor: page.length > 0 && next < items.length ? String(next) : null,
    };
  }

  /** The person's saved item of one message, or null. */
  item(channelId: string, messageId: string, memberId: string): WorkspaceSavedItem | null {
    const row = databaseRow(
      this.store.database.connection
        .prepare(
          "SELECT state, saved_at FROM projection_channel_saved WHERE member_id = ? AND channel_id = ? AND message_id = ?",
        )
        .get(memberId, channelId, messageId),
    );
    const message = this.store.message(channelId, messageId);
    if (!row || !message) return null;
    return this.#item(message, requiredStringColumn(row, "state"), requiredStringColumn(row, "saved_at"));
  }

  /** Saves a message for the person, marks it done, or removes it (`null`). */
  set(
    channelId: string,
    messageId: string,
    memberId: string,
    state: WorkspaceSavedState | null,
    operationId: string,
  ): void {
    const at = new Date().toISOString();
    this.store.database.dispatch(
      `channel-saved:${memberId}:${operationId}`,
      [
        {
          aggregateType: "channel",
          aggregateId: channelId,
          eventType: "channel.saved",
          payload: { memberId, messageId, state, at },
        },
      ],
      (db) => {
        if (state === null) db.prepare(UNSAVE_SQL).run(memberId, channelId, messageId);
        else db.prepare(SAVE_SQL).run(memberId, channelId, messageId, state, at);
        return null;
      },
    );
  }

  /** The pins of a channel, newest first. */
  pins(channel: Channel): WorkspacePins {
    const pins = databaseRows(
      this.store.database.connection.prepare(PINNED_SQL).all(channel.id, WORKSPACE_PIN_LIMIT),
    ).flatMap((row): WorkspacePin[] => {
      const message = JSON.parse(requiredStringColumn(row, "message_json"));
      if (!isChannelMessage(message) || !message.pinned) return [];
      return [
        {
          messageId: message.id,
          ...(message.threadRootId === undefined ? {} : { threadRootId: message.threadRootId }),
          author: authorOf(message),
          at: message.message.createdAt,
          preview: preview(message),
          pinnedBy: { kind: message.pinned.by.kind, id: message.pinned.by.id },
          pinnedAt: message.pinned.at,
        },
      ];
    });
    return { channelId: channel.id, pins };
  }

  /** How many messages of a channel are pinned, deleted ones left out. */
  pinCount(channelId: string): number {
    const row = databaseRow(
      this.store.database.connection
        .prepare(
          `SELECT COUNT(*) AS pins FROM projection_channel_messages
            WHERE channel_id = ? AND json_extract(message_json, '$.pinned') IS NOT NULL
              AND json_extract(message_json, '$.deletedAt') IS NULL`,
        )
        .get(channelId),
    );
    return row ? requiredNumberColumn(row, "pins") : 0;
  }

  #item(message: ChannelMessage, state: string, savedAt: string): WorkspaceSavedItem {
    const deleted = message.deletedAt !== undefined;
    return {
      channelId: message.channelId,
      messageId: message.id,
      ...(message.threadRootId === undefined ? {} : { threadRootId: message.threadRootId }),
      state: state === "done" ? "done" : "saved",
      savedAt,
      author: authorOf(message),
      at: message.message.createdAt,
      preview: deleted ? "" : preview(message),
      deleted,
    };
  }
}
