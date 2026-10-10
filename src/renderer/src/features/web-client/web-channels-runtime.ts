import type { AgentEvent, AttachmentSummary, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import { createSignal } from "solid-js";
import { type ChannelsPort, PartialAttachmentImportError } from "../channels/channels-port";
import { webEventRoutinesApi } from "../conversation/routine-webhooks-api";
import { createWebAttachmentFiles, openWebLink } from "./web-attachments";
import type { WebWorkspaceRuntime } from "./web-runtime";
import { isHostFileTypeError, planUploads, type UploadRejection, uploadRejectionNotice } from "./web-upload-plan";

const unavailable = async (): Promise<never> => {
  throw new Error(currentText().t("webClient.error.desktopOnly"));
};

/** The browser's file chooser. A dismissed chooser answers with no files. */
export function chooseFiles(options: { multiple?: boolean; accept?: string } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple ?? true;
    if (options.accept) input.accept = options.accept;
    input.addEventListener("change", () => resolve(Array.from(input.files ?? [])), { once: true });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    // The chooser needs the click that started this call, so nothing may be awaited before it.
    input.click();
  });
}

/**
 * The channels runtime of the browser client: the same channel UI as the desktop, sent over the host
 * connection instead of preload. Files are chosen with the browser's chooser, dropped, or pasted, and
 * uploaded as drafts.
 */
export function createWebChannelsPort(
  remote: WebWorkspaceRuntime,
  onHostEvent: (listener: (event: AgentEvent | TeamRealtimeEvent) => void) => () => void,
  hostId: () => string,
  eventsEnabled: () => boolean,
): ChannelsPort {
  const files = createWebAttachmentFiles(remote);
  const channels = remote.channels;
  const admin = remote.admin;
  const eventRoutines = admin ? webEventRoutinesApi(admin.request) : undefined;
  const [importProgress, setImportProgress] = createSignal<{ current: number; total: number } | null>(null);
  let uploading = false;
  async function importAttachments(chosen: File[], room?: number): Promise<AttachmentSummary[]> {
    const text = currentText();
    // The upload that starts last cancels the one before it, so a second pick waits and says so.
    if (uploading) throw new Error(text.t("webClient.upload.busy"));
    // Every file is checked before the first one goes up. A refused file is named, and the rest attach.
    const plan = planUploads(chosen, room);
    const rejected: UploadRejection[] = [...plan.rejected];
    const serverId = hostId();
    const uploaded: AttachmentSummary[] = [];
    uploading = true;
    try {
      for (const [index, file] of plan.accepted.entries()) {
        setImportProgress({ current: index + 1, total: plan.accepted.length });
        try {
          uploaded.push(await remote.upload(file));
        } catch (error) {
          if (!isHostFileTypeError(error, text)) throw error;
          rejected.push({ name: file.name, reason: "host" });
        }
      }
    } catch (error) {
      // After a host switch the drafts belong to the previous host, and the runtime discards them there.
      if (hostId() === serverId) await Promise.allSettled(uploaded.map((attachment) => remote.discard(attachment.id)));
      throw error;
    } finally {
      uploading = false;
      setImportProgress(null);
    }
    if (rejected.length > 0) throw new PartialAttachmentImportError(uploadRejectionNotice(rejected, text), uploaded);
    return uploaded;
  }
  return {
    agent: {
      listChannels: channels?.listChannels ?? unavailable,
      readChannel: channels?.readChannel ?? unavailable,
      channelCommand: channels?.channelCommand ?? unavailable,
      listChannelMemories: channels?.listChannelMemories ?? unavailable,
      createChannelMemory: channels?.createChannelMemory ?? unavailable,
      updateChannelMemory: channels?.updateChannelMemory ?? unavailable,
      deleteChannelMemory: channels?.deleteChannelMemory ?? unavailable,
      clearChannelMemories: channels?.clearChannelMemories ?? unavailable,
      listChannelRoutines: channels?.listChannelRoutines ?? unavailable,
      listChannelRoutineRuns: channels?.listChannelRoutineRuns ?? unavailable,
      createChannelRoutine: channels?.createChannelRoutine ?? unavailable,
      updateChannelRoutine: channels?.updateChannelRoutine ?? unavailable,
      deleteChannelRoutine: channels?.deleteChannelRoutine ?? unavailable,
      testChannelRoutine: channels?.testChannelRoutine ?? unavailable,
      onEvent: (listener) =>
        onHostEvent((event) => {
          if (event.type === "channel-memories-changed" || event.type === "channel-routines-changed") listener(event);
        }),
      chooseAttachments: async () => importAttachments(await chooseFiles()),
      openAttachment: ({ attachmentId }) => files.download(attachmentId),
      discardDraftAttachment: (id) => remote.discard(id),
      respondToApproval: (input) => remote.approve(input),
      respondToPrompt: (input) => remote.answer(input),
      respondToBrowserTakeover: (input) => remote.respondToTakeover(input),
      respondToBrowserSecret: (input) => remote.respondToBrowserSecret?.(input) ?? unavailable(),
    },
    get eventRoutines() {
      return eventsEnabled() ? eventRoutines : undefined;
    },
    browser: { capturePreview: remote.browserPreview ?? unavailable },
    openUrl: openWebLink,
    fileActions: "browser",
    previewAttachment: files.preview,
    importAttachments,
    importProgress,
  };
}
