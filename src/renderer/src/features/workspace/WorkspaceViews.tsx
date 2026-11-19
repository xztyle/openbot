import { channelKind, channelVisibility } from "@openbot/contracts/ipc";
import { Workflow } from "@openbot/ui";
import { type ActivityItem, ActivityView } from "@openbot/ui/features/workspace/ActivityView";
import { ArtifactsView } from "@openbot/ui/features/workspace/ArtifactsView";
import { FleetView } from "@openbot/ui/features/workspace/FleetView";
import { type ThreadListItem, ThreadsView } from "@openbot/ui/features/workspace/ThreadsView";
import { WorkspacePaneHeader } from "@openbot/ui/features/workspace/WorkspacePaneHeader";
import { WorkspaceSelect } from "@openbot/ui/features/workspace/WorkspaceSelect";
import type { WorkspaceView } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, Match, Show, Switch } from "solid-js";
import { WorkspaceAgentTalkView } from "./WorkspaceAgentTalk";
import { WorkspaceDraftsView } from "./WorkspaceDrafts";
import {
  markThreadsRead,
  WorkspaceDmsView,
  WorkspaceLaterView,
  WorkspaceSearchView,
  WorkspaceUnreadsView,
} from "./WorkspaceInboxViews";
import { WorkspaceNeedsYouSection } from "./WorkspaceNeedsYou";
import { WorkspaceOrgChart } from "./WorkspaceOrgChart";
import { WorkspaceSecretsView } from "./WorkspaceSecrets";
import { WorkspaceSpaceAgentsView } from "./WorkspaceSpaceAgents";
import { WorkspaceStorageView } from "./WorkspaceStorageView";
import { useWorkspace } from "./workspace-context";
import { conversationName, memberById, previewText } from "./workspace-model";

/** The views of the workspace: Unreads, Threads, Activity, Later, DMs, search, Fleet and the views under More. */
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
      <Match when={props.view === "org"}>
        <WorkspaceOrgChart />
      </Match>
      <Match when={props.view === "artifacts"}>
        <WorkspaceArtifactsView />
      </Match>
      <Match when={props.view === "agents"}>
        <WorkspaceAgentTalkView />
      </Match>
      <Match when={props.view === "routines"}>
        <WorkspaceRoutinesView />
      </Match>
      <Match when={props.view === "storage"}>
        <WorkspaceStorageView />
      </Match>
      <Match when={props.view === "secrets"}>
        <WorkspaceSecretsView />
      </Match>
      <Match when={props.view === "space-agents"}>
        <WorkspaceSpaceAgentsView />
      </Match>
      <Match when={props.view === "drafts"}>
        <WorkspaceDraftsView />
      </Match>
      <Match when={props.view === "unreads"}>
        <WorkspaceUnreadsView />
      </Match>
      <Match when={props.view === "later"}>
        <WorkspaceLaterView />
      </Match>
      <Match when={props.view === "dms"}>
        <WorkspaceDmsView />
      </Match>
      <Match when={props.view === "search"}>
        <WorkspaceSearchView />
      </Match>
    </Switch>
  );
}

function channelName(ws: ReturnType<typeof useWorkspace>, channelId: string): string | undefined {
  const channel = ws.summary(channelId);
  return channel ? conversationName(ws.directory(), channel) : undefined;
}

/** Whether a conversation is a DM or a group, which shows without `#`. */
function isDirect(ws: ReturnType<typeof useWorkspace>, channelId: string): boolean {
  const channel = ws.summary(channelId);
  return channel !== undefined && channelKind(channel) !== "channel";
}

