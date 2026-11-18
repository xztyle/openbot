import { MessageMentionsContext } from "@openbot/ui/features/conversation/message-mentions";
import { ChannelHeader } from "@openbot/ui/features/workspace/ChannelHeader";
import { WorkspaceContextMenu } from "@openbot/ui/features/workspace/WorkspaceContextMenu";
import { WorkspaceLayout } from "@openbot/ui/features/workspace/WorkspaceLayout";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createMemo, Match, type ParentProps, Show, Switch } from "solid-js";
import { type ConversationRowLayout, ConversationRowLayoutContext } from "../conversation/conversation-row-layout";
import { WorkspaceChannelPane } from "./WorkspaceChannelPane";
import { WorkspaceDetailsPanel } from "./WorkspaceDetailsPanel";
import { WorkspaceDialogs } from "./WorkspaceDialogs";
import { MemberProfile } from "./WorkspaceProfile";
import { useWorkspaceMenu } from "./WorkspaceSidebarPane";
import { WorkspaceThreadPanel } from "./WorkspaceThreadPanel";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
import { WorkspaceChannelArtifacts, WorkspaceViewPane } from "./WorkspaceViews";
import { WorkspaceWelcome } from "./WorkspaceWelcome";
import { useWorkspace } from "./workspace-context";
import { agentMember, agentWorking, memberById } from "./workspace-model";
import { WorkspaceKeyboard } from "./workspace-shortcuts";

/** Highlights mentions of the reader and opens `#channel` links in every message of the workspace. */
export function WorkspaceMentions(props: ParentProps) {
  const ws = useWorkspace();
  return (
    <MessageMentionsContext
      value={{ isReader: (id) => ws.env.isReader(id), onOpenChannel: (channelId) => ws.openChannel(channelId) }}
    >
      {props.children}
    </MessageMentionsContext>
  );
}

/** The workspace's middle and right panes: a conversation or a view, and the thread or details. */
export function WorkspaceMain() {
  const ws = useWorkspace();
  const { t } = useText();
  const workspaceMenu = useWorkspaceMenu();
  const panel = createMemo((): JSX.Element | undefined => {
    const current = ws.state.panel;
    if (!current) return undefined;
    if (current.kind === "thread")
      return <WorkspaceThreadPanel channelId={current.channelId} rootId={current.rootId} />;
    if (current.kind === "details") return <WorkspaceDetailsPanel channelId={current.channelId} />;
    return <WorkspaceChannelArtifacts channelId={current.channelId} />;
  });
  return (
    <WorkspaceMentions>
      {/* Where nothing nearer has a right-click menu, the workspace's own actions show. */}
      <WorkspaceContextMenu
        items={workspaceMenu}
        label={t("workspace.sidebar.workspaceMenu", { name: ws.env.serverName() })}
      >
        <div class="ws-main-frame">
          <WorkspaceTopBar />
          <WorkspaceLayout
            class="ws-main-layout"
            sidebar={null}
            sidebarCollapsed
            phonePane={ws.state.phonePane === "panel" ? "panel" : "main"}
            main={
              <Switch>
                <Match
                  when={(() => {
                    const route = ws.route();
                    return route.kind === "channel" ? route.channelId : undefined;
                  })()}
                  keyed
                >
                  {(channelId) => <WorkspaceChannelPane channelId={channelId} />}
                </Match>
                <Match
                  when={(() => {
                    const route = ws.route();
                    return route.kind === "view" ? route.view : undefined;
                  })()}
                  keyed
                >
                  {(view) => (
                    // A new workspace opens on its welcome until it has a channel or the reader picks a view.
                    <Show
                      when={ws.workspaceEmpty() && ws.state.view === null}
                      fallback={<WorkspaceViewPane view={view} />}
                    >
                      <WorkspaceWelcome />
                    </Show>
                  )}
                </Match>
              </Switch>
            }
            panel={panel()}
          />
        </div>
      </WorkspaceContextMenu>
    </WorkspaceMentions>
  );
}

/** What every workspace shell mounts once: the dialogs and the shortcuts. */
export function WorkspaceChrome() {
  return (
    <WorkspaceMentions>
      <WorkspaceKeyboard />
      <WorkspaceDialogs />
    </WorkspaceMentions>
  );
}

/**
 * The owner's DM with an agent: its main chat, with steps and reasoning, under a DM header. The
 * chat's own toolbar (model, panels) stays below the header. Its messages are workspace rows.
 */
export function WorkspaceAgentFrame(props: ParentProps<{ agentId: string }>) {
  const ws = useWorkspace();
  const { t } = useText();
  const workspaceMenu = useWorkspaceMenu();
  const agent = () => ws.env.agents().find((candidate) => candidate.id === props.agentId);
  const rows: ConversationRowLayout = {
    reader: () => {
      const reader = ws.env.reader();
      if (reader.id) return memberById(ws.directory(), reader.id);
      // A computer with no account: the reader has a name and maybe a photo, but no member id.
      return {
        id: "local",
        kind: "human",
        name: reader.name || t("chat.message.you"),
        avatarUrl: reader.avatarUrl,
        presence: "active",
      };
    },
    member: (id, fallbackName) => memberById(ws.directory(), id, fallbackName),
    profile: (member) => <MemberProfile member={member} />,
    quickReactions: () => ws.quickReactions(),
    emojiPicker: ws.reactionPicker,
  };
  return (
    <ConversationRowLayoutContext value={rows}>
      <WorkspaceContextMenu
        items={workspaceMenu}
        label={t("workspace.sidebar.workspaceMenu", { name: ws.env.serverName() })}
      >
        <section class="ws-agent-dm">
          <WorkspaceTopBar />
          <Show when={agent()}>
            {(current) => (
              <ChannelHeader
                class="ws-agent-dm-header"
                kind="dm"
                name={current().name}
                dmMember={agentMember(current(), agentWorking(ws.directory(), current().id))}
                topic={current().title || undefined}
                members={[]}
                memberCount={1}
                onShowDetails={() => ws.env.openAgentSettings(current().id)}
                onBack={() => ws.back()}
              />
            )}
          </Show>
          <div class="ws-agent-dm-body">{props.children}</div>
        </section>
      </WorkspaceContextMenu>
    </ConversationRowLayoutContext>
  );
}
