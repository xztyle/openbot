import {
  channelKind,
  channelMembersAnswer,
  channelVisibility,
  type WorkspaceThreadState,
} from "@openbot/contracts/ipc";
import { Button, toast } from "@openbot/ui";
import { ThreadPanel } from "@openbot/ui/features/workspace/ThreadPanel";
import { TypingIndicator } from "@openbot/ui/features/workspace/TypingIndicator";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { WorkspaceComposer } from "./WorkspaceComposer";
import { WorkspaceMessage } from "./WorkspaceMessage";
import { createAgentWork } from "./workspace-agent-work";
import { useWorkspace } from "./workspace-context";
import { agentNotes, conversationName, messageRows, readerJoined } from "./workspace-model";
import { savedScrollPlace, saveScrollPlace } from "./workspace-scroll-places";

/** How close to the end still counts as reading the newest replies, as in the channel. */
const FOLLOW_DISTANCE = 80;

/** The thread in the right panel: its root, its replies and a composer with "Also send to #channel". */
export function WorkspaceThreadPanel(props: { channelId: string; rootId: string }) {
  const { t, errorMessage } = useText();
  const ws = useWorkspace();
  let scroller: HTMLDivElement | undefined;
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
  // The reader's state in this thread when it opened: its follow, and the replies they had not read,
  // which get the "New" divider, as in a channel. Reading the thread does not move the divider.
  const [opening, setOpening] = createSignal<WorkspaceThreadState | null | undefined>(
    ws.marks.supports.threads() ? undefined : null,
  );
  if (ws.marks.supports.threads())
    void ws.marks
      .loadThreads(props.channelId, [props.rootId])
      .finally(() => setOpening(ws.marks.thread(props.channelId, props.rootId) ?? null));
  const firstUnreadId = createMemo(() => {
    // "Mark unread" in the open thread moves the divider to its message.
    const state = ws.marks.heldThread(props.channelId, props.rootId)
      ? ws.marks.thread(props.channelId, props.rootId)
      : opening();
    if (!state || state.unreadCount <= 0) return null;
    const unread = entries().find(
      (entry) =>
        entry.id !== props.rootId &&
        entry.sequence > state.throughSequence &&
        !(entry.author.kind === "member" && ws.env.isReader(entry.author.id)),
    );
    return unread?.id ?? null;
  });
  const followState = () => ws.marks.thread(props.channelId, props.rootId);
  const rows = createMemo(() => {
    const current = channel();
    return messageRows(entries(), {
      thread: true,
      firstUnreadId: firstUnreadId(),
      membersAnswer: current ? channelMembersAnswer(current) : false,
      note: agentNotes(ws.directory().agents, thread()?.page?.tasks ?? []),
    });
  });
  const root = () => rows().find((row) => row.entry.id === props.rootId && !row.pending);
  /** A reply that a link named. */
  const focusId = () => {
    const focus = ws.state.focus;
    return focus?.channelId === props.channelId && focus.messageId !== props.rootId ? focus.messageId : undefined;
  };
  const replies = () => rows().filter((row) => row !== root());
  const replyCount = () => replies().filter((row) => !row.pending).length;
  const archived = () => channel()?.archived === true;
  const work = createAgentWork({
    channelId: props.channelId,
    threadRootId: props.rootId,
    entries,
    canStop: () => {
      const current = channel();
      return (
        current !== undefined && !current.archived && ws.env.connectionReady() && readerJoined(ws.directory(), current)
      );
    },
  });

  // The reader's place, as in Slack: the panel follows new replies only while the reader is at the
  // end. Above it, a reply does not move them; a pill counts the new replies and jumps down. The
  // reader's own reply always goes to the end. The place stays for the next opening of the thread.
  const placeId = `${ws.env.storageKey()}:thread:${props.channelId}:${props.rootId}`;
  let follow = true;
  let opened = false;
  /** The linked reply the panel scrolled to, so a new reply does not scroll back to it. */
  let focused: string | undefined;
  let lastId: string | undefined;
  const [atEnd, setAtEnd] = createSignal(true);
  /** The reply count when the reader left the end: the replies after it are new to them. */
  const [awayCount, setAwayCount] = createSignal<number | null>(null);
  const newReplies = () => {
    const away = awayCount();
    return away === null ? 0 : Math.max(0, replyCount() - away);
  };

  function scrollToEnd() {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  /** Reads the place after a scroll or a change of the content. */
  function notePlace() {
    if (!scroller || !opened) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    follow = remaining <= FOLLOW_DISTANCE;
    if (follow !== untrack(atEnd)) {
      setAtEnd(follow);
      setAwayCount(follow ? null : untrack(replyCount));
    }
    saveScrollPlace(placeId, follow ? null : { offset: scroller.scrollTop });
    // At the newest reply, with the window in front, the reader has read the thread.
    if (follow && opening() !== undefined && document.hasFocus()) {
      const newest = untrack(entries).reduce((top, entry) => Math.max(top, entry.sequence), 0);
      if (newest > 0) ws.marks.readThread(props.channelId, props.rootId, newest);
    }
  }

  function jumpToLatest() {
    follow = true;
    scrollToEnd();
    notePlace();
  }

  createEffect(
    () => ({ count: entries().length, last: entries().at(-1), focus: focusId(), ready: opening() !== undefined }),
    ({ count, last, focus, ready }) => {
      requestAnimationFrame(() => {
        // The first place waits for the reader's state, which says where the new replies start.
        if (!scroller || count === 0 || !untrack(root) || !ready) return;
        const marked = focus && focus !== focused ? scroller.querySelector<HTMLElement>("[data-highlighted]") : null;
        const own = last && last.id !== lastId && last.author.kind === "member" && ws.env.isReader(last.author.id);
        const first = !opened;
        lastId = last?.id;
        opened = true;
        if (marked) {
          // A linked reply shows once, in the middle.
          focused = focus;
          follow = false;
          marked.scrollIntoView({ block: "center" });
        } else if (first) {
          const place = savedScrollPlace(placeId);
          const divider = scroller.querySelector<HTMLElement>(".ws-new-divider");
          if (place) scroller.scrollTop = place.offset;
          else if (divider) {
            // New replies: open at the first one, as a channel opens at its "New" line.
            follow = false;
            divider.scrollIntoView({ block: "start" });
          } else scrollToEnd();
        } else if (follow || own) scrollToEnd();
        notePlace();
      });
    },
  );

  // A streaming answer grows without a new reply: keep the end in view while the reader follows.
  onSettled(() => {
    if (!scroller) return;
    const observer = new ResizeObserver(() => {
      if (opened && follow) scrollToEnd();
    });
    observer.observe(scroller);
    for (const child of scroller.children) observer.observe(child);
    return () => observer.disconnect();
  });
  onCleanup(() => {
    opened = false;
    ws.marks.releaseThread(props.channelId, props.rootId);
  });

  const visibility = () => {
    const current = channel();
    return current ? channelVisibility(current) : "public";
  };
  const isChannel = () => {
    const current = channel();
    return current ? channelKind(current) === "channel" : true;
  };
  return (
    <div class="ws-thread-frame">
      <ThreadPanel
        channelName={name()}
        visibility={visibility()}
        direct={!isChannel()}
        replyCount={replyCount()}
        onClose={() => ws.closePanel()}
        onBack={() => ws.back()}
        scrollRef={(element) => (scroller = element)}
        onScroll={notePlace}
        jump={atEnd() || !root() ? null : { newReplies: newReplies(), onJump: jumpToLatest }}
        following={
          ws.marks.supports.follow() && followState()
            ? {
                on: followState()?.followed ?? false,
                onChange: (on) =>
                  void ws.marks
                    .setFollowed(props.channelId, props.rootId, on)
                    .catch((error: unknown) => toast.error(errorMessage(error, t("workspace.message.actionFailed")))),
              }
            : undefined
        }
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
            {(row) => (
              <WorkspaceMessage
                row={row()}
                channelId={props.channelId}
                channelName={name()}
                highlighted={focusId() === row().entry.id}
                inThread
              />
            )}
          </For>
        }
        typing={<TypingIndicator humans={work.humans()} agents={work.agents()} />}
        composer={
          <WorkspaceComposer
            channelId={props.channelId}
            threadRootId={props.rootId}
            placeholder={t("workspace.app.composer.reply")}
            label={t("workspace.app.composer.replyLabel", { name: name() })}
            alsoSendTo={isChannel() ? name() : undefined}
            // A phone opens the keyboard only on a tap in the box, as Slack's app does.
            focusRequest={ws.env.phone() ? 0 : 1}
            disabled={!ws.env.connectionReady() || archived()}
          />
        }
      />
    </div>
  );
}
