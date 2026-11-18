import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { Bell, BellOff, ChevronDown } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { RepliesDivider } from "./MessageDividers";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import type { ChannelVisibility } from "./workspace-types";

export interface ThreadPanelProps {
  /** The conversation of the thread, without `#`, or the names of a DM. */
  channelName: string;
  visibility?: ChannelVisibility | undefined;
  /** The thread is in a DM or a group: the header names it without `#` or a lock. */
  direct?: boolean | undefined;
  /** The root message, as a `MessageRow`. */
  root: JSX.Element;
  replyCount: number;
  /** The replies, as `MessageRow`s. */
  replies: JSX.Element;
  /** The composer of the thread, as a `MessageComposer` with `alsoSendTo`. */
  composer: JSX.Element;
  /** Agents or people who type in the thread, as a `TypingIndicator`. */
  typing?: JSX.Element;
  /** Gets the scrolling list of the root and the replies, to keep the reader's place in it. */
  scrollRef?: ((element: HTMLDivElement) => void) | undefined;
  onScroll?: (() => void) | undefined;
  /**
   * Set while the reader reads above the newest reply: a pill at the bottom, "3 new replies" when
   * replies came since they left the end, else "Jump to latest". Null hides it.
   */
  jump?: { newReplies: number; onJump: () => void } | null | undefined;
  /** Whether the reader follows the thread: a bell in the header turns the notices of its replies on and off. */
  following?: { on: boolean; onChange: (on: boolean) => void } | undefined;
  onClose: () => void;
  /** The narrow layout's back button. */
  onBack?: (() => void) | undefined;
  class?: string;
}

/** The right panel of a thread: "Thread · #channel", the root, "N replies", the replies and a composer. */
export function ThreadPanel(props: ThreadPanelProps): JSX.Element {
  const { t } = useText();
  return (
    <section class={cx("ws-thread-panel", props.class)} aria-label={t("workspace.thread.title")}>
      <WorkspacePaneHeader
        title={t("workspace.thread.title")}
        subtitle={
          props.direct
            ? props.channelName
            : props.visibility === "private"
              ? t("workspace.thread.inPrivate", { name: props.channelName })
              : t("workspace.thread.inChannel", { name: props.channelName })
        }
        actions={
          <Show when={props.following}>
            {(following) => (
              <IconButton
                variant="ghost"
                label={t(following().on ? "workspace.thread.unfollow" : "workspace.thread.follow")}
                onClick={() => following().onChange(!following().on)}
              >
                <Show when={following().on} fallback={<BellOff />}>
                  <Bell />
                </Show>
              </IconButton>
            )}
          </Show>
        }
        onBack={props.onBack}
        onClose={props.onClose}
      />
      <div class="ws-thread-body">
        <div class="ws-thread-scroll" ref={(element) => props.scrollRef?.(element)} onScroll={() => props.onScroll?.()}>
          <div class="ws-thread-root">{props.root}</div>
          <Show when={props.replyCount > 0}>
            <RepliesDivider count={props.replyCount} />
          </Show>
          <div class="ws-thread-replies">{props.replies}</div>
        </div>
        <Show when={props.jump}>
          {(jump) => (
            <Button
              variant={jump().newReplies > 0 ? "default" : "secondary"}
              size="xs"
              class="ws-thread-jump"
              onClick={() => jump().onJump()}
            >
              <ChevronDown aria-hidden="true" />
              {jump().newReplies > 0
                ? t("workspace.thread.newReplies", { count: jump().newReplies })
                : t("workspace.app.channel.jumpToLatest")}
            </Button>
          )}
        </Show>
      </div>
      <div class="ws-thread-bottom">
        {props.typing}
        {props.composer}
      </div>
    </section>
  );
}
