/*
 * The web client on a mock host whose #general has images and files (the media seeds) and whose chat
 * with Research holds, as the owner's chat with an agent does: a row of five ad images of the agent,
 * one image of the agent, one image of the owner, and a video, a PDF, a document and a ZIP. For
 * `scripts/web-context-menu-e2e.ts`. The images are drawn on a canvas; the files and their renditions
 * come from `scripts/fixtures/file-previews` through `/__fixtures/`, as the script serves them.
 */
import { attachmentMimeTypeForName } from "@openbot/contracts/attachment-files";
import type { AttachmentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import type { AttachmentRenditionKind } from "@openbot/contracts/team-protocol/attachment-renditions-v1";
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
const at = (minute: number) => `2026-11-26T10:${String(minute).padStart(2, "0")}:00.000Z`;

function image(id: string, name: string): AttachmentSummary {
  return { id, name, size: 40_000, kind: "image", mimeType: "image/png", previewKind: "image", previewUrl: null };
}
function file(name: string): AttachmentSummary {
  const mimeType = attachmentMimeTypeForName(name);
  return {
    id: `file-${name}`,
    name,
    size: 20_000,
    kind: "file",
    mimeType,
    previewKind: mimeType === "application/pdf" ? "pdf" : "none",
    previewUrl: null,
  };
}

const GALLERY = [1, 2, 3, 4, 5].map((n) => image(`ad-${n}`, `anuncio-${n}.png`));
const SINGLE = image("agent-single", "portada.png");
const OWNER = image("owner-photo", "foto-local.png");
const FILES = ["clip.mp4", "sample.pdf", "report.docx", "proyecto.zip"].map(file);
const IMAGES = new Map([...GALLERY, SINGLE, OWNER].map((entry, index) => [entry.id, { entry, hue: index * 47 }]));
const FILE_NAMES = new Map(FILES.map((entry) => [entry.id, entry.name]));

const messages: ConversationMessage[] = [
  {
    id: "owner-image",
    turnId: "turn-1",
    author: "user",
    source: "user",
    text: "Esta es la foto del local.",
    createdAt: at(0),
    status: "completed",
    senderMember: { id: WEB_PREVIEW_MEMBER_ID, name: "Preview User" },
    attachments: [OWNER],
  },
  {
    id: "agent-gallery",
    turnId: "turn-1",
    author: "assistant",
    text: "Aquí tienes los cinco anuncios.",
    createdAt: at(1),
    status: "completed",
    itemType: "agentMessage",
    attachments: GALLERY,
  },
  {
    id: "agent-single",
    turnId: "turn-1",
    author: "assistant",
    text: "Y la portada.",
    createdAt: at(2),
    status: "completed",
    itemType: "agentMessage",
    attachments: [SINGLE],
  },
  {
    id: "agent-files",
    turnId: "turn-1",
    author: "assistant",
    text: "Los archivos de la reunión.",
    createdAt: at(3),
    status: "completed",
    itemType: "agentMessage",
    attachments: FILES,
  },
];

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function drawImage(hue: number, caption: string): Promise<string> {
  const canvas = new OffscreenCanvas(640, 800);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No canvas.");
  context.fillStyle = `hsl(${hue} 70% 55%)`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#fff";
  context.font = "600 48px sans-serif";
  context.fillText(caption, 48, 720);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return base64Of(new Uint8Array(await blob.arrayBuffer()));
}

const fixture = (name: string) => `/__fixtures/file-previews/${name.split("/").map(encodeURIComponent).join("/")}`;
async function fixtureBase64(name: string): Promise<string | null> {
  const response = await fetch(fixture(name));
  return response.ok ? base64Of(new Uint8Array(await response.arrayBuffer())) : null;
}

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    channels: seeds(WEB_PREVIEW_MEMBER_ID, { media: true }),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    snapshots: { [AGENT]: { agentId: AGENT, threadId: THREAD, activeTurnId: null, revision: 1, messages } },
  });
  const base = mockWebRuntimeFor(mock, events);
  const read = async (id: string) => {
    const shown = IMAGES.get(id);
    if (shown)
      return { name: shown.entry.name, mimeType: "image/png", base64: await drawImage(shown.hue, shown.entry.name) };
    const name = FILE_NAMES.get(id);
    const bytes = name ? await fixtureBase64(name) : null;
    if (name && bytes) return { name, mimeType: attachmentMimeTypeForName(name), base64: bytes };
    return base.download(id);
  };
  return {
    ...base,
    download: read,
    attachmentPreview: async (id: string) => (IMAGES.has(id) ? read(id) : null),
    attachmentRendition: async (id: string, kind: AttachmentRenditionKind, path?: string) => {
      const name = FILE_NAMES.get(id);
      if (!name) return null;
      const suffix = path ? `.${path.replaceAll("/", "_")}` : "";
      const bytes = await fixtureBase64(`renditions/${name}.${kind}${suffix}`);
      if (!bytes) return null;
      const mimeType =
        kind === "thumbnail"
          ? "image/jpeg"
          : kind === "document"
            ? "application/pdf"
            : kind === "archive" || kind === "waveform"
              ? "application/json"
              : "application/octet-stream";
      return { name: `${name}.${kind}`, mimeType, base64: bytes };
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
