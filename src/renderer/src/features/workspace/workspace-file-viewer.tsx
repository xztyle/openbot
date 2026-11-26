import { type AttachmentSummary, canPreviewAttachment } from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { FilePreviewDialog, type FilePreviewDialogState } from "@openbot/ui/features/conversation/FilePreviewDialog";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { attachmentFilePreview } from "../conversation/attachment-preview";
import { useWorkspace } from "./workspace-context";

export interface WorkspaceFileViewer {
  /** A file that the app can show opens in the viewer at once, and fills it when it is read. Any other file downloads. */
  view(attachment: AttachmentSummary): void;
  /** A download says that it started: a file that comes through the host connection takes a while. */
  download(attachment: AttachmentSummary): void;
  /** The viewer, where the owner of this viewer draws it. */
  Viewer: () => JSX.Element;
}

/**
 * The viewer of the files of messages and artifacts, as Slack shows a file over the app. `annotate`
 * gives an image viewer an Annotate button.
 */
export function createWorkspaceFileViewer(
  options: { annotate?: ((attachment: AttachmentSummary) => void) | undefined } = {},
): WorkspaceFileViewer {
  const ws = useWorkspace();
  const { t, errorMessage } = useText();
  const port = () => ws.channels.port();
  const [viewer, setViewer] = createSignal<{ attachment: AttachmentSummary; state: FilePreviewDialogState } | null>(
    null,
  );
  let viewing = 0;
  const download = (attachment: AttachmentSummary) => {
    const progress = toast.loading(t("attachment.downloading", { name: attachment.name }));
    void port()
      .agent.openAttachment({ attachmentId: attachment.id, action: "download" })
      .then(
        () => toast.dismiss(progress),
        (error: unknown) => toast.error(errorMessage(error, t("attachment.error.open")), { id: progress }),
      );
  };
  const view = (attachment: AttachmentSummary) => {
    if (!canPreviewAttachment(attachment)) return download(attachment);
    const run = ++viewing;
    const name = attachment.name;
    setViewer({ attachment, state: { status: "loading", name } });
    void (port().previewAttachment ?? attachmentFilePreview)(attachment).then(
      (preview) => {
        if (run === viewing)
          setViewer({ attachment, state: { status: "ready", name, preview, sourceUrl: attachment.previewUrl } });
      },
      (error: unknown) => {
        if (run === viewing)
          setViewer({
            attachment,
            state: { status: "failed", name, message: errorMessage(error, t("attachment.error.preview", { name })) },
          });
      },
    );
  };
  const Viewer = () => (
    <Show when={viewer()}>
      {(open) => (
        <FilePreviewDialog
          state={open().state}
          agents={ws.env.agents()}
          onOpenLink={(url) => {
            if (!ws.openLink(url)) void port().openUrl(url);
          }}
          onDownload={() => download(open().attachment)}
          onAnnotate={options.annotate ? () => options.annotate?.(open().attachment) : undefined}
          onOpenExternally={
            port().fileActions === "native"
              ? () =>
                  void port()
                    .agent.openAttachment({ attachmentId: open().attachment.id, action: "open" })
                    .catch((error: unknown) => toast.error(errorMessage(error, t("attachment.error.open"))))
              : undefined
          }
          onClose={() => {
            viewing += 1;
            setViewer(null);
          }}
        />
      )}
    </Show>
  );
  return { view, download, Viewer };
}
