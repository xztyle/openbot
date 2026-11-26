import { type AttachmentSummary, canPreviewAttachment } from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { FilePreviewDialog, type FilePreviewDialogState } from "@openbot/ui/features/conversation/FilePreviewDialog";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { loadArchiveEntryPreview, loadAttachmentPreview } from "../conversation/attachment-preview";
import { useWorkspace } from "./workspace-context";

export interface WorkspaceFileViewer {
  /** A file that the app can show opens in the viewer at once, and fills it when it is read. Any other file downloads. */
  view(attachment: AttachmentSummary): void;
  /** A download says that it started: a file that comes through the host connection takes a while. */
  download(attachment: AttachmentSummary): void;
  /** Copies the link of the message that holds the file. False where the message has no link. */
  copyLink(): boolean;
  /** The viewer, where the owner of this viewer draws it. */
  Viewer: () => JSX.Element;
}

/** The message a file belongs to: its other files, who sent it and when, and its link. */
export interface WorkspaceFileContext {
  files: AttachmentSummary[];
  sender?: string | undefined;
  sentAt?: number | undefined;
  link?: string | null | undefined;
}

interface OpenFile {
  attachment: AttachmentSummary;
  state: FilePreviewDialogState;
  /** A file of an archive that the viewer shows in place of its listing. */
  entry?: { path: string; listing: FilePreviewDialogState } | undefined;
}

/**
 * The viewer of the files of messages and artifacts, as Slack shows a file over the app. `annotate`
 * gives an image viewer an Annotate button. `context` names the message, so the viewer steps through
 * its files and shows who sent them.
 */
export function createWorkspaceFileViewer(
  options: {
    annotate?: ((attachment: AttachmentSummary) => void) | undefined;
    context?: (() => WorkspaceFileContext) | undefined;
  } = {},
): WorkspaceFileViewer {
  const ws = useWorkspace();
  const { t, errorMessage } = useText();
  const port = () => ws.channels.port();
  const [viewer, setViewer] = createSignal<OpenFile | null>(null);
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
  const copyText = (text: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => toast.success(t("workspace.app.message.linkCopied")),
      () => toast.error(t("app.clipboard.copyFailed")),
    );
  const link = () => options.context?.().link ?? null;
  const view = (attachment: AttachmentSummary) => {
    if (!canPreviewAttachment(attachment)) return download(attachment);
    const run = ++viewing;
    const name = attachment.name;
    setViewer({ attachment, state: { status: "loading", name } });
    void loadAttachmentPreview(attachment, {
      previewAttachment: port().previewAttachment,
      media: port().attachmentMedia,
    }).then(
      ({ preview, sourceUrl }) => {
        if (run === viewing) setViewer({ attachment, state: { status: "ready", name, preview, sourceUrl } });
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
  const openEntry = (path: string) => {
    const open = viewer();
    if (!open || open.entry) return;
    const run = ++viewing;
    const listing = open.state;
    const name = path.split("/").filter(Boolean).at(-1) ?? path;
    setViewer({ ...open, entry: { path, listing }, state: { status: "loading", name } });
    void loadArchiveEntryPreview(open.attachment, path, port().attachmentMedia).then(
      (preview) => {
        if (run === viewing)
          setViewer({ ...open, entry: { path, listing }, state: { status: "ready", name, preview, sourceUrl: null } });
      },
      (error: unknown) => {
        if (run === viewing)
          setViewer({
            ...open,
            entry: { path, listing },
            state: { status: "failed", name, message: errorMessage(error, t("attachment.error.preview", { name })) },
          });
      },
    );
  };
  /** Saves the file of an archive that the viewer shows, from the bytes it already has. */
  const downloadEntry = (open: OpenFile) => {
    if (open.state.status !== "ready" || !open.state.preview.bytes) return;
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(open.state.preview.bytes)], { type: "application/octet-stream" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = open.state.name;
    anchor.rel = "noopener";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const siblings = (open: OpenFile) => {
    if (open.entry) return undefined;
    const files = (options.context?.().files ?? []).filter(canPreviewAttachment);
    const index = files.findIndex((file) => file.id === open.attachment.id);
    if (index < 0 || files.length < 2) return undefined;
    const step = (by: number) => {
      const next = files[(index + by + files.length) % files.length];
      if (next) view(next);
    };
    return { index, count: files.length, previous: () => step(-1), next: () => step(1) };
  };
  const Viewer = () => (
    <Show when={viewer()}>
      {(open) => (
        <FilePreviewDialog
          state={open().state}
          agents={ws.env.agents()}
          meta={{ sender: options.context?.().sender, sentAt: options.context?.().sentAt }}
          siblings={siblings(open())}
          onCopyLink={link() ? () => copyText(link() ?? "") : undefined}
          onOpenArchiveEntry={openEntry}
          onBack={
            open().entry
              ? () => {
                  viewing += 1;
                  const current = open();
                  if (current.entry) setViewer({ attachment: current.attachment, state: current.entry.listing });
                }
              : undefined
          }
          onOpenLink={(url) => {
            if (!ws.openLink(url)) void port().openUrl(url);
          }}
          onDownload={() => (open().entry ? downloadEntry(open()) : download(open().attachment))}
          onAnnotate={options.annotate && !open().entry ? () => options.annotate?.(open().attachment) : undefined}
          onOpenExternally={
            port().fileActions === "native" && !open().entry
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
  const copyLink = () => {
    const value = link();
    if (value) copyText(value);
    return Boolean(value);
  };
  return { view, download, copyLink, Viewer };
}
