import type { AttachmentSummary, FilePreview, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import type { ChannelMemoriesApi } from "../conversation/memories-port";
import type { EventRoutinesApi } from "../conversation/routine-webhooks-api";
import type { ChannelRoutinesApi } from "../conversation/routines-port";

/**
 * What the channels domain reaches on its host: channel pages, commands, memories, routines,
 * attachments, and the answers a channel turn waits for. The desktop reaches it through preload; the
 * browser client supplies its own runtime over the host connection, the way `ConversationRuntime`
 * does.
 */
export interface ChannelsPort {
  agent: Pick<
    OpenBotDesktopApi["agent"],
    | "channelCommand"
    | "chooseAttachments"
    | "listChannels"
    | "openAttachment"
    | "readChannel"
    | "respondToApproval"
    | "respondToBrowserSecret"
    | "respondToBrowserTakeover"
    | "respondToPrompt"
  > &
    ChannelMemoriesApi &
    ChannelRoutinesApi &
    Partial<Pick<OpenBotDesktopApi["agent"], "discardDraftAttachment" | "downloadAttachments">>;
  eventRoutines?: EventRoutinesApi | undefined;
  browser: Pick<OpenBotDesktopApi["browser"], "capturePreview">;
  openUrl: OpenBotDesktopApi["openUrl"];
  /** `browser` has no file manager to reveal a file in, so that action is hidden. */
  fileActions: "native" | "browser";
  /** Replaces the preview read from `previewUrl`, which a browser client never receives. */
  previewAttachment?: (attachment: AttachmentSummary) => Promise<FilePreview>;
  /**
   * Uploads dropped or pasted files as drafts. Only a browser client has it; the desktop preload imports
   * them. `room` is how many more files the draft takes. A file the client refuses ends in a
   * `PartialAttachmentImportError`, which carries the files that did go up.
   */
  importAttachments?: (files: File[], room?: number) => Promise<AttachmentSummary[]>;
  /** The file that goes up now and how many go up in all. Null while no upload runs. */
  importProgress?: () => { current: number; total: number } | null;
}

/**
 * An import that attached some files and refused others. The message names the refused files and why;
 * the caller keeps `attachments` and shows the message, so one bad file does not take the rest down.
 */
export class PartialAttachmentImportError extends Error {
  readonly attachments: AttachmentSummary[];

  constructor(message: string, attachments: AttachmentSummary[]) {
    super(message);
    this.name = "PartialAttachmentImportError";
    this.attachments = attachments;
  }
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function channelsPort(): ChannelsPort {
  const api = window.openbot;
  return {
    agent: api.agent,
    browser: api.browser,
    openUrl: (url) => api.openUrl(url),
    fileActions: "native",
  };
}
