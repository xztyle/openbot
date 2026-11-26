import { type AttachmentSummary, type ChannelMessage, channelKind } from "@openbot/contracts/ipc";
import { CHAT_CARD_MARKER } from "@openbot/contracts/portfolio";
import {
  Bell,
  BellOff,
  Bookmark,
  BookmarkMinus,
  Button,
  ChevronRight,
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
import { CondensedNote, createCondensedView } from "@openbot/ui/features/conversation/CondensedNote";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { ArtifactCard } from "@openbot/ui/features/workspace/ArtifactCard";
import { LongMessageFold } from "@openbot/ui/features/workspace/LongMessageFold";
import { DayDivider, NewMessagesDivider } from "@openbot/ui/features/workspace/MessageDividers";
import { MessageRow } from "@openbot/ui/features/workspace/MessageRow";
import type { MessageTargetActions } from "@openbot/ui/features/workspace/message-context-target";
import { StepTrail } from "@openbot/ui/features/workspace/StepTrail";
import type { WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, Show, untrack } from "solid-js";
import { toAgentMessage } from "../../app-message-projection";
import { writeClipboardText } from "../../clipboard";
import { attachmentImageSource, openImageAnnotator } from "../../image-annotator";
import { loadAttachmentPreview } from "../conversation/attachment-preview";
import { WorkspaceChatCard } from "../portfolio/WorkspaceChatCard";
import { attachFilesToComposer } from "./WorkspaceComposer";
import { WorkspaceMessageEditor } from "./WorkspaceMessageEditor";
import { MemberProfile } from "./WorkspaceProfile";
import { useWorkspace } from "./workspace-context";
import { draftKey } from "./workspace-controller";
import { debugMode } from "./workspace-debug";
import { createWorkspaceFileViewer, type WorkspaceFileViewer } from "./workspace-file-viewer";
import {
  memberById,
  mentionsReader,
  messageArtifacts,
  messageAuthor,
  plainMessageSegments,
  previewText,
  reactionViews,
  threadSummaryView,
  type WorkspaceMessageRowModel,
  type WorkspaceStepTrailView,
} from "./workspace-model";

/**
 * Opens the annotator on an image of a message. Send in the annotator fills the box of the current
 * chat: the thread's, when the message is in the thread panel.
 */
function createMessageAnnotator(entry: () => ChannelMessage, inThread: () => boolean) {
  const ws = useWorkspace();
  const { t } = useText();
  const composerKey = () =>
    draftKey(entry().channelId, inThread() ? (ws.state.thread?.rootId ?? entry().threadRootId ?? entry().id) : null);
  return (attachment: AttachmentSummary, url?: string) =>
    openImageAnnotator({
      source: attachmentImageSource(attachment, ws.channels.port(), url),
      onSend: (file) => {
        if (!attachFilesToComposer(composerKey(), [file])) throw new Error(t("workspace.app.composer.attachFailed"));
      },
    });
}

/** The body of a message: Markdown, files and images, as the agent chat draws them. */
export function WorkspaceMessageBody(props: {
  entry: ChannelMessage;
  /** A long text folds to its first lines; the images and files under it always show. */
  fold?: { id: string; enabled: boolean; live: boolean } | undefined;
  /** The message is in the thread panel: an annotated image goes to the thread's box. */
  inThread?: boolean | undefined;
  /** The viewer of the row's files, shared with the row's right-click menu. Absent: the body has its own. */
  viewer?: WorkspaceFileViewer | undefined;
  /** Opens the annotator on an image of the row, shared with the right-click menu. Absent: the body has its own. */
  annotate?: ((attachment: AttachmentSummary, url?: string) => void) | undefined;
}) {
  const ws = useWorkspace();
  const message = createMemo((): AgentMessage => {
    const row = toAgentMessage(
      props.entry.message,
      props.entry.author.kind === "agent" ? props.entry.author.id : undefined,
    );
    // Everyone writes Markdown here, people with the formatting toolbar too. A card's marker draws as
    // its card below the text.
    return { ...row, id: props.entry.id, author: "agent", body: row.body.replace(CHAT_CARD_MARKER, "").trimEnd() };
  });
  const cardId = () => CHAT_CARD_MARKER.exec(props.entry.message.text)?.[1];
  const port = () => ws.channels.port();
  const { t, errorMessage } = useText();
  const annotate =
    props.annotate ??
    createMessageAnnotator(
      () => props.entry,
      () => props.inThread === true,
    );
  const { view, download, Viewer } = props.viewer ?? createWorkspaceFileViewer({ annotate });
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
        onAnnotateImage={annotate}
        mediaSource={port().attachmentMedia}
        foldText={
          props.fold
            ? (text) => (
                <LongMessageFold
                  id={props.fold?.id ?? ""}
                  enabled={props.fold?.enabled === true}
                  live={props.fold?.live === true}
                >
                  {text}
                </LongMessageFold>
              )
            : undefined
        }
      />
      <Show when={cardId()}>{(id) => <WorkspaceChatCard cardId={id()} />}</Show>
      <Viewer />
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
  const annotate = createMessageAnnotator(entry, () => props.inThread === true);
  const viewer = createWorkspaceFileViewer({
    annotate,
    context: () => ({
      files: entry().message.attachments ?? [],
      sender: author().name,
      sentAt: Date.parse(entry().message.createdAt) || undefined,
      link: ws.env.messageLink?.(props.channelId, entry().id, entry().threadRootId ?? null) ?? null,
    }),
  });
  const attachment = (id: string) => entry().message.attachments?.find((candidate) => candidate.id === id);
  /** What a right-click on an image, a file, a link or the author offers, through the same paths as a tap. */
  const targetActions = (): MessageTargetActions => ({
    download: (id) => {
      const file = attachment(id);
      if (file) viewer.download(file);
    },
    openFile: (id) => {
      const file = attachment(id);
      if (file) viewer.view(file);
    },
    copyFileLink: ws.env.messageLink ? () => void viewer.copyLink() : undefined,
    copyFileText: (id) => {
      const file = attachment(id);
      if (!file) return;
      void loadAttachmentPreview(file, {
        previewAttachment: ws.channels.port().previewAttachment,
        media: ws.channels.port().attachmentMedia,
      })
        .then(({ preview }) =>
          navigator.clipboard.writeText(new TextDecoder().decode(preview.bytes ?? new Uint8Array())),
        )
        .then(
          () => toast.success(t("workspace.context.contentsCopied")),
          () => toast.error(t("app.clipboard.copyFailed")),
        );
    },
    openLink: (url) => {
      if (!ws.openLink(url)) void ws.channels.port().openUrl(url);
    },
    annotateImage: ({ attachmentId, src }) => {
      const file = attachmentId ? attachment(attachmentId) : undefined;
      if (file) annotate(file, src);
    },
    directMessage: own() || entry().externalAuthor ? undefined : () => ws.messageMember(entry().author.id),
  });
  const artifacts = createMemo(() =>
    // Attached files already show as file cards; the links to deliverables get a card of their own.
    props.row.pending
      ? []
      : messageArtifacts(ws.directory(), entry(), props.channelName)
          .filter((artifact) => artifact.url)
          // The host's picture of a page that it drew (aprendivo.com, Render, the apps), once per address.
          .map((artifact) => {
            const thumbnailUrl = artifact.url ? ws.artifactThumbnail(artifact.url, props.channelId) : undefined;
            return thumbnailUrl ? { ...artifact, thumbnailUrl } : artifact;
          }),
  );
  /** The host's steps of the turn, with tools and searches; the folded thinking of the messages until then. */
  const trail = createMemo((): WorkspaceStepTrailView | null => {
    // A channel and a thread show the people the answers, not the tools: the steps show in debug mode.
    if (!debugMode()) return null;
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
  /** A long answer of an agent to the people folds to its first lines, as Slack's long posts. */
  const fold = () => {
    const current = entry();
    return {
      id: `${props.channelId}:${current.id}`,
      enabled:
        !debugMode() &&
        current.author.kind === "agent" &&
        !props.row.pending &&
        !deleted() &&
        !note() &&
        !current.message.questionPrompt &&
        // Only text folds: a message of files alone shows them whole.
        current.message.text.trim() !== "" &&
        !editingHere(),
      live: current.message.status === "streaming",
    };
  };
  /** An answer that the host condensed shows its short text, or the agent's own one when opened. */
  const condensed = createCondensedView(() =>
    deleted() ? undefined : (entry().condensed?.original ?? entry().message.condensed?.original),
  );
  const shownEntry = createMemo((): ChannelMessage => {
    const current = entry();
    const original = current.condensed?.original ?? current.message.condensed?.original;
    return original !== undefined && condensed.showingOriginal()
      ? { ...current, message: { ...current.message, text: original } }
      : current;
  });
  /** A plain line takes the light row; Markdown, files and questions take the chat's renderer. */
  // Either text folds to "Show more" the same way: the plain row and the renderer share `fold()`.
  const plain = createMemo(() => (props.row.pending ? null : plainMessageSegments(ws.directory(), shownEntry())));
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
    void writeClipboardText(text).then(
      () => toast.success(done),
      () => toast.error(t("app.clipboard.copyFailed")),
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
        targetActions={targetActions()}
        note={note()}
        fold={fold()}
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
          <WorkspaceMessageBody
            entry={shownEntry()}
            fold={fold()}
            inThread={props.inThread}
            viewer={viewer}
            annotate={annotate}
          />
        </Show>
        <Show when={props.row.progress?.length ? props.row.progress : undefined}>
          {(lines) => <ProgressFold lines={lines()} />}
        </Show>
        <Show when={!props.row.pending && !note() && condensed.condensed()}>
          <CondensedNote showingOriginal={condensed.showingOriginal()} onToggle={condensed.toggle} />
        </Show>
        <Show when={artifacts().length}>
          <div class="ws-message-artifacts">
            <For each={artifacts()} keyed={(artifact) => artifact.id}>
              {(artifact) => (
                <ArtifactCard
                  artifact={artifact()}
                  // A message with its own pictures, such as a share_preview card, keeps its link as a row.
                  compact={
                    artifacts().length > 1 ||
                    Boolean(entry().message.attachments?.some((attachment) => attachment.kind === "image"))
                  }
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

/**
 * The folds that the reader opened, by their first line, for this window's life. A thread or channel
 * opened again shows them open, so the place saved in it points at the same replies.
 */
const openProgressFolds = new Set<string>();

/**
 * The progress lines that an agent posted one after another, folded under the first: "28 more
 * updates" opens them in place. The newest line shows as its own row below.
 */
function ProgressFold(props: { lines: readonly ChannelMessage[] }) {
  const { t, format } = useText();
  const key = () => props.lines[0]?.id ?? "";
  const [open, setOpen] = createSignal(openProgressFolds.has(untrack(key)));
  const toggle = () => {
    const next = !open();
    if (next) openProgressFolds.add(key());
    else openProgressFolds.delete(key());
    setOpen(next);
  };
  return (
    <div class="ws-progress-fold" data-open={open() ? "" : undefined}>
      <Button
        variant="ghost"
        size="xs"
        class="ws-progress-fold-toggle"
        aria-expanded={open() ? "true" : "false"}
        onClick={toggle}
      >
        <ChevronRight aria-hidden="true" />
        {open()
          ? t("workspace.progress.hide", { count: props.lines.length })
          : t("workspace.progress.more", { count: props.lines.length })}
      </Button>
      <Show when={open()}>
        <ol class="ws-progress-fold-lines">
          <For each={props.lines} keyed={(line) => line.id}>
            {(line) => (
              <li>
                <time class="ws-progress-fold-time">
                  {format.date(Date.parse(line().message.createdAt), { timeStyle: "short" })}
                </time>
                {/* One plain line: the Markdown marks of a step ("**Checked** `plans`") do not show. */}
                <span>{previewText(line().message.text, 200)}</span>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
}
