import type { AgentEvent, AttachmentImportEvent, AttachmentSummary, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { runTeamEffect } from "@openbot/team-client";
import { eventCheckTemplatesApi } from "@openbot/team-client/event-check-templates-api";
import { eventChecksApi } from "@openbot/team-client/event-checks-api";
import {
  deleteSharedTable,
  installAgentSkill,
  listAgentSkills,
  listMcpServers,
  listSharedTables,
  previewAgentTemplate,
  publishAgentTemplate,
  setAgentSkillEnabled,
  uninstallAgentSkill,
  unpublishAgentTemplate,
} from "@openbot/team-client/team-admin-requests";
import { listInstalledSkills, type TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { currentText } from "@openbot/ui/text";
import { Effect } from "effect";
import { createSignal, onCleanup } from "solid-js";
import type { ConversationRuntime } from "../conversation/conversation-runtime";
import { webEventRoutinesApi } from "../conversation/routine-webhooks-api";
import { webMemoriesPort } from "../conversation/web-memories-port";
import { webRoutinesPort } from "../conversation/web-routines-port";
import { createWebAttachmentFiles, openWebLink } from "./web-attachments";
import type { WebWorkspaceRuntime } from "./web-runtime";
import { isHostFileTypeError, planUploads, type UploadRejection, uploadRejectionNotice } from "./web-upload-plan";

/** The events of the connected host. */
type HostEvents = (listener: (event: AgentEvent | TeamRealtimeEvent) => void) => () => void;

/** Skills, shared tables and agent share links on the connected host. The host answers only an owner or admin. */
function webHostAdmin(
  request: () => TeamApiRequest,
  onHostEvent?: HostEvents,
  eventsEnabled?: () => boolean,
  checksEnabled?: () => boolean,
  apiChecksEnabled?: () => boolean,
  deliveryChecksEnabled?: () => boolean,
): NonNullable<ConversationRuntime["admin"]> {
  // `request()` names the connected host at call time, so a host switch reaches the new host.
  const checks = eventChecksApi((...args) => request()(...args), apiChecksEnabled, deliveryChecksEnabled);
  const templates = eventCheckTemplatesApi((...args) => request()(...args));
  const eventRoutines = webEventRoutinesApi((...args) => request()(...args));
  return {
    skills: {
      listInstalled: (agentId) =>
        runTeamEffect(listAgentSkills(request(), agentId).pipe(Effect.mapError((error) => error.cause))),
      install: (input) =>
        runTeamEffect(installAgentSkill(request(), input).pipe(Effect.mapError((error) => error.cause))),
      uninstall: (input) =>
        runTeamEffect(uninstallAgentSkill(request(), input).pipe(Effect.mapError((error) => error.cause))),
      setEnabled: (input) =>
        runTeamEffect(setAgentSkillEnabled(request(), input).pipe(Effect.mapError((error) => error.cause))),
      ...(onHostEvent
        ? {
            onChanged: (listener: (agentId: string) => void) =>
              onHostEvent((event) => {
                if (event.type === "skills-changed") listener(event.agentId);
              }),
          }
        : {}),
    },
    sharedTables: {
      listTables: () => runTeamEffect(listSharedTables(request()).pipe(Effect.mapError((error) => error.cause))),
      deleteTable: ({ name }) =>
        runTeamEffect(deleteSharedTable(request(), name).pipe(Effect.mapError((error) => error.cause))),
    },
    agentTemplates: {
      preview: (agentId) =>
        runTeamEffect(previewAgentTemplate(request(), agentId).pipe(Effect.mapError((error) => error.cause))),
      publish: (input) =>
        runTeamEffect(publishAgentTemplate(request(), input).pipe(Effect.mapError((error) => error.cause))),
      unpublish: (agentId) =>
        runTeamEffect(unpublishAgentTemplate(request(), agentId).pipe(Effect.mapError((error) => error.cause))),
    },
    memories: (agentId, agentName) => webMemoriesPort(agentId, agentName, (...args) => request()(...args), onHostEvent),
    get eventChecks() {
      return checksEnabled?.() === true ? checks : undefined;
    },
    get eventCheckTemplates() {
      // Same capability as the API checks: a host that has one has the other.
      return checksEnabled?.() === true && apiChecksEnabled?.() === true ? templates : undefined;
    },
    get routines() {
      return eventsEnabled?.() === false
        ? undefined
        : (agentId: string) => webRoutinesPort(agentId, eventRoutines, (...args) => request()(...args), onHostEvent);
    },
    get eventRoutines() {
      return eventsEnabled?.() === false ? undefined : eventRoutines;
    },
  };
}

export function createWebConversationRuntime(
  remote: WebWorkspaceRuntime,
  hostId: () => string,
  adminRequest?: () => TeamApiRequest,
  onHostEvent?: HostEvents,
  eventsEnabled?: () => boolean,
  checksEnabled?: () => boolean,
  apiChecksEnabled?: () => boolean,
  deliveryChecksEnabled?: () => boolean,
): ConversationRuntime {
  const listeners = new Set<(event: AttachmentImportEvent) => void>();
  const files = createWebAttachmentFiles(remote);
  let importing: { cancelled: boolean; serverId: string } | undefined;
  const [importProgress, setImportProgress] = createSignal<{ current: number; total: number } | null>(null);
  async function cancelImportFiles() {
    if (!importing) return;
    importing.cancelled = true;
    try {
      await remote.cancelUpload();
    } catch {
      // The in-flight upload reports transport errors through its import event.
    }
  }
  const unavailable = async (): Promise<never> => {
    throw new Error(currentText().t("webClient.error.desktopOnly"));
  };
  const emit = (event: AttachmentImportEvent) => {
    for (const listener of listeners) listener(event);
  };
  /** Shows a message in the chat that the import events reach, with no upload behind it. */
  const notify = (serverId: string, message: string) => {
    const requestId = crypto.randomUUID();
    emit({ type: "started", serverId, requestId });
    emit({ type: "error", serverId, requestId, message });
  };
  onCleanup(() => {
    void cancelImportFiles();
  });
  return {
    agent: {
      discardDraftAttachment: (id) => remote.discard(id),
      downloadAttachments: unavailable,
      editQueuedMessage: async (input, serverId) => {
        // The edit belongs to the host that queued the message. This client talks only to the connected one.
        if (serverId !== hostId()) throw new Error(currentText().t("webClient.error.hostChanged"));
        return remote.editQueue(input);
      },
      // The skills store asks only a host that serves `installed-skills`, and the MCP store only as an admin.
      listInstalledSkills: async (agentId) =>
        adminRequest
          ? Effect.runPromise(
              listInstalledSkills(adminRequest(), agentId).pipe(Effect.mapError((error) => error.cause)),
            )
          : [],
      listMcpServers: async (serverId) => {
        if (serverId !== hostId()) throw new Error(currentText().t("webClient.error.hostChanged"));
        return adminRequest
          ? runTeamEffect(listMcpServers(adminRequest()).pipe(Effect.mapError((error) => error.cause)))
          : [];
      },
      listWorkspaceDirectory: ({ agentId, path }) => remote.workspaceDirectory(agentId, path),
      onAttachmentImport(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      openAttachment: ({ attachmentId }) => files.download(attachmentId),
      // The browser has no app to open a host file in, so it downloads.
      openSharedFile: ({ path }) => files.saveShared(path),
      openWorkspaceFile: ({ agentId, path }) => files.saveWorkspace(agentId, path),
      previewSharedFile: ({ path }) => files.previewShared(path),
      previewWorkspaceFile: ({ agentId, path }) => files.previewWorkspace(agentId, path),
      respondToBrowserSecret: remote.respondToBrowserSecret
        ? (input) => remote.respondToBrowserSecret?.(input) ?? Promise.resolve()
        : unavailable,
      setMessageReaction: (input) => remote.react(input),
    },
    browser: {
      capturePreview: remote.browserPreview ?? unavailable,
      closePictureInPicture: async () => {},
      navigate: (input) => remote.navigateBrowserTab(input),
      onPictureInPictureEvent: () => () => {},
      open: (input) => remote.openBrowserTab(input),
      openPictureInPicture: unavailable,
      reload: (tabId) => remote.reloadBrowserTab(tabId),
      setVisible: async () => {},
    },
    voice: { onModelStatus: () => () => {}, prepareModel: unavailable, transcribe: unavailable },
    openUrl: openWebLink,
    previewAttachment: files.preview,
    importProgress,
    async importFiles(files, options) {
      if (files.length === 0) return;
      const text = currentText();
      const serverId = hostId();
      // A second pick during an upload would race the first for the draft's room. Say so, and keep both.
      if (importing) {
        notify(serverId, text.t("webClient.upload.busy"));
        return;
      }
      const job = { cancelled: false, serverId };
      importing = job;
      const requestId = crypto.randomUUID();
      emit({ type: "started", serverId, requestId });
      const attachments: AttachmentSummary[] = [];
      try {
        // Every file is checked before the first one goes up, so a refused file never costs an upload
        // and never takes the valid files down with it.
        const plan = planUploads(files, options?.room);
        const rejected: UploadRejection[] = [...plan.rejected];
        for (const [index, file] of plan.accepted.entries()) {
          if (job.cancelled || hostId() !== serverId) break;
          setImportProgress({ current: index + 1, total: plan.accepted.length });
          try {
            attachments.push(await remote.upload(file));
          } catch (error) {
            // The host's capabilities decide this one, so it is known only now. The rest go on.
            if (!isHostFileTypeError(error, text)) throw error;
            rejected.push({ name: file.name, reason: "host" });
          }
        }
        if (job.cancelled || hostId() !== serverId) {
          if (hostId() === serverId)
            await Promise.allSettled(attachments.map((attachment) => remote.discard(attachment.id)));
          emit({ type: "completed", serverId, requestId, attachments: [] });
          return;
        }
        const notice = rejected.length > 0 ? uploadRejectionNotice(rejected, text) : "";
        if (attachments.length === 0 && notice) {
          emit({ type: "error", serverId, requestId, message: notice });
          return;
        }
        emit({ type: "completed", serverId, requestId, attachments });
        if (notice) notify(serverId, notice);
      } catch (error) {
        if (hostId() === serverId)
          await Promise.allSettled(attachments.map((attachment) => remote.discard(attachment.id)));
        if (job.cancelled) {
          emit({ type: "completed", serverId, requestId, attachments: [] });
          return;
        }
        emit({
          type: "error",
          serverId,
          requestId,
          message: error instanceof Error ? error.message : currentText().t("webClient.error.fileTransfer"),
        });
      } finally {
        importing = undefined;
        setImportProgress(null);
      }
    },
    cancelImportFiles,
    admin: adminRequest
      ? webHostAdmin(adminRequest, onHostEvent, eventsEnabled, checksEnabled, apiChecksEnabled, deliveryChecksEnabled)
      : undefined,
  };
}
