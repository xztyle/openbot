import { attachmentMimeTypeForName, isXlsxMimeType, XLSX_MIME_TYPE } from "@openbot/contracts/attachment-files";
import { fileViewKind, isOfficeViewKind } from "@openbot/contracts/file-view-kind";
import { type AttachmentSummary, type FilePreview, filePreviewKindForFile } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import type { AttachmentMediaSource } from "@openbot/ui/features/conversation/AttachmentCards";
import { readRendition } from "@openbot/ui/features/conversation/attachment-renditions";
import { currentText } from "@openbot/ui/text";

/** Kinds the panel can render straight from `previewUrl`, without reading the bytes first. */
const URL_PREVIEW_KINDS = new Set<FilePreview["previewKind"]>(["image", "pdf", "audio", "video"]);

/**
 * A deleted file keeps its chat message, and the host answers its URL with 404. The English source
 * text goes into the error; `errorMessage` shows it in the interface language.
 */
const attachmentUnavailable = () => sourceText("error.attachment.unavailable");

/** Only the local host's files are checked: a remote check downloads the whole file first. */
const LOCAL_ATTACHMENT_URL = /^openbot-attachment:/u;

/**
 * Builds the file preview panel's `FilePreview` from an attachment record. `AttachmentSummary`
 * keeps a narrow `previewKind`, because the released Team API v1-v4 validators accept only image,
 * pdf, text, and none. The panel kind is derived from the name and MIME type instead, the same way
 * `src/main/file-preview.ts` derives it for a file on disk.
 *
 * An image, PDF, or media file keeps `bytes: null`: the panel points at `previewUrl` for those, so
 * a 100 MB video is never copied into the renderer to be shown.
 */
export async function attachmentFilePreview(attachment: AttachmentSummary): Promise<FilePreview> {
  const mimeType = attachment.mimeType || attachmentMimeTypeForName(attachment.name);
  const previewKind = filePreviewKindForFile(attachment.name, mimeType);
  const base = { name: attachment.name, size: attachment.size, mimeType };
  if (previewKind === "none" || !attachment.previewUrl) return { ...base, previewKind: "none", bytes: null };
  if (URL_PREVIEW_KINDS.has(previewKind)) {
    if (LOCAL_ATTACHMENT_URL.test(attachment.previewUrl)) await assertAttachmentAvailable(attachment.previewUrl);
    return { ...base, previewKind, bytes: null };
  }
  const response = await fetch(attachment.previewUrl);
  if (response.status === 404) throw new Error(attachmentUnavailable());
  if (!response.ok) throw new Error(currentText().t("attachment.previewUnavailable"));
  return { ...base, previewKind, bytes: new Uint8Array(await response.arrayBuffer()) };
}

/**
 * Stops the panel from opening on a broken image, PDF, or player when the file was deleted. Only a
 * 404 stops it: after any other failure the panel opens as it did before this check.
 */
async function assertAttachmentAvailable(url: string): Promise<void> {
  const response = await fetch(url).catch(() => null);
  void response?.body?.cancel();
  if (response?.status === 404) throw new Error(attachmentUnavailable());
}

/** What the viewer shows for an attachment: the file, and a URL to point at instead of its bytes. */
export interface LoadedAttachmentPreview {
  preview: FilePreview;
  sourceUrl: string | null;
}

/**
 * Reads what the viewer needs for an attachment, on every client through the same steps. An Office
 * file shows the PDF the host made of it, an old spreadsheet its XLSX copy, an archive its listing,
 * and audio or video plays from a stream when the host gives one. Everything else is the file itself,
 * from `previewAttachment` (the browser) or from `previewUrl` (desktop).
 */
export async function loadAttachmentPreview(
  attachment: AttachmentSummary,
  readers: {
    previewAttachment?: ((attachment: AttachmentSummary) => Promise<FilePreview>) | undefined;
    media?: AttachmentMediaSource | undefined;
    /** Whether audio and video may play from a stream URL instead of their bytes. */
    stream?: boolean;
  },
): Promise<LoadedAttachmentPreview> {
  const view = fileViewKind(attachment.name, attachment.mimeType);
  const base = { name: attachment.name, size: attachment.size };
  const unavailable = () => new Error(currentText().t("attachment.previewUnavailable"));
  if (isOfficeViewKind(view) && !isXlsxMimeType(attachment.mimeType || attachmentMimeTypeForName(attachment.name))) {
    const kind = view === "sheet" ? "sheet" : "document";
    const file = await readRendition(attachment, kind, readers.media);
    if (!file) throw unavailable();
    return {
      preview: {
        ...base,
        mimeType: kind === "sheet" ? XLSX_MIME_TYPE : "application/pdf",
        previewKind: kind === "sheet" ? "spreadsheet" : "pdf",
        bytes: file.bytes,
      },
      sourceUrl: null,
    };
  }
  if (view === "archive") {
    const file = await readRendition(attachment, "archive", readers.media);
    if (!file) throw unavailable();
    return {
      preview: { ...base, mimeType: "application/json", previewKind: "archive", bytes: file.bytes },
      sourceUrl: null,
    };
  }
  if ((view === "video" || view === "audio") && !attachment.previewUrl && readers.stream !== false) {
    const stream = await readers.media?.streamUrl?.(attachment).catch(() => null);
    if (stream)
      return {
        preview: { ...base, mimeType: attachment.mimeType, previewKind: view, bytes: null },
        sourceUrl: stream,
      };
  }
  const preview = await (readers.previewAttachment ?? attachmentFilePreview)(attachment);
  // The PDF reader takes bytes on every client, so it never fetches an app URL from its worker.
  if (preview.previewKind === "pdf" && !preview.bytes && attachment.previewUrl) {
    const response = await fetch(attachment.previewUrl);
    if (!response.ok) throw unavailable();
    return { preview: { ...preview, bytes: new Uint8Array(await response.arrayBuffer()) }, sourceUrl: null };
  }
  return { preview, sourceUrl: attachment.previewUrl };
}

/** One file inside an archive, read from the host as the viewer shows it. */
export async function loadArchiveEntryPreview(
  attachment: AttachmentSummary,
  path: string,
  media: AttachmentMediaSource | undefined,
): Promise<FilePreview> {
  const file = await readRendition(attachment, "entry", media, path);
  if (!file) throw new Error(currentText().t("attachment.previewUnavailable"));
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  const mimeType = attachmentMimeTypeForName(name);
  return {
    name,
    size: file.bytes.byteLength,
    mimeType,
    previewKind: filePreviewKindForFile(name, mimeType),
    bytes: file.bytes,
  };
}
