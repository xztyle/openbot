import { channelKind, channelMembersAnswer, channelVisibility } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui";
import { ThreadPanel } from "@openbot/ui/features/workspace/ThreadPanel";
import { TypingIndicator } from "@openbot/ui/features/workspace/TypingIndicator";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, For, Show } from "solid-js";
import { WorkspaceComposer } from "./WorkspaceComposer";
import { WorkspaceMessage } from "./WorkspaceMessage";
import { useWorkspace } from "./workspace-context";
import { conversationName, memberById, messageRows, thinkingAgents, workingAgents } from "./workspace-model";

/** The thread in the right panel: its root, its replies and a composer with "Also send to #channel". */
export function WorkspaceThreadPanel(props: { channelId: string; rootId: string }) {
  const { t } = useText();
  const ws = useWorkspace();
  let scroller: HTMLElement | undefined;
  const thread = () => {
    const current = ws.state.thread;
    return current?.channelId === props.channelId && current.rootId === props.rootId ? current : null;
  };
  const channel = () => ws.summary(props.channelId) ?? ws.channels.state.page?.channel;
  const name = () => {
    const current = channel();
    return current ? conversationName(ws.directory(), current) : "";
  };
  const entries = () => thread()?.page?.messages ?? [];
  const rows = createMemo(() => {
    const current = channel();
    return messageRows(entries(), { thread: true, membersAnswer: current ? channelMembersAnswer(current) : false });
  });
  const root = () => rows().find((row) => row.entry.id === props.rootId && !row.pending);
  const replies = () => rows().filter((row) => row !== root());
  const replyCount = () => replies().filter((row) => !row.pending).length;
  const live = createMemo(() => ws.typingIn(props.channelId, props.rootId));
  const typingPeople = createMemo(() => (live()?.humans ?? []).map((id) => memberById(ws.directory(), id)));
  const typing = createMemo(() => {
    const host = live();
    const replies = entries().filter((entry) => entry.id !== props.rootId);
    const thinking = host
      ? host.agents.filter((agent) => agent.state === "thinking").map((agent) => agent.id)
      : thinkingAgents([...entries()]);
    const busy = (
      host
        ? host.agents.filter((agent) => agent.state === "working").map((agent) => agent.id)
        : workingAgents(replies, [])
    ).filter((id) => !thinking.includes(id));
    return [
      ...thinking.map((id) => ({ member: memberById(ws.directory(), id), state: "thinking" as const })),
      ...busy.map((id) => ({ member: memberById(ws.directory(), id), state: "working" as const })),
    ];
  });
  // New replies keep the end in view.
  createEffect(
    () => entries().length,
    () => {
      requestAnimationFrame(() => {
        const element = scroller?.querySelector<HTMLElement>(".ws-thread-scroll");
        if (element) element.scrollTop = element.scrollHeight;
      });
    },
  );
  const visibility = () => {
    const current = channel();
    return current ? channelVisibility(current) : "public";
  };
  const isChannel = () => {
    const current = channel();
    return current ? channelKind(current) === "channel" : true;
  };
  return (
    <div class="ws-thread-frame" ref={(element) => (scroller = element)}>
      <ThreadPanel
        channelName={name()}
        visibility={visibility()}
        replyCount={replyCount()}
        onClose={() => ws.closePanel()}
        onBack={() => ws.back()}
        root={
          <Show
            when={root()}
            fallback={
              <Show
                when={thread()?.error}
                fallback={<p class="ws-pane-loading">{t("workspace.app.thread.loading")}</p>}
              >
                {(error) => (
                  <div class="ws-pane-error" role="alert">
                    <p>{error()}</p>
                    <Button variant="outline" size="sm" onClick={() => ws.reloadThread()}>
                      {t("workspace.app.retry")}
                    </Button>
                  </div>
                )}
              </Show>
            }
          >
            {(row) => (
              <WorkspaceMessage
                row={{ ...row(), grouped: false, dayStart: null, firstUnread: false }}
                channelId={props.channelId}
                channelName={name()}
                inThread
              />
            )}
          </Show>
        }
        replies={
          <For each={replies()} keyed={(row) => row.key}>
            {(row) => <WorkspaceMessage row={row()} channelId={props.channelId} channelName={name()} inThread />}
          </For>
        }
        typing={<TypingIndicator humans={typingPeople()} agents={typing()} />}
        composer={
          <WorkspaceComposer
            channelId={props.channelId}
            threadRootId={props.rootId}
            placeholder={t("workspace.app.composer.reply")}
            label={t("workspace.app.composer.replyLabel", { name: name() })}
            alsoSendTo={isChannel() ? name() : undefined}
            focusRequest={1}
            disabled={!ws.env.connectionReady() || channel()?.archived === true}
          />
        }
      />
    </div>
  );
}
