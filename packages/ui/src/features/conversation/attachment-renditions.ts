import type { AttachmentSummary } from "@openbot/contracts/ipc";
import {
  type ArchiveListing,
  type AttachmentRenditionKind,
  type AudioWaveform,
  decodeArchiveListing,
  decodeAudioWaveform,
} from "@openbot/contracts/team-protocol/attachment-renditions-v1";
import type { AttachmentMediaSource } from "./AttachmentCards";

/** A file that the host made from an attachment for display. */
export interface RenditionBytes {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * Reads a rendition of an attachment. A client with a media source (the browser) reads it through
 * the host connection; a client with a `previewUrl` (desktop) reads the same request from that URL.
 * Resolves null when the host has none.
 */
export async function readRendition(
  attachment: AttachmentSummary,
  kind: AttachmentRenditionKind,
  source: AttachmentMediaSource | undefined,
  path?: string,
): Promise<RenditionBytes | null> {
  if (source?.rendition) return source.rendition(attachment, kind, path).catch(() => null);
  const url = renditionUrl(attachment, kind, path);
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}

/** The URL of a rendition on a client whose attachments have a `previewUrl`, or null. */
export function renditionUrl(attachment: AttachmentSummary, kind: AttachmentRenditionKind, path?: string) {
  if (!attachment.previewUrl) return null;
  try {
    const url = new URL(attachment.previewUrl);
    url.searchParams.set("rendition", kind);
    if (path !== undefined) url.searchParams.set("path", path);
    return url.toString();
  } catch {
    return null;
  }
}

// Thumbnails are object URLs kept for the session: the chat mounts a row again when it scrolls back,
// and an attachment id names bytes that do not change.
const THUMBNAILS_KEPT = 300;
const thumbnails = new Map<string, Promise<string | null>>();

/** The thumbnail of the first page, slide or frame, as a URL an image can draw, or null. */
export function thumbnailUrl(attachment: AttachmentSummary, source: AttachmentMediaSource | undefined) {
  const direct = source?.rendition ? null : renditionUrl(attachment, "thumbnail");
  if (direct) return Promise.resolve(direct);
  const key = `${source?.cacheKey?.() ?? ""}:${attachment.id}`;
  const known = thumbnails.get(key);
  if (known) return known;
  const made = readRendition(attachment, "thumbnail", source).then((file) =>
    // Only a JPEG becomes an object URL: a type a browser runs as a page never gets one.
    file && file.mimeType === "image/jpeg"
      ? URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }))
      : null,
  );
  thumbnails.set(key, made);
  void made.then((url) => {
    if (!url) thumbnails.delete(key);
  });
  for (const [oldKey, old] of thumbnails) {
    if (thumbnails.size <= THUMBNAILS_KEPT) break;
    thumbnails.delete(oldKey);
    void old.then((url) => url?.startsWith("blob:") && URL.revokeObjectURL(url));
  }
  return made;
}

const waveforms = new Map<string, Promise<AudioWaveform | null>>();

export function audioWaveform(attachment: AttachmentSummary, source: AttachmentMediaSource | undefined) {
  const key = `${source?.cacheKey?.() ?? ""}:${attachment.id}`;
  let known = waveforms.get(key);
  if (!known) {
    known = readRendition(attachment, "waveform", source).then((file) => {
      if (!file) return null;
      try {
        return decodeAudioWaveform(JSON.parse(new TextDecoder().decode(file.bytes)));
      } catch {
        return null;
      }
    });
    waveforms.set(key, known);
    if (waveforms.size > 200) waveforms.delete(waveforms.keys().next().value ?? "");
  }
  return known;
}

export async function archiveListing(
  attachment: AttachmentSummary,
  source: AttachmentMediaSource | undefined,
): Promise<ArchiveListing | null> {
  const file = await readRendition(attachment, "archive", source);
  if (!file) return null;
  try {
    return decodeArchiveListing(JSON.parse(new TextDecoder().decode(file.bytes)));
  } catch {
    return null;
  }
}
