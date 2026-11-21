import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { sortConversationMessages } from "@openbot/contracts/conversation-order";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { Effect, Result } from "effect";
import { z } from "zod";
import type { MailboxStore } from "../mailbox-store";
import { alertOwnerToolSchema, holdForOwnerToolSchema, sharePreviewToolSchema } from "../openbot-tools";
import { type OwnerAwayService, OwnerHoldRefused } from "../owner-away";
import type { DynamicToolCallParams } from "../protocol";
import type { SharePreviewDrawer } from "../workspace-thumbnails";
import type { AttachmentGateway } from "./attachment-gateway";
import type { ChatVisualPreviewHost } from "./chat-visual-preview";
import type { ConversationRuntime } from "./conversation-runtime";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "./routine-tools";
import { csvPreviewHtml } from "./share-preview";
import { toToolOperationFailed } from "./tool-operation";

export const OWNER_TOOL_NAMES: ReadonlySet<string> = new Set(["hold_for_owner", "alert_owner", "share_preview"]);

/**
 * A `share_preview` message is an attachment message with a caption, so every chat, channel and
 * client that shows attached images shows it.
 */
const SHARE_PREVIEW_ITEM_TYPE = "agent_attachment";
/** The largest file `share_preview` reads: an image, a CSV file or an HTML page. */
const FILE_LIMIT_BYTES = 8 * 1024 * 1024;
const CSV_LIMIT_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const PREVIEW_WIDTH = 720;

export interface OwnerToolsOptions {
  ownerAway: OwnerAwayService | null;
  thumbnails: SharePreviewDrawer | null;
  visualPreview: ChatVisualPreviewHost | null;
  attachments: Pick<AttachmentGateway, "openSources">;
  mailbox: Pick<
    MailboxStore,
    "stageGeneratedBytes" | "persistGeneratedAttachmentsWithConversation" | "discardStagedGeneratedAttachments"
  >;
  conversation: Pick<ConversationRuntime, "ensureSnapshot" | "publishConversation">;
  /** The team channel that the turn works for, for the place of a held request. */
  teamChannel: (agentId: string, turnId: string) => string | null;
}

function failure(error: z.ZodError): OpenBotToolResponse {
  return openBotToolFailure(`${z.prettifyError(error)}\nCorrect the arguments and retry.`);
}

