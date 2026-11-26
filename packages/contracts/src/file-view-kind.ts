import { attachmentFileExtension, attachmentMimeTypeForName } from "./attachment-files";

/**
 * How a client shows a file of a message, inline and in the viewer. It reads the name and the MIME
 * type, which every Team API version carries, so no wire field changes. Both the desktop, web and
 * phone clients use this one function.
 */
export type FileViewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  /** A presentation: shown as a deck of slides. */
  | "slides"
  /** A text document: shown as pages. */
  | "document"
  /** A spreadsheet: shown as a sheet grid with tabs. */
  | "sheet"
  | "archive"
  | "markdown"
  | "csv"
  | "code"
  | "unknown";

const SLIDES = new Set(["ppt", "pptx", "odp", "key"]);
const DOCUMENTS = new Set(["doc", "docx", "odt", "rtf"]);
const SHEETS = new Set(["xls", "xlsx", "ods"]);
const ARCHIVES = new Set(["zip", "tar", "tgz", "gz"]);
const CSV = new Set(["csv", "tsv"]);
const MARKDOWN = new Set(["md", "markdown"]);

export function fileViewKind(name: string, mimeType: string): FileViewKind {
  const extension = attachmentFileExtension(name) ?? "";
  const type = (mimeType.split(";")[0]?.trim().toLowerCase() || attachmentMimeTypeForName(name)).toLowerCase();
  if (MARKDOWN.has(extension)) return "markdown";
  if (CSV.has(extension) || type === "text/csv") return "csv";
  if (SLIDES.has(extension)) return "slides";
  if (DOCUMENTS.has(extension)) return "document";
  if (SHEETS.has(extension)) return "sheet";
  if (ARCHIVES.has(extension) || type === "application/zip") return "archive";
  if (extension === "pdf" || type === "application/pdf") return "pdf";
  if (extension === "svg") return "code";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("text/") || type === "application/json" || type === "message/rfc822") return "code";
  return "unknown";
}

/** Kinds the host turns into a PDF for the viewer and a thumbnail for the chat. */
export function isOfficeViewKind(kind: FileViewKind): kind is "slides" | "document" | "sheet" {
  return kind === "slides" || kind === "document" || kind === "sheet";
}

/** Kinds that show a picture of their first page, slide or frame in the chat. */
export function hasThumbnailViewKind(kind: FileViewKind): boolean {
  return kind === "pdf" || kind === "video" || isOfficeViewKind(kind);
}
