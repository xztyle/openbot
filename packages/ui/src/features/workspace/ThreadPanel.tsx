import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { useText } from "../../text";
import { cx } from "../../utils";
import { RepliesDivider } from "./MessageDividers";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import type { ChannelVisibility } from "./workspace-types";

export interface ThreadPanelProps {
  /** The conversation of the thread, without `#`, or the names of a DM. */
  channelName: string;
  visibility?: ChannelVisibility | undefined;
  /** The root message, as a `MessageRow`. */
  root: JSX.Element;
  replyCount: number;
  /** The replies, as `MessageRow`s. */
  replies: JSX.Element;
  /** The composer of the thread, as a `MessageComposer` with `alsoSendTo`. */
  composer: JSX.Element;
  /** Agents or people who type in the thread, as a `TypingIndicator`. */
  typing?: JSX.Element;
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
          props.visibility === "private"
            ? t("workspace.thread.inPrivate", { name: props.channelName })
            : t("workspace.thread.inChannel", { name: props.channelName })
        }
        onBack={props.onBack}
        onClose={props.onClose}
      />
      <div class="ws-thread-scroll">
        <div class="ws-thread-root">{props.root}</div>
        <Show when={props.replyCount > 0}>
          <RepliesDivider count={props.replyCount} />
        </Show>
        <div class="ws-thread-replies">{props.replies}</div>
      </div>
      <div class="ws-thread-bottom">
        {props.typing}
        {props.composer}
      </div>
    </section>
  );
}
