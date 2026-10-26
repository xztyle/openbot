import type {
  AgentEvent,
  AskSideQuestionInput,
  AttachmentImportEvent,
  AttachmentSummary,
  TeamRealtimeEvent,
} from "@openbot/contracts/ipc";
import { decodeSideQuestionResponse, SIDE_QUESTION_ROUTES } from "@openbot/contracts/team-protocol/side-question-v1";
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
  readAgentSessionSettings,
  resetAgentSessionSetting,
  setAgentSessionSetting,
  setAgentSkillEnabled,
  uninstallAgentSkill,
  unpublishAgentTemplate,
} from "@openbot/team-client/team-admin-requests";
import { listInstalledSkills, type TeamApiRequest, teamAgentRoutinesApi } from "@openbot/team-client/team-api-requests";
import { currentText } from "@openbot/ui/text";
import { Effect } from "effect";
import { createSignal, onCleanup } from "solid-js";
import type { ConversationRuntime } from "../conversation/conversation-runtime";
import { webEventRoutinesApi } from "../conversation/routine-webhooks-api";
import { webMemoriesPort } from "../conversation/web-memories-port";
import { webRoutinesPort } from "../conversation/web-routines-port";
import { createWebAttachmentMedia } from "./web-attachment-media";
import { createWebAttachmentFiles, openWebLink } from "./web-attachments";
import { webBrowserProfileCalls } from "./web-browser-profiles";
import { webMessageLinks } from "./web-message-link-relay";
import type { WebWorkspaceRuntime } from "./web-runtime";
import { isHostFileTypeError, planUploads, type UploadRejection, uploadRejectionNotice } from "./web-upload-plan";

/** The events of the connected host. */
type HostEvents = (listener: (event: AgentEvent | TeamRealtimeEvent) => void) => () => void;

