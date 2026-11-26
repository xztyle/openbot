import { type AttachmentSummary, canPreviewAttachment, type FileReferenceTarget } from "@openbot/contracts/ipc";
import type { ArchiveListing } from "@openbot/contracts/team-protocol/attachment-renditions-v1";
import { toast } from "@openbot/ui";
import type { AgentProfile } from "@openbot/ui/data";
import { FilePreviewDialog, type FilePreviewDialogState } from "@openbot/ui/features/conversation/FilePreviewDialog";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import type { ChannelsPort } from "../channels/channels-port";
import { loadArchiveEntryPreview, loadAttachmentPreview } from "../conversation/attachment-preview";
import { useWorkspace } from "./workspace-context";

export interface WorkspaceFileViewer {
  /** A file that the app can show opens in the viewer at once, and fills it when it is read. Any other file downloads. */
  view(attachment: AttachmentSummary): void;
  /**
   * A path or a file name that a message names opens in the viewer: the host finds it, a file as an
   * attachment and a folder as a listing whose files open in the same viewer. `agentId` is the agent
   * whose message it is. A file the reader may not open shows the host's plain sentence.
   */
  viewReference(path: string, agentId: string | null): void;
  /**
   * A path or a file name that a message's text names: the message's own file of that name opens, as
   * the host attached it; any other is looked up with `viewReference`.
   */
  viewNamed(
    path: string,
    message: { attachments?: readonly AttachmentSummary[] | undefined; agentId: string | null },
  ): void;
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

/** What the viewer reaches on its host: the same port on desktop, web and phone. */
export type FileViewerPort = Pick<ChannelsPort, "previewAttachment" | "attachmentMedia" | "fileActions" | "openUrl"> & {
  agent: Pick<ChannelsPort["agent"], "openAttachment" | "openFileReference">;
};

export interface FileViewerOptions {
  port: () => FileViewerPort;
  agents: () => AgentProfile[];
  /** Opens a link of a file, such as one in a Markdown file. */
  openLink: (url: string) => void;
  annotate?: ((attachment: AttachmentSummary) => void) | undefined;
  context?: (() => WorkspaceFileContext) | undefined;
}

/** A folder that a message names, shown as the listing of an archive. */
interface OpenFolder {
  agentId: string | null;
  /** The host path of each file of the listing, by its path in the listing. */
  paths: ReadonlyMap<string, string>;
}

interface OpenFile {
  /** Null for a folder, which is no attachment. */
  attachment: AttachmentSummary | null;
  state: FilePreviewDialogState;
  folder?: OpenFolder | undefined;
  /** A file of an archive or a folder that the viewer shows in place of its listing. */
  entry?: { path: string; listing: FilePreviewDialogState; attachment?: AttachmentSummary | undefined } | undefined;
}

const nameOf = (path: string) => path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;

/** The listing of a folder in the archive listing shape, so the viewer shows it as an archive's tree. */
function folderListing(target: Extract<FileReferenceTarget, { kind: "folder" }>) {
  const listing: ArchiveListing = {
    entries: target.entries.map((entry) => ({
      path: entry.kind === "directory" ? `${entry.name}/` : entry.name,
      size: entry.size,
      directory: entry.kind === "directory",
    })),
    truncated: target.truncated,
  };
  return {
    bytes: new TextEncoder().encode(JSON.stringify(listing)),
    paths: new Map(target.entries.map((entry) => [entry.name, entry.path])),
  };
}

/**
 * The viewer of the files of messages and artifacts, as Slack shows a file over the app. `annotate`
 * gives an image viewer an Annotate button. `context` names the message, so the viewer steps through
 * its files and shows who sent them. It reaches the host only through `port`.
 */
export function createFileViewer(options: FileViewerOptions): WorkspaceFileViewer {
  const { t, errorMessage } = useText();
  const port = options.port;
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
  const failed = (name: string, error: unknown): FilePreviewDialogState => ({
    status: "failed",
    name,
    message: errorMessage(error, t("attachment.error.preview", { name })),
  });
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
        if (run === viewing) setViewer({ attachment, state: failed(name, error) });
      },
    );
  };
  const viewReference = (path: string, agentId: string | null) => {
    const run = ++viewing;
    const name = nameOf(path);
    setViewer({ attachment: null, state: { status: "loading", name } });
    void port()
      .agent.openFileReference({ agentId, path })
      .then(
        (target) => {
          if (run !== viewing) return;
          if (target.kind === "file") return view(target.attachment);
          const listing = folderListing(target);
          setViewer({
            attachment: null,
            folder: { agentId, paths: listing.paths },
            state: {
              status: "ready",
              name: target.name,
              preview: {
                name: target.name,
                size: 0,
                mimeType: "application/json",
                previewKind: "archive",
                bytes: listing.bytes,
              },
              sourceUrl: null,
            },
          });
        },
        (error: unknown) => {
          if (run === viewing) setViewer({ attachment: null, state: failed(name, error) });
        },
      );
  };
  const viewNamed = (
    path: string,
    message: { attachments?: readonly AttachmentSummary[] | undefined; agentId: string | null },
  ) => {
    const folder = /[/\\]$/u.test(path);
    const attached = folder ? undefined : message.attachments?.find((attachment) => attachment.name === nameOf(path));
    if (attached) view(attached);
    else viewReference(path, message.agentId);
  };
  /** A file of a folder that the viewer lists: the host gives it as an attachment, as any named file. */
  const openFolderEntry = (open: OpenFile, folder: OpenFolder, entryPath: string) => {
    const hostPath = folder.paths.get(entryPath);
    if (!hostPath) return;
    const run = ++viewing;
    const listing = open.state;
    const name = nameOf(entryPath);
    const show = (state: FilePreviewDialogState, attachment?: AttachmentSummary) =>
      run === viewing && setViewer({ ...open, entry: { path: entryPath, listing, attachment }, state });
    show({ status: "loading", name });
    void port()
      .agent.openFileReference({ agentId: folder.agentId, path: hostPath })
      .then(async (target) => {
        if (target.kind !== "file") throw new Error(t("attachment.previewUnavailable"));
        const { preview, sourceUrl } = await loadAttachmentPreview(target.attachment, {
          previewAttachment: port().previewAttachment,
          media: port().attachmentMedia,
        });
        show({ status: "ready", name, preview, sourceUrl }, target.attachment);
      })
      .catch((error: unknown) => show(failed(name, error)));
  };
  const openEntry = (path: string) => {
    const open = viewer();
    if (!open || open.entry) return;
    if (open.folder) return openFolderEntry(open, open.folder, path);
    const attachment = open.attachment;
    if (!attachment) return;
    const run = ++viewing;
    const listing = open.state;
    const name = nameOf(path);
    setViewer({ ...open, entry: { path, listing }, state: { status: "loading", name } });
    void loadArchiveEntryPreview(attachment, path, port().attachmentMedia).then(
      (preview) => {
        if (run === viewing)
          setViewer({ ...open, entry: { path, listing }, state: { status: "ready", name, preview, sourceUrl: null } });
      },
      (error: unknown) => {
        if (run === viewing) setViewer({ ...open, entry: { path, listing }, state: failed(name, error) });
      },
    );
  };
  /** Saves the file of an archive that the viewer shows, from the bytes it already has. */
  const downloadEntry = (open: OpenFile) => {
    if (open.entry?.attachment) return download(open.entry.attachment);
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
  const downloadOpen = (open: OpenFile) => {
    if (open.entry) return downloadEntry(open);
    if (open.attachment) return download(open.attachment);
    if (open.folder) toast.info(t("chat.file.folderDownload"));
  };
  const siblings = (open: OpenFile) => {
    if (open.entry || !open.attachment) return undefined;
    const files = (options.context?.().files ?? []).filter(canPreviewAttachment);
    const current = open.attachment;
    const index = files.findIndex((file) => file.id === current.id);
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
          agents={options.agents()}
          meta={{ sender: options.context?.().sender, sentAt: options.context?.().sentAt }}
          siblings={siblings(open())}
          onCopyLink={link() ? () => copyText(link() ?? "") : undefined}
          onOpenArchiveEntry={openEntry}
          onBack={
            open().entry
              ? () => {
                  viewing += 1;
                  const current = open();
                  if (current.entry)
                    setViewer({ attachment: current.attachment, folder: current.folder, state: current.entry.listing });
                }
              : undefined
          }
          onOpenLink={options.openLink}
          onDownload={() => downloadOpen(open())}
          onAnnotate={
            options.annotate && !open().entry && open().attachment
              ? () => {
                  const attachment = open().attachment;
                  if (attachment) options.annotate?.(attachment);
                }
              : undefined
          }
          onOpenExternally={
            port().fileActions === "native" && !open().entry && open().attachment
              ? () => {
                  const attachment = open().attachment;
                  if (!attachment) return;
                  void port()
                    .agent.openAttachment({ attachmentId: attachment.id, action: "open" })
                    .catch((error: unknown) => toast.error(errorMessage(error, t("attachment.error.open"))));
                }
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
  return { view, viewReference, viewNamed, download, copyLink, Viewer };
}

/** The file viewer of the workspace: the workspace's host port, agents and links. */
export function createWorkspaceFileViewer(
  options: {
    annotate?: ((attachment: AttachmentSummary) => void) | undefined;
    context?: (() => WorkspaceFileContext) | undefined;
  } = {},
): WorkspaceFileViewer {
  const ws = useWorkspace();
  return createFileViewer({
    ...options,
    port: () => ws.channels.port(),
    agents: () => ws.env.agents(),
    openLink: (url) => {
      if (!ws.openLink(url)) void ws.channels.port().openUrl(url);
    },
  });
}
