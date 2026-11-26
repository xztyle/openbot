/*
 * The image annotator over the app. Any surface with an image, the viewer, a file card or a message
 * box, calls `openImageAnnotator` with the image and what Send does; `ImageAnnotatorHost` draws the
 * one open annotator. The host sits in the app shells of the desktop and the browser client, so the
 * same component serves a computer and a phone.
 */
import type { AttachmentSummary, FilePreview } from "@openbot/contracts/ipc";
import type { AttachmentMediaSource } from "@openbot/ui/features/conversation/AttachmentCards";
import { ImageAnnotator, type ImageAnnotatorSource } from "@openbot/ui/features/conversation/ImageAnnotator";
import { currentText } from "@openbot/ui/text";
import { createSignal, Show } from "solid-js";

export interface ImageAnnotatorRequest {
  source: ImageAnnotatorSource;
  /** Puts the result in a message box. Absent, the annotator offers Save only. */
  onSend?: ((file: File) => Promise<void> | void) | undefined;
  /** `done` for an image that is in the message box already: the result takes its place. */
  sendLabel?: "send" | "done" | undefined;
}

const [request, setRequest] = createSignal<ImageAnnotatorRequest | null>(null);

export function openImageAnnotator(next: ImageAnnotatorRequest): void {
  setRequest(next);
}

export function closeImageAnnotator(): void {
  setRequest(null);
}

/** The one open annotator. Mounted once per app shell. */
export function ImageAnnotatorHost() {
  return (
    <Show when={request()}>
      {(open) => (
        <ImageAnnotator
          source={open().source}
          onSend={open().onSend}
          sendLabel={open().sendLabel}
          onClose={closeImageAnnotator}
        />
      )}
    </Show>
  );
}

/**
 * The files of the images the reader attached in this session, by draft id, so the annotator opens
 * one without reading it back from the host. A browser client gets no `previewUrl` for a draft.
 */
const attachedFiles = new Map<string, File>();
const ATTACHED_FILES_KEPT = 50;

export function rememberImageFile(attachment: AttachmentSummary, file: File): void {
  if (!file.type.startsWith("image/")) return;
  attachedFiles.delete(attachment.id);
  attachedFiles.set(attachment.id, file);
  for (const id of attachedFiles.keys()) {
    if (attachedFiles.size <= ATTACHED_FILES_KEPT) break;
    attachedFiles.delete(id);
  }
}

/** What a surface can read an attachment's bytes through. Each is optional; the first that answers wins. */
export interface AttachmentImageReader {
  previewAttachment?: ((attachment: AttachmentSummary) => Promise<FilePreview>) | undefined;
  attachmentMedia?: AttachmentMediaSource | undefined;
}

async function fetchBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

/**
 * The annotator's view of an attachment. It reads the original: the file the reader attached, the
 * URL the viewer shows (`shownUrl`, the original once the viewer has it), the full-size image the
 * media source has, the attachment's own URL, or the preview bytes of the host.
 */
export function attachmentImageSource(
  attachment: AttachmentSummary,
  reader: AttachmentImageReader,
  shownUrl?: string,
): ImageAnnotatorSource {
  return {
    name: attachment.name,
    mimeType: attachment.mimeType,
    async load() {
      const known = attachedFiles.get(attachment.id);
      if (known) return known;
      const media = reader.attachmentMedia;
      // The viewer's URL is the original only once the media source has read it; a small copy is not.
      const shownIsOriginal = shownUrl && (!media?.fullUrl || media.fullUrl(attachment.id) === shownUrl);
      if (shownUrl && shownIsOriginal) {
        const blob = await fetchBlob(shownUrl);
        if (blob) return blob;
      }
      if (media?.fullUrl && media.loadFull) {
        const url =
          media.fullUrl(attachment.id) ??
          ((await media.loadFull(attachment)) ? media.fullUrl(attachment.id) : undefined);
        const blob = url ? await fetchBlob(url) : null;
        if (blob) return blob;
      }
      if (attachment.previewUrl) {
        const blob = await fetchBlob(attachment.previewUrl);
        if (blob) return blob;
      }
      const preview = await reader.previewAttachment?.(attachment);
      if (preview?.bytes) return new Blob([new Uint8Array(preview.bytes)], { type: attachment.mimeType });
      throw new Error(currentText().t("chat.annotate.failed"));
    },
  };
}
