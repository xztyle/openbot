/*
 * The web client on a mock host whose chat with Research takes pasted images, for
 * `scripts/web-image-paste-e2e.ts`. An upload keeps its bytes, `download` serves them back and
 * `attachmentPreview` makes a small copy of a PNG, as a host does. A sent message keeps its files.
 * The chat starts with an older message of the owner whose text holds a file marker
 * (`@[viejo.png](attachment:legacy-image)`), as a paste wrote it before. `window.harnessImagePaste`
 * lists what the page sent to the host and which files it read.
 */
import type { AttachmentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { WEB_TOAST_OFFSET } from "../src/features/web-client/web-visual-viewport";
import { StaticI18nProvider } from "../src/i18n-context";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { seeds } from "./workspace/workspace-app-seeds";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

const AGENT = "research";
const THREAD = "thread-research";
/** A 1 × 1 orange PNG. */
const ORANGE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4+5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const LEGACY_IMAGE: AttachmentSummary = {
  id: "legacy-image",
  name: "viejo.png",
  size: 70,
  kind: "image",
  mimeType: "image/png",
  previewKind: "image",
  previewUrl: null,
};

declare global {
  interface Window {
    harnessImagePaste?: {
      sent: { text: string; attachmentIds: string[] }[];
      reads: { id: string; variant: "full" | "inline"; bytes: number }[];
    };
  }
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** A copy of the image whose longest side is 320 px, as a PNG: the host's `AttachmentPreviews`. */
async function smallCopy(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return base64Of(new Uint8Array(await blob.arrayBuffer()));
}

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const legacy: ConversationMessage = {
    id: "legacy-1",
    turnId: "turn-legacy",
    author: "user",
    source: "user",
    text: `quitale eso @[${LEGACY_IMAGE.name}](attachment:${LEGACY_IMAGE.id}) de la foto`,
    createdAt: "2026-11-25T10:00:00.000Z",
    status: "completed",
    senderMember: { id: WEB_PREVIEW_MEMBER_ID, name: "Preview User" },
    attachments: [LEGACY_IMAGE],
  };
  const mock = createMockOpenBot({
    channels: seeds(WEB_PREVIEW_MEMBER_ID),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    snapshots: {
      [AGENT]: { agentId: AGENT, threadId: THREAD, activeTurnId: null, revision: 1, messages: [legacy] },
    },
  });
  const files = new Map<string, { file: File; summary: AttachmentSummary }>();
  const log: NonNullable<Window["harnessImagePaste"]> = { sent: [], reads: [] };
  window.harnessImagePaste = log;
  const sendMessage = mock.api.agent.sendMessage.bind(mock.api.agent);
  mock.api.agent.sendMessage = async (input) => {
    const attachmentIds = input.attachmentDraftIds ?? [];
    log.sent.push({ text: input.text, attachmentIds });
    const receipt = await sendMessage(input);
    const deliveryId = receipt.deliveries[0]?.id;
    const attachments = attachmentIds.flatMap((id) => {
      const stored = files.get(id);
      return stored ? [stored.summary] : [];
    });
    // The host keeps the files on the message, as `attachmentDraftIds` asks.
    mock.updateConversationSnapshot(AGENT, (snapshot) => {
      const sent = snapshot.messages.find((message) => message.id === deliveryId);
      if (sent) sent.attachments = attachments;
    });
    return receipt;
  };
  const base = mockWebRuntimeFor(mock, events);
  return {
    ...base,
    upload: async (file: File) => {
      const summary: AttachmentSummary = {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        kind: file.type.startsWith("image/") ? "image" : "file",
        mimeType: file.type || "application/octet-stream",
        previewKind: file.type.startsWith("image/") ? "image" : "none",
        previewUrl: null,
      };
      files.set(summary.id, { file, summary });
      return summary;
    },
    discard: async (id: string) => {
      files.delete(id);
    },
    download: async (id: string) => {
      const stored = files.get(id);
      if (!stored) {
        log.reads.push({ id, variant: "full", bytes: 70 });
        return { name: LEGACY_IMAGE.name, mimeType: "image/png", base64: ORANGE_PNG };
      }
      log.reads.push({ id, variant: "full", bytes: stored.file.size });
      const bytes = new Uint8Array(await stored.file.arrayBuffer());
      return { name: stored.file.name, mimeType: stored.file.type, base64: base64Of(bytes) };
    },
    attachmentPreview: async (id: string) => {
      const stored = files.get(id);
      // A small file goes as it is, as on the host.
      if (!stored || stored.file.size < 256 * 1024) return null;
      const base64 = await smallCopy(stored.file);
      log.reads.push({ id, variant: "inline", bytes: Math.round((base64.length * 3) / 4) });
      return { name: stored.file.name, mimeType: "image/png", base64 };
    },
  };
};

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <div class="web-app">
          <Toaster offset={WEB_TOAST_OFFSET} />
          <WebWorkspace
            accountId="preview-account"
            accountEmail="you@example.com"
            accountName="Preview User"
            accountFetch={fetch}
            onSessionCheck={async () => {}}
            onLogout={async () => {}}
            createRuntime={runtime}
            language="system"
            onChangeLanguage={() => {}}
            appearance="light"
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
