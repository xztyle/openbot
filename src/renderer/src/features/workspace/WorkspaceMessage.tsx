import { type AttachmentSummary, type ChannelMessage, canPreviewAttachment, channelKind } from "@openbot/contracts/ipc";
import {
  Bell,
  BellOff,
  Bookmark,
  BookmarkMinus,
  CircleDot,
  Copy,
  Link,
  MessageSquareReply,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  toast,
} from "@openbot/ui";
import type { AgentMessage } from "@openbot/ui/data";
import { FilePreviewDialog, type FilePreviewDialogState } from "@openbot/ui/features/conversation/FilePreviewDialog";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { ArtifactCard } from "@openbot/ui/features/workspace/ArtifactCard";
import { DayDivider, NewMessagesDivider } from "@openbot/ui/features/workspace/MessageDividers";
import { MessageRow } from "@openbot/ui/features/workspace/MessageRow";
import { StepTrail } from "@openbot/ui/features/workspace/StepTrail";
import type { WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, Show } from "solid-js";
import { toAgentMessage } from "../../app-message-projection";
import { attachmentFilePreview } from "../conversation/attachment-preview";
import { WorkspaceMessageEditor } from "./WorkspaceMessageEditor";
import { MemberProfile } from "./WorkspaceProfile";
import { useWorkspace } from "./workspace-context";
import {
  memberById,
  mentionsReader,
  messageArtifacts,
  messageAuthor,
  plainMessageSegments,
  reactionViews,
  threadSummaryView,
  type WorkspaceMessageRowModel,
  type WorkspaceStepTrailView,
} from "./workspace-model";

