import type { AttachmentPreviewKind, AttachmentSummary, WorkspaceArtifactFile } from "@openbot/contracts/ipc";
import type { useWorkspace } from "./workspace-context";

/**
 * Opens an artifact: its address, or the file an agent attached. With `view`, a browser shows the file
 * in the viewer, as it shows a file of a message: without it, Open only downloaded the file, and a
 * failed download said nothing. The desktop opens the file in the app of the system.
 */
export function openArtifact(
  ws: ReturnType<typeof useWorkspace>,
  id: string,
  channelId?: string,
  view?: (attachment: AttachmentSummary) => void,
) {
  const artifact = ws.artifacts.artifacts(channelId ? { channelId } : undefined).find((item) => item.id === id);
  if (artifact?.url) {
    void ws.channels.port().openUrl(artifact.url);
    return;
  }
  const file = ws.artifactRecord(id)?.file;
  if (file && view && ws.channels.port().fileActions === "browser") {
    view(artifactAttachment(file));
    return;
  }
  const attachmentId = file?.id ?? (id.includes(":attachment:") ? id.split(":attachment:")[1] : undefined);
  if (attachmentId)
    void ws.channels
      .port()
      .agent.openAttachment({ attachmentId, action: "open" })
      .catch(() => undefined);
}

/** The file of an artifact as the attachment of its message, with the preview kind that the host gives one. */
function artifactAttachment(file: WorkspaceArtifactFile): AttachmentSummary {
  const type = file.mimeType;
  const previewKind: AttachmentPreviewKind = type.startsWith("image/")
    ? "image"
    : type === "application/pdf"
      ? "pdf"
      : type.startsWith("text/") || type === "application/json" || type === "message/rfc822"
        ? "text"
        : "none";
  return { ...file, kind: previewKind === "image" ? "image" : "file", previewKind, previewUrl: null };
}
