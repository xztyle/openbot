// Frozen optional attachment-previews-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: a signed-in member who can
// read an attachment with `GET /v1/attachments/:id` can also read a smaller copy of it for inline
// display. The host answers with an image file: a PNG or JPEG of at most 1024 pixels on its longest
// side when it can make one, or else the original file with its own type. The client checks the type
// before it shows the image. A host built before this route answers 404, and the client reads the
// original. The route names no capability of its own: it shares `fork-host-v1`.
import { attachmentRenditionTarget } from "./attachment-renditions-v1";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import { workspaceArtifactThumbnailId } from "./workspace-fleet-v1";

export const ATTACHMENT_PREVIEWS_CAPABILITY = FORK_HOST_CAPABILITY;

const PREVIEW_ROUTE = /^\/v1\/attachments\/([^/]{1,300})\/preview$/u;

/** The preview route of one attachment. */
export function attachmentPreviewRoute(attachmentId: string): string {
  return `/v1/attachments/${encodeURIComponent(attachmentId)}/preview`;
}

/** The attachment id of a preview route path, or null for any other path. */
export function attachmentPreviewId(pathname: string): string | null {
  const match = PREVIEW_ROUTE.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * A GET of a file that came after the frozen v3 no-body route list: an attachment preview, an
 * attachment rendition (`attachment-renditions-v1`) or an artifact thumbnail. Its frame carries no body, as the browser display route's does.
 */
export function isFileImageRoute(method: string, path: string): boolean {
  if (method !== "GET") return false;
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  return (
    attachmentPreviewId(pathname) !== null ||
    attachmentRenditionTarget(pathname) !== null ||
    workspaceArtifactThumbnailId(pathname) !== null
  );
}