/** The body of a message: Markdown, files and images, as the agent chat draws them. */
export function WorkspaceMessageBody(props: { entry: ChannelMessage }) {
  const ws = useWorkspace();
  const message = createMemo((): AgentMessage => {
    const row = toAgentMessage(
      props.entry.message,
      props.entry.author.kind === "agent" ? props.entry.author.id : undefined,
    );
    // Everyone writes Markdown here, people with the formatting toolbar too.
    return { ...row, id: props.entry.id, author: "agent" };
  });
  const port = () => ws.channels.port();
  const { t, errorMessage } = useText();
  const [viewer, setViewer] = createSignal<{ attachment: AttachmentSummary; state: FilePreviewDialogState } | null>(
    null,
  );
  let viewing = 0;
  /** A download says that it started: a file that comes through the host connection takes a while. */
  const download = (attachment: AttachmentSummary) => {
    const progress = toast.loading(t("attachment.downloading", { name: attachment.name }));
    void port()
      .agent.openAttachment({ attachmentId: attachment.id, action: "download" })
      .then(
        () => toast.dismiss(progress),
        (error: unknown) => toast.error(errorMessage(error, t("attachment.error.open")), { id: progress }),
      );
  };
  /** A file that the app can show opens in the viewer at once, and fills it when it is read. */
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
  const attachmentAction = (attachment: AttachmentSummary, action: "open" | "reveal" | "download") => {
    if (action === "open") return view(attachment);
    if (action === "download") return download(attachment);
    void port()
      .agent.openAttachment({ attachmentId: attachment.id, action })
      .catch((error: unknown) => toast.error(errorMessage(error, t("attachment.error.open"))));
  };
  return (
    <div class="ws-message-content">
      <MessageBody
        message={message()}
        agents={ws.env.agents()}
        onSelectAgent={(agentId) => ws.openAgent(agentId)}
        onOpenLink={(url) => {
          if (!ws.openLink(url)) void port().openUrl(url);
        }}
        onPreview={view}
        onAttachmentAction={attachmentAction}
        onDownload={download}
        mediaSource={port().attachmentMedia}
      />
      <Show when={viewer()}>
        {(open) => (
          <FilePreviewDialog
            state={open().state}
            agents={ws.env.agents()}
            onOpenLink={(url) => {
              if (!ws.openLink(url)) void port().openUrl(url);
            }}
            onDownload={() => download(open().attachment)}
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
    </div>
  );
}

export interface WorkspaceMessageProps {
  row: WorkspaceMessageRowModel;
  channelId: string;
  channelName: string;
  /** The row is in a thread panel: no thread summary, and replies open nothing. */
  inThread?: boolean;
  /** The root of the open thread, lit in the transcript. */
  highlighted?: boolean;
}

/** One message of the workspace, as a Slack row with its steps, artifacts, reactions and thread. */
export function WorkspaceMessage(props: WorkspaceMessageProps) {
  const { t, errorMessage } = useText();
  const ws = useWorkspace();
  const entry = () => props.row.entry;
  const author = createMemo(() => messageAuthor(ws.directory(), entry()));
  const own = () => entry().author.kind === "member" && !entry().externalAuthor && ws.env.isReader(entry().author.id);
  const deleted = () => Boolean(entry().deletedAt);
  const artifacts = createMemo(() =>
    // Attached files already show as file cards; the links to deliverables get a card of their own.
    props.row.pending
      ? []
      : messageArtifacts(ws.directory(), entry(), props.channelName).filter((artifact) => artifact.url),
  );
  /** The host's steps of the turn, with tools and searches; the folded thinking of the messages until then. */
  const trail = createMemo((): WorkspaceStepTrailView | null => {
    const current = entry();
    if (current.author.kind !== "agent" || current.deletedAt || !current.message.turnId) return props.row.steps;
    const host = ws.steps(props.channelId, current.id);
    if (!host) return props.row.steps;
    return {
      steps: host.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        label: step.label,
        detail: step.detail,
        status: step.status,
        durationMs: step.durationMs,
      })),
      durationMs: host.durationMs || undefined,
      streaming: host.streaming,
    };
  });
  /** Agents talking to each other: the row folds to one line that opens the text. */
  const note = createMemo(() => {
    const current = props.row.note;
    if (!current || props.row.pending || deleted()) return undefined;
    return {
      recipients: current.to.map((id) => memberById(ws.directory(), id)),
      summary: current.summary,
      expandable: current.expandable,
    };
  });
  /** A plain line takes the light row; Markdown, files and questions take the chat's renderer. */
  const plain = createMemo(() => (props.row.pending ? null : plainMessageSegments(ws.directory(), entry())));
  const threadRootId = () => (props.inThread ? (entry().threadRootId ?? null) : null);
  /** The thread that "Mark unread" moves in: in the thread panel the root's thread too. */
  const readThread = () => (props.inThread ? (entry().threadRootId ?? entry().id) : null);
  /** The reader's state in the thread that this message starts, in the channel transcript. */
  const ownThread = () =>
    props.inThread || entry().threadRootId ? undefined : ws.marks.thread(props.channelId, entry().id);
  const savedForLater = () => ws.marks.saved(props.channelId, entry().id) === "saved";
  const pinnedBy = () => {
    const pin = entry().pinned;
    return pin ? memberById(ws.directory(), pin.by.id).name : undefined;
  };
  const inChannel = () => {
    const current = ws.summary(props.channelId);
    return current ? channelKind(current) === "channel" : true;
  };
  /** Runs a mark change; a failure shows why. */
  const act = (action: () => Promise<void>) =>
    void action().catch((error: unknown) => toast.error(errorMessage(error, t("workspace.message.actionFailed"))));
  /** Slack's edit in place, on a computer. A phone edits in the composer, as Slack's app does. */
  const editingHere = () => {
    const editing = ws.state.editing;
    return (
      !ws.env.phone() &&
      editing?.channelId === props.channelId &&
      editing.messageId === entry().id &&
      // The root of a thread shows in the channel and in the panel: the edit stays where it began.
      editing.threadRootId === threadRootId()
    );
  };
  const copy = (text: string, done: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => toast.success(done),
      () => undefined,
    );
  const menuItems = createMemo((): WorkspaceMenuItem[] => {
    if (props.row.pending || deleted()) return [];
    const items: WorkspaceMenuItem[] = [];
    if (!props.inThread && !entry().threadRootId)
      items.push({
        id: "reply",
        label: t("workspace.message.reply"),
        icon: <MessageSquareReply aria-hidden="true" />,
        onSelect: () => ws.openThread(props.channelId, entry().id),
      });
    // Slack's order: follow, mark unread, save, copy, pin, then the changes to the reader's own
    // message, delete last.
    const thread = ownThread();
    if (thread && ws.marks.supports.follow())
      items.push({
        id: "follow",
        label: t(thread.followed ? "workspace.thread.unfollow" : "workspace.thread.follow"),
        icon: thread.followed ? <BellOff aria-hidden="true" /> : <Bell aria-hidden="true" />,
        onSelect: () => act(() => ws.marks.setFollowed(props.channelId, entry().id, !thread.followed)),
      });
    if (ws.marks.supports.markUnread())
      items.push({
        id: "mark-unread",
        label: t("workspace.message.markUnread"),
        icon: <CircleDot aria-hidden="true" />,
        onSelect: () => act(() => ws.marks.markUnread(props.channelId, entry().id, readThread())),
      });
    if (ws.marks.supports.saved())
      items.push({
        id: "save",
        label: t(savedForLater() ? "workspace.message.unsave" : "workspace.message.save"),
        icon: savedForLater() ? <BookmarkMinus aria-hidden="true" /> : <Bookmark aria-hidden="true" />,
        onSelect: () => act(() => ws.marks.setSaved(props.channelId, entry().id, !savedForLater())),
      });
    items.push({
      id: "copy-text",
      label: t("workspace.app.message.copyText"),
      icon: <Copy aria-hidden="true" />,
      onSelect: () => copy(entry().message.text, t("workspace.app.message.copied")),
    });
    const link = ws.env.messageLink?.(props.channelId, entry().id, entry().threadRootId ?? null);
    if (link)
      items.push({
        id: "copy-link",
        label: t("workspace.app.message.copyLink"),
        icon: <Link aria-hidden="true" />,
        onSelect: () => copy(link, t("workspace.app.message.linkCopied")),
      });
    const pinned = Boolean(entry().pinned);
    if (ws.marks.supports.pins() && !ws.summary(props.channelId)?.archived)
      items.push({
        id: "pin",
        label: t(
          pinned
            ? inChannel()
              ? "workspace.message.unpinChannel"
              : "workspace.message.unpinConversation"
            : inChannel()
              ? "workspace.message.pinChannel"
              : "workspace.message.pinConversation",
        ),
        icon: pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />,
        onSelect: () => act(() => ws.marks.setPinned(props.channelId, entry().id, !pinned)),
      });
    if (own() && (entry().message.text.trim() || entry().message.attachments?.length))
      items.push({
        id: "edit",
        label: t("workspace.app.message.edit"),
        icon: <Pencil aria-hidden="true" />,
        onSelect: () => ws.startEditing(props.channelId, entry().id, threadRootId()),
      });
    if (own() || ws.isAdmin())
      items.push({
        id: "delete",
        label: t("workspace.app.message.delete"),
        icon: <Trash2 aria-hidden="true" />,
        danger: true,
        onSelect: () =>
          ws.openDialog({
            kind: "delete-message",
            channelId: props.channelId,
            messageId: entry().id,
            threadRootId: threadRootId(),
          }),
      });
    return items;
  });
  return (
    <>
      <Show when={props.row.dayStart}>{(at) => <DayDivider date={at()} />}</Show>
      <Show when={props.row.firstUnread}>
        <NewMessagesDivider />
      </Show>
      <MessageRow
        author={author()}
        sentAt={Date.parse(entry().message.createdAt)}
        text={plain() ?? undefined}
        grouped={props.row.grouped}
        edited={Boolean(entry().editedAt)}
        deleted={deleted()}
        highlighted={props.highlighted}
        mentionsReader={!props.row.pending && mentionsReader(ws.directory(), entry())}
        pinnedBy={props.row.pending ? undefined : pinnedBy()}
        saved={!props.row.pending && savedForLater()}
        reactions={reactionViews(ws.directory(), entry().reactions)}
        quickReactions={ws.quickReactions()}
        emojiPicker={ws.reactionPicker}
        onToggleReaction={
          props.row.pending || deleted()
            ? undefined
            : (emoji) => void ws.toggleReaction(props.channelId, entry().id, emoji)
        }
        thread={
          props.inThread
            ? undefined
            : (() => {
                const summary = threadSummaryView(ws.directory(), entry());
                return summary ? { ...summary, unread: (ownThread()?.unreadCount ?? 0) > 0 } : undefined;
              })()
        }
        onOpenThread={
          props.inThread || props.row.pending || entry().threadRootId
            ? undefined
            : () => ws.openThread(props.channelId, entry().id)
        }
        repliedTo={
          props.row.broadcast
            ? {
                text: props.row.broadcast.rootText,
                onOpen: () => {
                  const rootId = props.row.broadcast?.rootId;
                  if (!rootId) return;
                  // As Slack's "replied to a thread": the thread opens with this reply lit.
                  ws.openThread(props.channelId, rootId);
                  ws.focusMessage(props.channelId, entry().id);
                },
              }
            : undefined
        }
        menuItems={menuItems()}
        note={note()}
        profile={() => <MemberProfile member={author()} />}
        editor={
          editingHere() ? (
            <WorkspaceMessageEditor channelId={props.channelId} entry={entry()} threadRootId={threadRootId()} />
          ) : undefined
        }
      >
        <Show when={trail()}>
          {(steps) => (
            <StepTrail
              steps={steps().steps}
              durationMs={steps().durationMs}
              streaming={steps().streaming}
              defaultOpen={props.row.pending}
            />
          )}
        </Show>
        <Show when={!props.row.pending && !plain()}>
          <WorkspaceMessageBody entry={entry()} />
        </Show>
        <Show when={artifacts().length}>
          <div class="ws-message-artifacts">
            <For each={artifacts()} keyed={(artifact) => artifact.id}>
              {(artifact) => (
                <ArtifactCard
                  artifact={artifact()}
                  compact={artifacts().length > 1}
                  onOpen={() => {
                    const url = artifact().url;
                    if (url) void ws.channels.port().openUrl(url);
                  }}
                />
              )}
            </For>
          </div>
        </Show>
      </MessageRow>
    </>
  );
}