function WorkspaceActivityView() {
  const ws = useWorkspace();
  const items = createMemo((): ActivityItem[] =>
    ws.spaceActivity().map((item) => {
      const actor: WorkspaceMember =
        item.actor.kind === "external"
          ? { id: item.actor.id, kind: "human", name: item.actor.name, external: true }
          : memberById(ws.directory(), item.actor.id, item.actor.name);
      return {
        id: item.id,
        kind: item.kind,
        actor,
        // A DM shows as "Direct message", not as "in #Ana".
        channelName: isDirect(ws, item.channelId) ? undefined : channelName(ws, item.channelId),
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
      loading={ws.state.activity.data === null && ws.state.activity.loading}
      failed={ws.state.activity.data === null && ws.state.activity.failed}
      onRetry={() => void ws.refreshActivity()}
      onOpen={(id) => {
        const item = ws.state.activity.data?.items.find((candidate) => candidate.id === id);
        if (!item) return;
        // As in Slack: the exact message opens, scrolled to and marked; a thread reply in its thread.
        if (item.threadRootId) ws.openThread(item.channelId, item.threadRootId);
        else ws.openChannel(item.channelId);
        ws.focusMessage(item.channelId, item.messageId);
      }}
      onMarkAllRead={() => {
        // Only the conversations of the unread items that the list shows, not every channel.
        const channelIds = [...new Set(ws.spaceActivity().flatMap((item) => (item.unread ? [item.channelId] : [])))];
        void ws.channels.markAllRead(channelIds).then(() => ws.refreshActivity());
      }}
      onBack={() => ws.back()}
      needsYou={<WorkspaceNeedsYouSection />}
    />
  );
}

function WorkspaceThreadsView() {
  const ws = useWorkspace();
  const threads = createMemo((): ThreadListItem[] =>
    // Unread threads first, as Slack's; each part newest reply first.
    [...ws.spaceThreads()]
      .sort((left, right) => Number(right.unreadCount > 0) - Number(left.unreadCount > 0))
      .map((thread) => {
        const channel = ws.summary(thread.channelId);
        return {
          id: `${thread.channelId}/${thread.rootId}`,
          channelName: channelName(ws, thread.channelId) ?? "",
          direct: isDirect(ws, thread.channelId),
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
      loading={ws.state.activity.data === null && ws.state.activity.loading}
      failed={ws.state.activity.data === null && ws.state.activity.failed}
      onRetry={() => void ws.refreshActivity()}
      onOpen={(id) => {
        const [channelId, rootId] = id.split("/");
        if (!channelId || !rootId) return;
        ws.openThread(channelId, rootId);
        // Viewing a thread reads it, as in Slack.
        const thread = ws.spaceThreads().find((item) => item.channelId === channelId && item.rootId === rootId);
        if (thread && thread.unreadCount > 0) void markThreadsRead(ws, [thread]);
      }}
      onMarkAllRead={() =>
        void markThreadsRead(
          ws,
          ws.spaceThreads().filter((thread) => thread.unreadCount > 0),
        )
      }
      onBack={() => ws.back()}
    />
  );
}

function WorkspaceFleetView() {
  const ws = useWorkspace();
  return (
    <FleetView
      agents={ws.fleet.agents().filter((agent) => ws.spaces.agentInCurrent(agent.member.id))}
      onMessage={(agentId) => ws.openAgent(agentId)}
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
      artifacts={ws.artifacts
        .artifacts()
        .filter((artifact) =>
          artifact.channelId
            ? ws.spaces.channelInCurrent(artifact.channelId)
            : !artifact.agent || ws.spaces.agentInCurrent(artifact.agent.id),
        )}
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

/** The routine canvas of one agent, with a picker of the agent, in the workspace layout. */
function WorkspaceRoutinesView() {
  const { t } = useText();
  const ws = useWorkspace();
  const options = createMemo(() =>
    ws
      .spaceAgents()
      .filter((agent) => !ws.env.hiddenAgentIds().has(agent.id))
      .map((agent) => ({ value: agent.id, label: agent.name })),
  );
  return (
    <Show when={ws.env.routines}>
      {(routines) => (
        <section class="ws-view ws-routines" aria-label={t("workspace.app.menu.routines")}>
          <WorkspacePaneHeader
            icon={<Workflow aria-hidden="true" />}
            title={t("workspace.app.menu.routines")}
            onBack={() => ws.back()}
            actions={
              <Show when={options().length}>
                <WorkspaceSelect
                  label={t("workspace.routines.agent")}
                  value={routines().agentId() ?? options()[0]?.value ?? ""}
                  options={options()}
                  onChange={(agentId) => routines().selectAgent(agentId)}
                />
              </Show>
            }
          />
          <div class="ws-routines-canvas">{routines().pane({ openAgent: (agentId) => ws.openAgent(agentId) })}</div>
        </section>
      )}
    </Show>
  );
}
