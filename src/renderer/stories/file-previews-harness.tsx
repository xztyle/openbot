/*
 * One message with a file of every kind, for `scripts/file-previews-e2e.ts`: a video, an audio file,
 * a PDF, a deck, a document, a spreadsheet, an old spreadsheet, a ZIP, a TAR.GZ, a CSV and Markdown.
 * The message draws through the chat's renderer, and a tap opens the files' viewer through the same
 * loader the channels use. The host is a stand-in that serves the fixture files and the renditions
 * that `scripts/file-renditions-e2e.ts --out` made with the real tools.
 */
import { attachmentMimeTypeForName } from "@openbot/contracts/attachment-files";
import { type AttachmentSummary, type FilePreview, filePreviewKindForFile } from "@openbot/contracts/ipc";
import type { AttachmentRenditionKind } from "@openbot/contracts/team-protocol/attachment-renditions-v1";
import { Bubble, BubbleContent, Toaster } from "@openbot/ui";
import type { AgentMessage } from "@openbot/ui/data";
import type { AttachmentMediaSource } from "@openbot/ui/features/conversation/AttachmentCards";
import { FilePreviewDialog, type FilePreviewDialogState } from "@openbot/ui/features/conversation/FilePreviewDialog";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { loadArchiveEntryPreview, loadAttachmentPreview } from "../src/features/conversation/attachment-preview";
import { StaticI18nProvider } from "../src/i18n-context";
import { STORY_AGENTS } from "./fixtures";
import "../src/styles.css";

const query = new URLSearchParams(location.search);
document.documentElement.dataset.openbotColorScheme = query.get("scheme") === "light" ? "light" : "dark";

const FILES: [string, number][] = [
  ["clip.mp4", 40_323],
  ["voice.mp3", 32_618],
  ["sample.pdf", 20_940],
  ["deck.pptx", 11_549],
  ["report.docx", 5_402],
  ["budget.xlsx", 6_632],
  ["presupuesto.xls", 6_144],
  ["proyecto.zip", 19_561],
  ["codigo.tar.gz", 135],
  ["ventas.csv", 69],
  ["notas.md", 179],
];

const attachments: AttachmentSummary[] = FILES.map(([name, size]) => {
  const mimeType = attachmentMimeTypeForName(name);
  return {
    id: `file-${name}`,
    name,
    size,
    kind: "file",
    mimeType,
    previewKind: mimeType === "application/pdf" ? "pdf" : mimeType.startsWith("text/") ? "text" : "none",
    // The browser client: no file URL, everything comes through the media source.
    previewUrl: null,
  };
});

const MESSAGE: AgentMessage = {
  id: "files",
  author: "agent",
  body: "Aquí tienes los archivos de la reunión.",
  time: "10:00",
  attachments,
};

const fixture = (name: string) => `/__fixtures/file-previews/${name.split("/").map(encodeURIComponent).join("/")}`;
const bytesOf = async (url: string) => {
  const response = await fetch(url);
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
};

/** The stand-in host: the web client's media source, over the fixture files. */
const loaded = new Map<string, string>();
const [shown, setShown] = createSignal<ReadonlyMap<string, string>>(new Map());
const source: AttachmentMediaSource = {
  url: (id) => shown().get(id),
  async load(attachment) {
    const bytes = await bytesOf(fixture(attachment.name));
    if (!bytes) return false;
    const url = URL.createObjectURL(new Blob([bytes], { type: attachment.mimeType }));
    loaded.set(attachment.id, url);
    setShown(new Map(loaded));
    return true;
  },
  thumbnailLimit: 4 * 1024 * 1024,
  mediaLimit: 64 * 1024 * 1024,
  cacheKey: () => "harness",
  async rendition(attachment, kind: AttachmentRenditionKind, path) {
    const suffix = path ? `.${path.replaceAll("/", "_")}` : "";
    const name = `renditions/${attachment.name}.${kind}${suffix}`;
    const bytes = await bytesOf(fixture(name));
    if (!bytes) return null;
    const type =
      kind === "thumbnail"
        ? "image/jpeg"
        : kind === "document"
          ? "application/pdf"
          : kind === "archive" || kind === "waveform"
            ? "application/json"
            : "application/octet-stream";
    return { bytes, mimeType: type };
  },
  streamUrl: async (attachment) => fixture(attachment.name),
};

