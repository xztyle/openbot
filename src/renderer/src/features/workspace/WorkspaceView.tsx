import { MessageMentionsContext } from "@openbot/ui/features/conversation/message-mentions";
import { ChannelHeader } from "@openbot/ui/features/workspace/ChannelHeader";
import { WorkspaceLayout } from "@openbot/ui/features/workspace/WorkspaceLayout";
import type { JSX } from "@solidjs/web";
import { createMemo, Match, onSettled, type ParentProps, Show, Switch } from "solid-js";
import { WorkspaceChannelPane } from "./WorkspaceChannelPane";
import { WorkspaceDetailsPanel } from "./WorkspaceDetailsPanel";
import { WorkspaceDialogs } from "./WorkspaceDialogs";
import { WorkspaceThreadPanel } from "./WorkspaceThreadPanel";
import { WorkspaceChannelArtifacts, WorkspaceViewPane } from "./WorkspaceViews";
import { useWorkspace } from "./workspace-context";
import { agentMember, agentWorking } from "./workspace-model";

/** Whether a key press comes from a field the reader types in. */
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  );
}

/**
 * The workspace shortcuts: ⌘K or Ctrl+K opens the quick switcher, Alt+↑ and Alt+↓ go to the
 * previous and the next conversation, and Escape closes the right panel or marks the channel read.
 */
function WorkspaceKeyboard() {
  const ws = useWorkspace();
  onSettled(() => {
    const capture = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLocaleLowerCase() === "k") {
        // The switcher takes ⌘K from the message search, which stays in the workspace menu.
        event.preventDefault();
        event.stopImmediatePropagation();
        ws.openDialog(ws.state.dialog?.kind === "switcher" ? null : { kind: "switcher" });
        return;
      }
      if (event.altKey && !mod && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        ws.moveConversation(event.key === "ArrowUp" ? -1 : 1);
      }
    };
    const bubble = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || ws.state.dialog) return;
      // A dialog or a menu of the app takes its own Escape.
      if (document.querySelector('[aria-modal="true"]')) return;
      if (ws.state.panel) {
        event.preventDefault();
        ws.closePanel();
        return;
      }
      if (!typing(event.target) || ws.channels.state.unread) ws.markRead();
    };
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", bubble);
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("keydown", bubble);
    };
  });
  return null;
}

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
              {(view) => <WorkspaceViewPane view={view} />}
            </Match>
          </Switch>
        }
        panel={panel()}
      />
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
 * chat's own toolbar (model, panels) stays below the header.
 */
export function WorkspaceAgentFrame(props: ParentProps<{ agentId: string }>) {
  const ws = useWorkspace();
  const agent = () => ws.env.agents().find((candidate) => candidate.id === props.agentId);
  return (
    <section class="ws-agent-dm">
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
  );
}
