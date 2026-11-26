/*
 * The messages of `scripts/owner-file-links-e2e.ts`: an agent's answer to the owner that the host gave
 * its named files, and a message whose text names files and folders that it does not carry. Each one
 * draws through the chat's renderer and opens its files in the workspace's file viewer
 * (`createFileViewer`). The port reaches the real agent service of the script: `openFileReference`
 * runs there as the reader that `?reader=` names, with that reader's agents and spaces.
 */
import { attachmentMimeTypeForName } from "@openbot/contracts/attachment-files";
import {
  type AttachmentSummary,
  decodeFileReferenceTarget,
  type FilePreview,
  filePreviewKindForFile,
} from "@openbot/contracts/ipc";
import { Bubble, BubbleContent, Toaster } from "@openbot/ui";
import type { AgentMessage } from "@openbot/ui/data";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { render } from "@solidjs/web";
import { createSignal, For } from "solid-js";
import { createFileViewer, type FileViewerPort } from "../src/features/workspace/workspace-file-viewer";
import { StaticI18nProvider } from "../src/i18n-context";
import { STORY_AGENTS } from "./fixtures";
import "../src/styles.css";

interface HarnessMessage {
  id: string;
  agentId: string;
  text: string;
  attachments: AttachmentSummary[];
}

declare global {
  interface Window {
    /** What the page downloaded and asked the host, for the script. */
    ownerFileLinks?: { downloads: string[]; references: string[] };
  }
}

const reader = new URLSearchParams(location.search).get("reader") === "member" ? "member" : "owner";
const record: { downloads: string[]; references: string[] } = { downloads: [], references: [] };
window.ownerFileLinks = record;

const unavailable = async (): Promise<never> => {
  throw new Error("Not in this check.");
};

/** The host as the browser client reaches it, over the script's own routes to the real service. */
const port: FileViewerPort = {
  fileActions: "browser",
  openUrl: unavailable,
  agent: {
    openAttachment: async ({ attachmentId }) => {
      record.downloads.push(attachmentId);
    },
    openFileReference: async (input) => {
      record.references.push(input.path);
      const response = await fetch(`/__owner-files/reference?reader=${reader}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        const failure = await response.json();
        throw new Error(typeof failure?.error === "string" ? failure.error : "Failed");
      }
      return decodeFileReferenceTarget(await response.json());
    },
  },
  previewAttachment: async (attachment): Promise<FilePreview> => {
    const response = await fetch(`/__owner-files/attachment/${encodeURIComponent(attachment.id)}`);
    if (!response.ok) throw new Error("The file is not on the host.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType = attachment.mimeType || attachmentMimeTypeForName(attachment.name);
    return {
      name: attachment.name,
      size: bytes.byteLength,
      mimeType,
      previewKind: filePreviewKindForFile(attachment.name, mimeType),
      bytes,
    };
  },
};

function Message(props: { message: HarnessMessage }) {
  const viewer = createFileViewer({
    port: () => port,
    agents: () => STORY_AGENTS,
    openLink: () => undefined,
    context: () => ({ files: props.message.attachments, sender: "Copy" }),
  });
  const body = (): AgentMessage => ({
    id: props.message.id,
    author: "agent",
    body: props.message.text,
    time: "10:00",
    attachments: props.message.attachments,
  });
  const open = (path: string) =>
    viewer.viewNamed(path, { attachments: props.message.attachments, agentId: props.message.agentId });
  return (
    <div class="message-entry message-entry-agent" data-message={props.message.id}>
      <Bubble align="start" variant="muted" data-author="assistant">
        <BubbleContent>
          <MessageBody
            message={body()}
            agents={STORY_AGENTS}
            onSelectAgent={() => undefined}
            onOpenLink={() => undefined}
            onPreview={viewer.view}
            onOpenSharedFile={open}
            onOpenWorkspaceFile={open}
            onAttachmentAction={(attachment, action) =>
              action === "download" ? viewer.download(attachment) : viewer.view(attachment)
            }
            onDownload={viewer.download}
          />
        </BubbleContent>
      </Bubble>
      <viewer.Viewer />
    </div>
  );
}

function Harness() {
  const [messages, setMessages] = createSignal<HarnessMessage[]>([]);
  void fetch("/__owner-files/messages")
    .then((response) => response.json())
    .then((list: HarnessMessage[]) => setMessages(list));
  return (
    <StaticI18nProvider locale="es">
      <main style={{ padding: "16px", "max-width": "760px" }}>
        <For each={messages()}>{(message) => <Message message={message} />}</For>
      </main>
      <Toaster />
    </StaticI18nProvider>
  );
}

const root = document.getElementById("root");
if (root) render(() => <Harness />, root);
