import type { EventCheckTemplateApi } from "@openbot/contracts/event-check-templates";
import type { EventCheckApi } from "@openbot/contracts/event-checks";
import type {
  AgentSessionSettings,
  AskSideQuestionInput,
  AttachmentSummary,
  FilePreview,
  OpenBotDesktopApi,
  ResetAgentSessionSettingInput,
  SetAgentSessionSettingInput,
} from "@openbot/contracts/ipc";
import type { AttachmentMediaSource } from "@openbot/ui/features/conversation/AttachmentCards";
import type { AgentSkillCalls } from "../../skills-port";
import type { AgentTemplatePublishCalls } from "../agent-templates/agent-templates-port";
import type { BrowserProfileCalls } from "../browser/browser-profiles-port";
import type { SharedTableCalls } from "./conversation-port";
import type { ConversationProps } from "./conversation-types";
import type { MemoriesPort } from "./memories-port";
import type { EventRoutinesApi } from "./routine-webhooks-api";
import type { AgentRoutinesApi, RoutinesPort } from "./routines-port";

export interface ConversationRuntime {
  agent: Pick<
    OpenBotDesktopApi["agent"],
    | "discardDraftAttachment"
    | "importAttachmentData"
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
  > &
    // A joined server's sign-in link that the host relays. Absent, a link opens with `openUrl`.
    Partial<Pick<OpenBotDesktopApi["agent"], "openMessageLink" | "pasteMessageLink" | "cancelMessageLink">>;
  browser: Pick<
    OpenBotDesktopApi["browser"],
    | "capturePreview"
    | "closePictureInPicture"
    | "navigate"
    | "onPictureInPictureEvent"
    | "open"
    | "openPictureInPicture"
    | "reload"
    | "stop"
    | "releaseControl"
    | "setVisible"
    | "takeControl"
  >;
  voice: Pick<
    OpenBotDesktopApi["voice"],
    | "getSettings"
    | "onModelStatus"
    | "prepareModel"
    | "transcribe"
    | "startStream"
    | "appendStream"
    | "finishStream"
    | "cancelStream"
    | "onStreamTranscript"
  >;
  openUrl: OpenBotDesktopApi["openUrl"];
  /** Asks the connected host a side question. Absent, the host does not serve `side-question-v1`. */
  askSideQuestion?: ((input: AskSideQuestionInput) => Promise<string>) | undefined;
  previewAttachment?: (attachment: AttachmentSummary) => Promise<FilePreview>;
  /** Loads attachment images and media for a client that gets no `previewUrl`. */
  attachmentMedia?: AttachmentMediaSource;
  /**
   * The HTML of a visual reply page, for a client that has no page URL. Only the browser client
   * has it: the frame shows the page as `srcdoc`, which the desktop renderer policy would block.
   */
  visualPage?: (attachment: AttachmentSummary) => Promise<string>;
  /**
   * `room` is how many more files the draft takes. A file past it is named and not uploaded.
   */
  importFiles?: (files: File[], options?: { room?: number }) => Promise<void>;
  cancelImportFiles?: () => Promise<void>;
  /** The file that goes up now and how many go up in all. Null while no upload runs. */
  importProgress?: () => { current: number; total: number } | null;
  /**
   * The browser profile calls of a host that serves `browser-profiles-v1`, for a client without the
   * desktop port. Any member reads tab labels; only an owner or admin gets the other calls.
   */
  browserProfiles?: BrowserProfileCalls | undefined;
  /** The agent routine calls of a client without the desktop port. */
  routines?: AgentRoutinesApi | undefined;
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
        sessionSettings?:
          | {
              read(agentId: string): Promise<AgentSessionSettings>;
              set(input: SetAgentSessionSettingInput): Promise<AgentSessionSettings>;
              reset(input: ResetAgentSessionSettingInput): Promise<AgentSessionSettings>;
              subscribe?(agentId: string, listener: () => void): () => void;
            }
          | undefined;
      }
    | undefined;
}

export function conversationRuntime(props: Pick<ConversationProps, "runtime">): ConversationRuntime {
  return props.runtime ?? window.openbot;
}
