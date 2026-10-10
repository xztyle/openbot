import type { EventCheckTemplateApi } from "@openbot/contracts/event-check-templates";
import type { EventCheckApi } from "@openbot/contracts/event-checks";
import type { AttachmentSummary, FilePreview, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import type { AgentSkillCalls } from "../../skills-port";
import type { AgentTemplatePublishCalls } from "../agent-templates/agent-templates-port";
import type { SharedTableCalls } from "./conversation-port";
import type { ConversationProps } from "./conversation-types";
import type { MemoriesPort } from "./memories-port";
import type { EventRoutinesApi } from "./routine-webhooks-api";
import type { RoutinesPort } from "./routines-port";

export interface ConversationRuntime {
  agent: Pick<
    OpenBotDesktopApi["agent"],
    | "discardDraftAttachment"
    | "downloadAttachments"
    | "editQueuedMessage"
    | "listInstalledSkills"
    | "listMcpServers"
    | "listWorkspaceDirectory"
    | "onAttachmentImport"
    | "openAttachment"
    | "openSharedFile"
    | "openWorkspaceFile"
    | "previewSharedFile"
    | "previewWorkspaceFile"
    | "respondToBrowserSecret"
    | "setMessageReaction"
  >;
  browser: Pick<
    OpenBotDesktopApi["browser"],
    | "capturePreview"
    | "closePictureInPicture"
    | "navigate"
    | "onPictureInPictureEvent"
    | "open"
    | "openPictureInPicture"
    | "reload"
    | "setVisible"
  >;
  voice: Pick<OpenBotDesktopApi["voice"], "onModelStatus" | "prepareModel" | "transcribe">;
  openUrl: OpenBotDesktopApi["openUrl"];
  previewAttachment?: (attachment: AttachmentSummary) => Promise<FilePreview>;
  /**
   * `room` is how many more files the draft takes. A file past it is named and not uploaded.
   */
  importFiles?: (files: File[], options?: { room?: number }) => Promise<void>;
  cancelImportFiles?: () => Promise<void>;
  /** The file that goes up now and how many go up in all. Null while no upload runs. */
  importProgress?: () => { current: number; total: number } | null;
  /** The host admin calls of a client without the desktop port. Absent, skills, tables and publishing are hidden. */
  admin?:
    | {
        skills: AgentSkillCalls;
        sharedTables: SharedTableCalls;
        agentTemplates: AgentTemplatePublishCalls;
        eventRoutines?: EventRoutinesApi | undefined;
        routines?: ((agentId: string) => RoutinesPort) | undefined;
        /** The agent's memories on the host. Absent, a remote client shows no Memories row. */
        memories?: ((agentId: string, agentName: string) => MemoriesPort) | undefined;
        eventChecks?: EventCheckApi | undefined;
        /** The templates of the host, so an event check editor can show a picker setting as a list. */
        eventCheckTemplates?: Pick<EventCheckTemplateApi, "list" | "discoverCheck"> | undefined;
      }
    | undefined;
}

export function conversationRuntime(props: ConversationProps): ConversationRuntime {
  return props.runtime ?? window.openbot;
}
