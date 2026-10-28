import type { AttachmentSummary, ChannelMessage } from "@openbot/contracts/ipc";
import { Copy, Link, MessageSquareReply, Pencil, Trash2, toast } from "@openbot/ui";
import type { AgentMessage } from "@openbot/ui/data";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { ArtifactCard } from "@openbot/ui/features/workspace/ArtifactCard";
import { DayDivider, NewMessagesDivider } from "@openbot/ui/features/workspace/MessageDividers";
import { MessageRow } from "@openbot/ui/features/workspace/MessageRow";
import { StepTrail } from "@openbot/ui/features/workspace/StepTrail";
import type { WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createMemo, For, Show } from "solid-js";
import { toAgentMessage } from "../../app-message-projection";
import { MemberProfile } from "./WorkspaceProfile";
import { useWorkspace } from "./workspace-context";
import {
  mentionsReader,
  messageArtifacts,
  messageAuthor,
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
  const attachmentAction = (attachment: AttachmentSummary, action: "open" | "reveal" | "download") =>
    void port()
      .agent.openAttachment({ attachmentId: attachment.id, action })
      .catch(() => undefined);
  return (
    <div class="ws-message-content">
      <MessageBody
        message={message()}
        agents={ws.env.agents()}
        onSelectAgent={(agentId) => ws.openAgent(agentId)}
        onOpenLink={(url) => void port().openUrl(url)}
        onPreview={(attachment) => attachmentAction(attachment, "open")}
        onAttachmentAction={attachmentAction}
        onDownload={(attachment) => attachmentAction(attachment, "download")}
        mediaSource={port().attachmentMedia}
      />
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
  const { t } = useText();
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
  const threadRootId = () => (props.inThread ? (entry().threadRootId ?? null) : null);
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
    if (own() && entry().message.text.trim())
      items.push({
        id: "edit",
        label: t("workspace.app.message.edit"),
        icon: <Pencil aria-hidden="true" />,
        onSelect: () => ws.startEditing(props.channelId, entry().id, threadRootId()),
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
        grouped={props.row.grouped}
        edited={Boolean(entry().editedAt)}
        deleted={deleted()}
        highlighted={props.highlighted}
        mentionsReader={!props.row.pending && mentionsReader(ws.directory(), entry())}
        reactions={reactionViews(ws.directory(), entry().reactions)}
        onToggleReaction={
          props.row.pending || deleted()
            ? undefined
            : (emoji) => void ws.toggleReaction(props.channelId, entry().id, emoji)
        }
        thread={props.inThread ? undefined : threadSummaryView(ws.directory(), entry())}
        onOpenThread={
          props.inThread || props.row.pending || entry().threadRootId
            ? undefined
            : () => ws.openThread(props.channelId, entry().id)
        }
        menuItems={menuItems()}
        profile={() => <MemberProfile member={author()} />}
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
        <Show when={!props.row.pending}>
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
