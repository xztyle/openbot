import { channelVisibility } from "@openbot/contracts/ipc";
import { type ActivityItem, ActivityView } from "@openbot/ui/features/workspace/ActivityView";
import { ArtifactsView } from "@openbot/ui/features/workspace/ArtifactsView";
import { FleetView } from "@openbot/ui/features/workspace/FleetView";
import { type ThreadListItem, ThreadsView } from "@openbot/ui/features/workspace/ThreadsView";
import type { WorkspaceView } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import { createEffect, createMemo, Match, Switch } from "solid-js";
import { WorkspaceStorageView } from "./WorkspaceStorageView";
import { useWorkspace } from "./workspace-context";
import { conversationName, memberById, previewText } from "./workspace-model";

/** The views above the channels: Threads, Activity, Fleet, Artifacts and Storage. */
export function WorkspaceViewPane(props: { view: WorkspaceView }) {
  return (
    <Switch>
      <Match when={props.view === "activity"}>
        <WorkspaceActivityView />
      </Match>
      <Match when={props.view === "threads"}>
        <WorkspaceThreadsView />
      </Match>
      <Match when={props.view === "fleet"}>
        <WorkspaceFleetView />
      </Match>
      <Match when={props.view === "artifacts"}>
        <WorkspaceArtifactsView />
      </Match>
      <Match when={props.view === "storage"}>
        <WorkspaceStorageView />
      </Match>
    </Switch>
  );
}

function channelName(ws: ReturnType<typeof useWorkspace>, channelId: string): string | undefined {
  const channel = ws.summary(channelId);
  return channel ? conversationName(ws.directory(), channel) : undefined;
}

function WorkspaceActivityView() {
  const ws = useWorkspace();
  const items = createMemo((): ActivityItem[] =>
    (ws.state.activity.data?.items ?? []).map((item) => {
      const actor: WorkspaceMember =
        item.actor.kind === "external"
          ? { id: item.actor.id, kind: "human", name: item.actor.name, external: true }
          : memberById(ws.directory(), item.actor.id, item.actor.name);
      return {
        id: item.id,
        kind: item.kind,
        actor,
        channelName: channelName(ws, item.channelId),
        preview: item.preview,
        emoji: item.emoji,
        at: Date.parse(item.at),
        unread: item.unread,
      };
    }),
  );
  return (
    <ActivityView
      items={items()}
      onOpen={(id) => {
        const item = ws.state.activity.data?.items.find((candidate) => candidate.id === id);
        if (!item) return;
        if (item.threadRootId) ws.openThread(item.channelId, item.threadRootId);
        else ws.openChannel(item.channelId);
      }}
      onMarkAllRead={
        ws.activityCount() > 0
          ? () => {
              void ws.channels.markAllRead().then(() => ws.refreshActivity());
            }
          : undefined
      }
      onBack={() => ws.back()}
    />
  );
}

function WorkspaceThreadsView() {
  const ws = useWorkspace();
  const threads = createMemo((): ThreadListItem[] =>
    (ws.state.activity.data?.threads ?? []).map((thread) => {
      const channel = ws.summary(thread.channelId);
      return {
        id: `${thread.channelId}/${thread.rootId}`,
        channelName: channelName(ws, thread.channelId) ?? "",
        visibility: channel ? channelVisibility(channel) : "public",
        author: memberById(ws.directory(), thread.rootAuthor.id, thread.rootAuthor.name),
        text: [{ kind: "text", text: previewText(thread.rootText) }],
        replyCount: thread.replyCount,
        lastReplyAt: Date.parse(thread.lastReplyAt),
        participants: thread.participantIds.map((id) => memberById(ws.directory(), id)),
        unreadCount: thread.unreadCount,
      };
    }),
  );
  return (
    <ThreadsView
      threads={threads()}
      onOpen={(id) => {
        const [channelId, rootId] = id.split("/");
        if (channelId && rootId) ws.openThread(channelId, rootId);
      }}
      onBack={() => ws.back()}
    />
  );
}

function WorkspaceFleetView() {
  const ws = useWorkspace();
  return (
    <FleetView
      agents={ws.fleet.agents()}
      onMessage={(agentId) => ws.openAgent(agentId)}
      onAssign={(agentId) => ws.openAgent(agentId)}
      onSettings={(agentId) => ws.env.openAgentSettings(agentId)}
      onAddAgent={ws.env.createAgent}
      onBack={() => ws.back()}
    />
  );
}

/** Opens an artifact: its address, or the file an agent attached. */
export function openArtifact(ws: ReturnType<typeof useWorkspace>, id: string, channelId?: string) {
  const artifact = ws.artifacts.artifacts(channelId ? { channelId } : undefined).find((item) => item.id === id);
  if (artifact?.url) {
    void ws.channels.port().openUrl(artifact.url);
    return;
  }
  const file = ws.artifactRecord(id)?.file;
  const attachmentId = file?.id ?? (id.includes(":attachment:") ? id.split(":attachment:")[1] : undefined);
  if (attachmentId)
    void ws.channels
      .port()
      .agent.openAttachment({ attachmentId, action: "open" })
      .catch(() => undefined);
}

function WorkspaceArtifactsView() {
  const ws = useWorkspace();
  createEffect(
    () => true,
    () => ws.artifacts.refresh?.(),
  );
  return (
    <ArtifactsView
      artifacts={ws.artifacts.artifacts()}
      onOpen={(id) => openArtifact(ws, id)}
      onBack={() => ws.back()}
    />
  );
}

/** The artifacts of one channel, in the right panel. */
export function WorkspaceChannelArtifacts(props: { channelId: string }) {
  const ws = useWorkspace();
  createEffect(
    () => props.channelId,
    (channelId) => ws.artifacts.refresh?.({ channelId }),
  );
  return (
    <ArtifactsView
      artifacts={ws.artifacts.artifacts({ channelId: props.channelId })}
      channelName={channelName(ws, props.channelId)}
      onOpen={(id) => openArtifact(ws, id, props.channelId)}
      onBack={() => ws.back()}
      onClose={() => ws.closePanel()}
    />
  );
}