/** Skills, shared tables and agent share links on the connected host. The host answers only an owner or admin. */
function webHostAdmin(
  request: () => TeamApiRequest,
  onHostEvent?: HostEvents,
  eventsEnabled?: () => boolean,
  sessionSettingsEnabled?: () => boolean,
  routineRecoveryEnabled?: () => boolean,
  webhookTestsEnabled?: () => boolean,
  checksEnabled?: () => boolean,
  apiChecksEnabled?: () => boolean,
  deliveryChecksEnabled?: () => boolean,
): NonNullable<ConversationRuntime["admin"]> {
  // `request()` names the connected host at call time, so a host switch reaches the new host.
  const checks = eventChecksApi((...args) => request()(...args), apiChecksEnabled, deliveryChecksEnabled);
  const templates = eventCheckTemplatesApi((...args) => request()(...args));
  const eventRoutines = webEventRoutinesApi(
    (...args) => request()(...args),
    () => routineRecoveryEnabled?.() === true,
    () => webhookTestsEnabled?.() === true,
  );
  return {
    get sessionSettings() {
      if (sessionSettingsEnabled?.() !== true) return undefined;
      return {
        read: (agentId: string) =>
          runTeamEffect(readAgentSessionSettings(request(), agentId).pipe(Effect.mapError((error) => error.cause))),
        set: (input: import("@openbot/contracts/ipc").SetAgentSessionSettingInput) =>
          runTeamEffect(setAgentSessionSetting(request(), input).pipe(Effect.mapError((error) => error.cause))),
        reset: (input: import("@openbot/contracts/ipc").ResetAgentSessionSettingInput) =>
          runTeamEffect(resetAgentSessionSetting(request(), input).pipe(Effect.mapError((error) => error.cause))),
        ...(onHostEvent
          ? {
              subscribe: (agentId: string, listener: () => void) =>
                onHostEvent((event) => {
                  if (event.type === "agent-session-settings-changed" && event.agentId === agentId) listener();
                }),
            }
          : {}),
      };
    },
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
  sessionSettingsEnabled?: () => boolean,
  signInRelayEnabled?: () => boolean,
  routineRecoveryEnabled?: () => boolean,
  sideQuestionEnabled?: () => boolean,
  webhookTestsEnabled?: () => boolean,
  browserProfilesEnabled?: () => boolean,
  checksEnabled?: () => boolean,
  apiChecksEnabled?: () => boolean,
  deliveryChecksEnabled?: () => boolean,
): ConversationRuntime {
  const listeners = new Set<(event: AttachmentImportEvent) => void>();
  const files = createWebAttachmentFiles(remote, hostId);
  let importing: { cancelled: boolean; serverId: string } | undefined;
  const [importProgress, setImportProgress] = createSignal<{ current: number; total: number } | null>(null);
  // A new upload cancels the one in flight (`uploadGeneration` in web-runtime.ts), so imports run one at a time.
  let uploads: Promise<void> = Promise.resolve();
  function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
    const result = uploads.then(run);
    uploads = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function cancelImportFiles() {
    if (!importing) return;
    importing.cancelled = true;
    try {
      await remote.cancelUpload();
    } catch {
      // The in-flight upload reports transport errors through its import event.
    }
  }
  // One file at a time, so a stop or host change takes effect before the next upload. On a stop,
  // a host change or a failure, the files already uploaded are discarded if the host is the same.
  // With `rejected`, a file type that the host refuses is named there and the rest go on.
  async function uploadFiles(
    files: readonly File[],
    serverId: string,
    stopped: () => boolean,
    rejected?: UploadRejection[],
  ): Promise<AttachmentSummary[] | null> {
    const attachments: AttachmentSummary[] = [];
    const text = currentText();
    const discard = async () => {
      if (hostId() === serverId)
        await Promise.allSettled(attachments.map((attachment) => remote.discard(attachment.id)));
    };
    try {
      for (const [index, file] of files.entries()) {
        if (stopped() || hostId() !== serverId) break;
        setImportProgress({ current: index + 1, total: files.length });
        try {
          attachments.push(await remote.upload(file));
        } catch (error) {
          // The host's capabilities decide this one, so it is known only now.
          if (!rejected || !isHostFileTypeError(error, text)) throw error;
          rejected.push({ name: file.name, reason: "host" });
        }
      }
    } catch (error) {
      await discard();
      throw error;
    } finally {
      setImportProgress(null);
    }
    if (!stopped() && hostId() === serverId) return attachments;
    await discard();
    return null;
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
  const attachmentMedia = createWebAttachmentMedia(remote, hostId);
  onCleanup(() => {
    void cancelImportFiles();
    attachmentMedia.dispose();
  });
  // The host's relay routes are admin only, so only an admin relays a sign-in link.
  const messageLinks = adminRequest ? webMessageLinks(adminRequest, () => signInRelayEnabled?.() === true) : {};
  const browserProfiles = adminRequest ? webBrowserProfileCalls(adminRequest) : undefined;
  return {
    agent: {
      ...messageLinks,
      importAttachmentData: (data, serverId) =>
        oneAtATime(async () => {
          if (serverId !== hostId()) throw new Error(currentText().t("webClient.error.hostChanged"));
          const files = data.map((file) => new File([new Uint8Array(file.bytes)], file.name, { type: file.mimeType }));
          // The composer's stop button reaches a paste through `importing`, as it reaches a picked file.
          const job = { cancelled: false, serverId };
          importing = job;
          try {
            // A stop ends the upload in flight with an error. uploadFiles has discarded the files then.
            const attachments = await uploadFiles(files, serverId, () => job.cancelled).catch((error: unknown) => {
              if (job.cancelled) return null;
              throw error;
            });
            if (job.cancelled) return [];
            if (!attachments) throw new Error(currentText().t("webClient.error.hostChanged"));
            return attachments;
          } finally {
            importing = undefined;
          }
        }),
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
      stop: (tabId) => remote.stopBrowserTab(tabId),
      takeControl: (tabId) => remote.takeBrowserControl(tabId),
      releaseControl: (tabId) => remote.releaseBrowserControl(tabId),
      setVisible: async () => {},
    },
    voice: {
      getSettings: unavailable,
      onModelStatus: () => () => {},
      prepareModel: unavailable,
      transcribe: unavailable,
      startStream: unavailable,
      appendStream: unavailable,
      finishStream: unavailable,
      cancelStream: async () => {},
      onStreamTranscript: () => () => {},
    },
    openUrl: openWebLink,
    // Any member can ask, so the request is not limited to an admin.
    get askSideQuestion() {
      if (!adminRequest || sideQuestionEnabled?.() !== true) return undefined;
      // Async, so that a host change rejects the promise and the store shows the error.
      return async (input: AskSideQuestionInput) =>
        adminRequest()("POST", SIDE_QUESTION_ROUTES.ask, decodeSideQuestionResponse, {
          agentId: input.agentId,
          question: input.question,
          earlier: input.earlier.map(({ question, answer }) => ({ question, answer })),
        });
    },
    // Any member reads the tab labels; the panels offer the other calls to an owner or admin only.
    get browserProfiles() {
      return browserProfilesEnabled?.() === true ? browserProfiles : undefined;
    },
    previewAttachment: files.preview,
    attachmentMedia,
    visualPage: files.visualPage,
    importProgress,
    async importFiles(files, options) {
      if (files.length === 0) return;
      const text = currentText();
      // A second pick during an upload would race the first for the draft's room. Say so, and keep both.
      if (importing) {
        notify(hostId(), text.t("webClient.upload.busy"));
        return;
      }
      // A paste waits for the upload in flight; a pick does not start while another one runs.
      await oneAtATime(async () => {
        const serverId = hostId();
        const job = { cancelled: false, serverId };
        importing = job;
        const requestId = crypto.randomUUID();
        emit({ type: "started", serverId, requestId });
        try {
          // Every file is checked before the first one goes up, so a refused file never costs an upload
          // and never takes the valid files down with it.
          const plan = planUploads(files, options?.room);
          const rejected: UploadRejection[] = [...plan.rejected];
          const attachments = await uploadFiles(plan.accepted, serverId, () => job.cancelled, rejected);
          if (!attachments) {
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
        }
      });
    },
    cancelImportFiles,
    // `request()` names the connected host at call time, so a host switch reaches the new host.
    routines: adminRequest
      ? {
          ...teamAgentRoutinesApi((...args) => adminRequest()(...args)),
          onEvent: (listener) =>
            onHostEvent?.((event) => {
              if (event.type === "routines-changed") listener(event);
            }) ?? (() => {}),
        }
      : undefined,
    admin: adminRequest
      ? webHostAdmin(
          adminRequest,
          onHostEvent,
          eventsEnabled,
          sessionSettingsEnabled,
          routineRecoveryEnabled,
          webhookTestsEnabled,
          checksEnabled,
          apiChecksEnabled,
          deliveryChecksEnabled,
        )
      : undefined,
  };
}