async function previewAttachment(attachment: AttachmentSummary): Promise<FilePreview> {
  const bytes = await bytesOf(fixture(attachment.name));
  return {
    name: attachment.name,
    size: bytes?.byteLength ?? 0,
    mimeType: attachment.mimeType,
    previewKind: filePreviewKindForFile(attachment.name, attachment.mimeType),
    bytes,
  };
}

function Harness() {
  const [open, setOpen] = createSignal<{
    attachment: AttachmentSummary;
    state: FilePreviewDialogState;
    listing?: FilePreviewDialogState;
  } | null>(null);
  const [downloads, setDownloads] = createSignal<string[]>([]);
  const view = (attachment: AttachmentSummary) => {
    setOpen({ attachment, state: { status: "loading", name: attachment.name } });
    void loadAttachmentPreview(attachment, { previewAttachment, media: source }).then(
      ({ preview, sourceUrl }) =>
        setOpen({ attachment, state: { status: "ready", name: attachment.name, preview, sourceUrl } }),
      (error: unknown) =>
        setOpen({ attachment, state: { status: "failed", name: attachment.name, message: String(error) } }),
    );
  };
  const files = attachments;
  const siblings = (attachment: AttachmentSummary) => {
    const index = files.findIndex((file) => file.id === attachment.id);
    return {
      index,
      count: files.length,
      previous: () => view(files[(index - 1 + files.length) % files.length] ?? attachment),
      next: () => view(files[(index + 1) % files.length] ?? attachment),
    };
  };
  return (
    <StaticI18nProvider locale="es">
      <main style={{ padding: "24px", "max-width": "760px" }}>
        <div class="message-entry message-entry-agent">
          <Bubble align="start" variant="muted" data-author="assistant">
            <BubbleContent>
              <MessageBody
                message={MESSAGE}
                agents={STORY_AGENTS}
                onSelectAgent={() => undefined}
                onOpenLink={() => undefined}
                onPreview={view}
                onAttachmentAction={(attachment, action) =>
                  action === "download" ? setDownloads((list) => [...list, attachment.name]) : view(attachment)
                }
                onDownload={(attachment) => setDownloads((list) => [...list, attachment.name])}
                mediaSource={source}
              />
            </BubbleContent>
          </Bubble>
        </div>
        <output class="harness-downloads">{downloads().join(",")}</output>
      </main>
      <Show when={open()}>
        {(current) => (
          <FilePreviewDialog
            state={current().state}
            agents={STORY_AGENTS}
            meta={{ sender: "Lucía", sentAt: Date.UTC(2026, 10, 26, 10) }}
            siblings={current().listing ? undefined : siblings(current().attachment)}
            onCopyLink={() => void navigator.clipboard?.writeText("https://example.invalid/message")}
            onOpenArchiveEntry={(path) => {
              const listing = current().state;
              const attachment = current().attachment;
              const name = path.split("/").at(-1) ?? path;
              setOpen({ attachment, listing, state: { status: "loading", name } });
              void loadArchiveEntryPreview(attachment, path, source).then(
                (preview) =>
                  setOpen({ attachment, listing, state: { status: "ready", name, preview, sourceUrl: null } }),
                (error: unknown) =>
                  setOpen({ attachment, listing, state: { status: "failed", name, message: String(error) } }),
              );
            }}
            onBack={
              current().listing
                ? () => {
                    const listing = current().listing;
                    if (listing) setOpen({ attachment: current().attachment, state: listing });
                  }
                : undefined
            }
            onOpenLink={() => undefined}
            onDownload={() => setDownloads((list) => [...list, current().attachment.name])}
            onClose={() => setOpen(null)}
          />
        )}
      </Show>
      <Toaster />
    </StaticI18nProvider>
  );
}

const root = document.getElementById("root");
if (root) render(() => <Harness />, root);
