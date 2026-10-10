import { isSupportedAttachmentName } from "@openbot/contracts/attachment-files";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { MOBILE_ATTACHMENT_BYTES } from "@openbot/team-client/remote-peer";
import type { TextValue } from "@openbot/ui/text";

/**
 * Why a file is not uploaded. `host` is found only by the host's own check, after the plan: the
 * file type needs a capability that the connected host does not advertise.
 */
export type UploadRejectionReason = "type" | "size" | "host" | "limit";

export interface UploadRejection {
  name: string;
  reason: UploadRejectionReason;
}

export interface UploadPlan {
  accepted: File[];
  rejected: UploadRejection[];
}

/** The most names a notice lists; the rest are counted. */
const NAMES_SHOWN = 3;

/**
 * Sorts the files before any of them goes up, so a file that the host would refuse is named at once and
 * the valid files are not held back or sent for nothing. A file counts against `room` only when it is
 * valid, in the order chosen: a message has room for `INPUT_LIMITS.attachments` files in all.
 */
export function planUploads(files: readonly File[], room: number = INPUT_LIMITS.attachments): UploadPlan {
  const accepted: File[] = [];
  const rejected: UploadRejection[] = [];
  const left = Math.max(0, room);
  for (const file of files) {
    if (!isSupportedAttachmentName(file.name)) rejected.push({ name: file.name, reason: "type" });
    else if (file.size > MOBILE_ATTACHMENT_BYTES) rejected.push({ name: file.name, reason: "size" });
    else if (accepted.length >= left) rejected.push({ name: file.name, reason: "limit" });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** Whether the host's answer to an upload means its capabilities do not cover this file type. */
export function isHostFileTypeError(error: unknown, text: Pick<TextValue, "t">): boolean {
  return error instanceof Error && error.message === text.t("webClient.error.fileType");
}

/** One sentence for each reason, each naming the files with the reason and the limit it measures. */
export function uploadRejectionNotice(
  rejected: readonly UploadRejection[],
  text: Pick<TextValue, "t" | "format">,
): string {
  const { t, format } = text;
  const named = (reason: UploadRejectionReason) => {
    const names = rejected.filter((item) => item.reason === reason).map((item) => item.name);
    if (names.length <= NAMES_SHOWN) return format.list(names);
    return t("webClient.upload.namesMore", {
      names: format.list(names.slice(0, NAMES_SHOWN)),
      count: format.number(names.length - NAMES_SHOWN),
    });
  };
  const has = (reason: UploadRejectionReason) => rejected.some((item) => item.reason === reason);
  const sentences: string[] = [];
  if (has("type")) sentences.push(t("webClient.upload.rejectedType", { names: named("type") }));
  if (has("size"))
    sentences.push(
      t("webClient.upload.rejectedSize", { limit: format.fileSize(MOBILE_ATTACHMENT_BYTES), names: named("size") }),
    );
  if (has("host")) sentences.push(t("webClient.upload.rejectedHost", { names: named("host") }));
  if (has("limit"))
    sentences.push(t("webClient.upload.rejectedLimit", { limit: INPUT_LIMITS.attachments, names: named("limit") }));
  return sentences.join(" ");
}