function previewMessageId(params: DynamicToolCallParams): string {
  const digest = createHash("sha256")
    .update(`${params.threadId}\0${params.turnId}\0${params.callId}`)
    .digest("hex")
    .slice(0, 32);
  return `share-preview:${digest}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "page";
  }
}

function dataUrlBytes(url: string): Uint8Array | null {
  const match = /^data:image\/png;base64,(.+)$/u.exec(url);
  return match?.[1] ? new Uint8Array(Buffer.from(match[1], "base64")) : null;
}

interface PreviewFile {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
}

/**
 * `hold_for_owner`, `alert_owner` and `share_preview`: the tools with which an agent works with the
 * owner's time. A held request waits in the owner's "When you're back" list; an alert wakes the owner
 * only when it is urgent; a preview shows a deliverable as a picture with a caption.
 */
export class OwnerTools {
  readonly #options: OwnerToolsOptions;

  constructor(options: OwnerToolsOptions) {
    this.#options = options;
  }

  /** The answer of an owner tool, or null for another tool. */
  readonly handle = Effect.fn("OwnerTools.handle")(function* (
    this: OwnerTools,
    params: DynamicToolCallParams,
    agentId: string,
    executionThreadId: string,
  ) {
    if (params.tool === "hold_for_owner") return this.#hold(params, agentId);
    if (params.tool === "alert_owner") return this.#alert(params, agentId);
    if (params.tool === "share_preview") return yield* this.#share(params, agentId, executionThreadId);
    return null;
  });

  #hold(params: DynamicToolCallParams, agentId: string): OpenBotToolResponse {
    const parsed = holdForOwnerToolSchema.safeParse(params.arguments);
    if (!parsed.success) return failure(parsed.error);
    const away = this.#options.ownerAway;
    if (!away) return openBotToolFailure("This Atelier has no held list. Ask with ask_user instead.");
    const channelId = this.#options.teamChannel(agentId, params.turnId);
    try {
      const item = away.hold({ agentId, ...parsed.data, ...(channelId ? { channelId } : {}) });
      return openBotToolResult({
        status: "held",
        id: item.id,
        note: "The owner sees it when they come back, with their other held requests. Do not wait and do not ask again: continue other work or end your turn. Their answer comes to you as a message from them.",
      });
    } catch (error) {
      if (error instanceof OwnerHoldRefused) return openBotToolFailure(error.message);
      throw error;
    }
  }

  #alert(params: DynamicToolCallParams, agentId: string): OpenBotToolResponse {
    const parsed = alertOwnerToolSchema.safeParse(params.arguments);
    if (!parsed.success) return failure(parsed.error);
    const away = this.#options.ownerAway;
    if (!away) return openBotToolFailure("This Atelier cannot push an alert. Say it in your answer.");
    const { category, amountUsd } = parsed.data;
    const result = away.alert({ agentId, category, ...(amountUsd === undefined ? {} : { amountUsd }) });
    if (!result.sent)
      return openBotToolResult({
        status: "not_sent",
        note: "You sent an alert of this kind a few minutes ago. Say the details in your answer; do not alert again.",
      });
    return openBotToolResult({
      status: "sent",
      urgent: result.urgent,
      note: result.urgent
        ? "The owner's phone was told now. Put what happened and what you need first in your answer."
        : "Not urgent enough for the owner's quiet hours: it waits until they end. Put the details in your answer.",
    });
  }

  readonly #share = Effect.fn("OwnerTools.share")(function* (
    this: OwnerTools,
    params: DynamicToolCallParams,
    agentId: string,
    threadId: string,
  ) {
    const parsed = sharePreviewToolSchema.safeParse(params.arguments);
    if (!parsed.success) return failure(parsed.error);
    const { url, paths, caption, revision } = parsed.data;
    const messageId = previewMessageId(params);
    if (this.#options.conversation.ensureSnapshot(agentId, threadId).messages.some(({ id }) => id === messageId))
      return openBotToolResult({ status: "shown", messageId });
    const files: PreviewFile[] = [];
    if (url) {
      const thumbnails = this.#options.thumbnails;
      if (!thumbnails) return openBotToolFailure("This Atelier cannot draw pages. Send the link in your answer.");
      const image = yield* thumbnails.drawNow(url, revision ?? "");
      if (!image)
        return openBotToolFailure(
          "The page could not be drawn: it is not public, it did not load in 15 seconds, or it is on a private address. Send the link in your answer.",
        );
      files.push({
        bytes: image.bytes,
        name: `${hostOf(url)}.${image.mimeType === "image/webp" ? "webp" : "png"}`,
        mimeType: image.mimeType,
      });
    } else if (paths) {
      const read = yield* this.#readFiles(agentId, paths, caption);
      if (typeof read === "string") return openBotToolFailure(read);
      files.push(...read);
    }
    if (files.length === 0) return openBotToolFailure("Nothing to show. Pass a url or the paths of files.");
    const text = url ? `${caption}\n${url}` : caption;
    const attachments = yield* this.#post(agentId, threadId, params.turnId, messageId, text, files);
    return openBotToolResult({
      status: "shown",
      messageId,
      attachments: attachments.map((attachment) => attachment.name),
      note: "The owner sees the preview card now. Do not describe what it shows; add only what they must decide or do.",
    });
  });

  /** The images of the files, or the sentence for the agent when one cannot be shown. */
  readonly #readFiles = Effect.fn("OwnerTools.readFiles")(function* (
    this: OwnerTools,
    agentId: string,
    paths: readonly string[],
    caption: string,
  ) {
    const opened = yield* Effect.result(
      this.#options.attachments.openSources(agentId, [...paths], { allowAnyReadablePath: false }),
    );
    if (Result.isFailure(opened))
      return "A file could not be read: pass files of your workspace or Shared, by their absolute paths.";
    const sources = opened.success;
    const contents = yield* Effect.promise(async () => {
      try {
        return await Promise.all(
          sources.map(async (source) => {
            const { size } = await source.handle.stat();
            if (size > FILE_LIMIT_BYTES) return null;
            return { path: source.path, bytes: new Uint8Array(await source.handle.readFile()) };
          }),
        );
      } finally {
        await Promise.allSettled(sources.map((source) => source.handle.close()));
      }
    });
    const files: PreviewFile[] = [];
    for (const content of contents) {
      if (!content) return `A file is larger than ${FILE_LIMIT_BYTES / 1024 / 1024} MB.`;
      const extension = extname(content.path).toLowerCase();
      const name = basename(content.path);
      const image = IMAGE_TYPES[extension];
      if (image) {
        files.push({ bytes: content.bytes, name, mimeType: image });
        continue;
      }
      let html: string | null = null;
      if (extension === ".csv" || extension === ".tsv") {
        if (content.bytes.byteLength > CSV_LIMIT_BYTES)
          return "The CSV file is larger than 2 MB: share a smaller extract.";
        const text = new TextDecoder().decode(content.bytes);
        html = csvPreviewHtml(caption, extension === ".tsv" ? text.replaceAll("\t", ",") : text);
        if (!html) return `${name} has no rows to show.`;
      } else if (extension === ".html" || extension === ".htm" || extension === ".svg") {
        html = new TextDecoder().decode(content.bytes);
      } else {
        return `${name} cannot be previewed: share images (png, jpg, webp, gif), a CSV file or an HTML page. Attach other files with attach_files_to_response.`;
      }
      const preview = this.#options.visualPreview;
      if (!preview) return "This Atelier cannot draw pages. Attach the file with attach_files_to_response.";
      const drawn = yield* Effect.result(preview.capture({ html, width: PREVIEW_WIDTH, appearance: "light" }));
      const bytes = Result.isSuccess(drawn) ? dataUrlBytes(drawn.success.imageUrl) : null;
      if (!bytes) return `${name} could not be drawn. Attach it with attach_files_to_response.`;
      files.push({ bytes, name: `${name.replace(/\.[^.]+$/u, "")}.png`, mimeType: "image/png" });
    }
    return files;
  });

  /** One message with the images and the caption. The files and the message are saved together. */
  readonly #post = Effect.fn("OwnerTools.post")(function* (
    this: OwnerTools,
    agentId: string,
    threadId: string,
    turnId: string,
    messageId: string,
    text: string,
    files: readonly PreviewFile[],
  ) {
    const { mailbox, conversation } = this.#options;
    const attachments: AttachmentSummary[] = [];
    for (const file of files) {
      const staged = yield* Effect.result(
        mailbox.stageGeneratedBytes({ ...file, ownerAgentId: agentId, ownerThreadId: threadId }),
      );
      if (Result.isFailure(staged)) {
        yield* mailbox
          .discardStagedGeneratedAttachments(attachments.map((attachment) => attachment.id))
          .pipe(toToolOperationFailed);
        return yield* Effect.fail(staged.failure).pipe(toToolOperationFailed);
      }
      attachments.push(staged.success);
    }
    const snapshot = conversation.ensureSnapshot(agentId, threadId);
    snapshot.messages.push({
      id: messageId,
      turnId,
      author: "assistant",
      source: "assistant",
      text,
      createdAt: new Date().toISOString(),
      status: "completed",
      itemType: SHARE_PREVIEW_ITEM_TYPE,
      attachments,
    });
    sortConversationMessages(snapshot.messages);
    try {
      const persisted = mailbox.persistGeneratedAttachmentsWithConversation(
        snapshot,
        "response.preview-added",
        { turnId, messageId, attachmentCount: attachments.length },
        attachments.map((attachment) => attachment.id),
      );
      snapshot.revision = persisted.revision;
    } catch (error) {
      const index = snapshot.messages.findIndex((candidate) => candidate.id === messageId);
      if (index >= 0) snapshot.messages.splice(index, 1);
      yield* mailbox
        .discardStagedGeneratedAttachments(attachments.map((attachment) => attachment.id))
        .pipe(toToolOperationFailed);
      throw error;
    }
    conversation.publishConversation(snapshot);
    return attachments;
  });
}
