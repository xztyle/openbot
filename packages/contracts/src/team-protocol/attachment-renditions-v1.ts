// Optional attachment-renditions-v1 wire contract (fork only, shares `fork-host-v1`).
//
// What it grants: a signed-in member who can read an attachment with `GET /v1/attachments/:id` can
// also read files that the host makes from it, for display. The host makes them on its own disk and
// keeps them there, keyed by the file's content. The original never leaves the host for this.
//
// - `thumbnail`: a JPEG of the first page, slide or video frame, at most 480 pixels wide.
// - `document`: a PDF of an Office document (or the original PDF).
// - `sheet`: an XLSX copy of an older or OpenDocument spreadsheet (xls, ods).
// - `waveform`: JSON `{ "peaks": number[], "duration": number }` for an audio file.
// - `archive`: JSON `ArchiveListing` of a ZIP or TAR file.
// - `entry`: the bytes of one file in an archive, named by `?path=` exactly as the listing names it.
//
// Every answer is a file (`Content-Disposition: attachment`). A host that cannot make one answers
// 404, and the client shows the plain file card. A host built before this route answers 404 too.
import { isDynamicRecord } from "../runtime-values";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const ATTACHMENT_RENDITIONS_CAPABILITY = FORK_HOST_CAPABILITY;

export const ATTACHMENT_RENDITION_KINDS = ["thumbnail", "document", "sheet", "waveform", "archive", "entry"] as const;
export type AttachmentRenditionKind = (typeof ATTACHMENT_RENDITION_KINDS)[number];

/** The most entries one archive listing names. The rest are counted by `truncated`. */
export const ARCHIVE_LISTING_LIMIT = 5_000;
/** The largest archive entry the host unpacks for a preview. */
export const ARCHIVE_ENTRY_BYTES = 100 * 1024 * 1024;

export interface ArchiveListingEntry {
  /** The path inside the archive, with `/` separators. A folder ends with `/`. */
  path: string;
  size: number;
  directory: boolean;
}

export interface ArchiveListing {
  entries: ArchiveListingEntry[];
  truncated: boolean;
}

export interface AudioWaveform {
  /** Peak levels from 0 to 1, evenly spaced over the file. */
  peaks: number[];
  /** Seconds. */
  duration: number;
}

const RENDITION_ROUTE = /^\/v1\/attachments\/([^/]{1,300})\/renditions\/([a-z]{1,20})$/u;

/** The rendition route of one attachment. `path` names an archive entry. */
export function attachmentRenditionRoute(attachmentId: string, kind: AttachmentRenditionKind, path?: string): string {
  const route = `/v1/attachments/${encodeURIComponent(attachmentId)}/renditions/${kind}`;
  return path === undefined ? route : `${route}?${new URLSearchParams({ path }).toString()}`;
}

/** The attachment id and kind of a rendition route path, or null for any other path. */
export function attachmentRenditionTarget(
  pathname: string,
): { attachmentId: string; kind: AttachmentRenditionKind } | null {
  const match = RENDITION_ROUTE.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  const kind = ATTACHMENT_RENDITION_KINDS.find((candidate) => candidate === match[2]);
  if (!kind) return null;
  try {
    return { attachmentId: decodeURIComponent(match[1]), kind };
  } catch {
    return null;
  }
}

export function isAttachmentRenditionKind(value: unknown): value is AttachmentRenditionKind {
  return ATTACHMENT_RENDITION_KINDS.some((kind) => kind === value);
}

/** Decodes an archive listing from the host. Entries with a bad shape are left out. */
export function decodeArchiveListing(value: unknown): ArchiveListing | null {
  if (!isDynamicRecord(value) || !Array.isArray(value.entries)) return null;
  const entries: ArchiveListingEntry[] = [];
  for (const entry of value.entries.slice(0, ARCHIVE_LISTING_LIMIT)) {
    if (!isDynamicRecord(entry) || typeof entry.path !== "string" || !entry.path || entry.path.length > 4096) continue;
    if (typeof entry.size !== "number" || !Number.isFinite(entry.size) || entry.size < 0) continue;
    entries.push({ path: entry.path, size: entry.size, directory: entry.directory === true });
  }
  return { entries, truncated: value.truncated === true };
}

/** Decodes a waveform from the host, or null. */
export function decodeAudioWaveform(value: unknown): AudioWaveform | null {
  if (!isDynamicRecord(value) || !Array.isArray(value.peaks) || typeof value.duration !== "number") return null;
  const peaks = value.peaks
    .slice(0, 512)
    .map((peak) => (typeof peak === "number" && Number.isFinite(peak) ? Math.min(1, Math.max(0, peak)) : 0));
  return peaks.length ? { peaks, duration: Math.max(0, value.duration) } : null;
}
