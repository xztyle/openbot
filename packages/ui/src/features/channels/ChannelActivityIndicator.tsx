import type { AppFormat, AppTranslate } from "@openbot/i18n";
import { createMemo, For, Show } from "solid-js";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
import { type AgentActivityLabel, agentActivityLabelKey, nextAgentActivityLabel } from "../conversation/AgentActivity";

/** One agent the channel is waiting on. The profile is missing while the agent list has no such id. */
export interface ChannelWorker {
  id: string;
  name: string;
  agent?: AgentProfile;
  /**
   * The member has a task but no free place yet: the channel runs a few agents at once. The row
   * names it and draws its face dim, so the reader sees who comes next and not only who is busy.
   */
  queued?: boolean | undefined;
}

/**
 * Who the channel is waiting on, as one sentence: "Ana and Bo are working · Cy queued".
 *
 * A channel runs several agents at once, and a row for each would push the transcript off the
 * screen every time work started. The names read as a list, so the line counts the workers in one
 * sentence. It takes the subject of the agent chat's announcement - `<name> is working` - so both
 * chats announce work the same way. The announcement reads the same sentence.
 */
export function channelActivitySentence(
  workers: readonly Pick<ChannelWorker, "name" | "queued">[],
  t: AppTranslate,
  format: Pick<AppFormat, "list">,
): string {
  const working = workers.filter((worker) => worker.queued !== true).map((worker) => worker.name);
  const queued = workers.filter((worker) => worker.queued === true).map((worker) => worker.name);
  let workingSentence = "";
  if (working.length === 1) workingSentence = t("channel.activity.one", { name: working[0] ?? "" });
  else if (working.length > 1) {
    workingSentence = t("channel.activity.many", {
      names: working.slice(0, -1).join(", "),
      last: working[working.length - 1] ?? "",
    });
  }
  if (queued.length === 0) return workingSentence;
  const queuedSentence = t("channel.activity.queued", { names: format.list(queued) });
  return workingSentence
    ? t("channel.activity.withQueued", { working: workingSentence, queued: queuedSentence })
    : queuedSentence;
}

/**
 * The activity row of a channel shows the face of each working agent.
 *
 * It uses the `agent-activity-*` rules and the same shifting label as the agent chat, so a reader
 * who moves between a channel and an agent chat meets one indicator. What differs is the number of
 * faces: a channel runs at most `CHANNEL_PARALLEL_LIMIT` agents, which is what keeps the count of
 * animating avatars low - each one costs the renderer a style recalculation and a paint per frame.
 */
export function ChannelActivityIndicator(props: { workers: ChannelWorker[] }) {
  const { t, format } = useText();
  const key = createMemo(() =>
    props.workers
      .map((worker) => worker.id)
      .sort()
      .join(","),
  );
  let previous: AgentActivityLabel | undefined;
  // A new set of workers is a new turn of the channel, so it gets a label of its own. The same set
  // keeps what it had, and the row does not flicker as messages arrive.
  const label = createMemo<AgentActivityLabel>(() => {
    key();
    previous = nextAgentActivityLabel(previous);
    return previous;
  });
  const sentence = () => channelActivitySentence(props.workers, t, format);
  const busy = () => props.workers.some((worker) => worker.queued !== true);
  const tooltip = (worker: ChannelWorker) =>
    t(worker.queued ? "channel.activity.queuedOne" : "channel.activity.one", { name: worker.name });
  return (
    <div class="agent-activity-entry" data-state="active">
      <span
        class="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={t("channel.activity.status", { sentence: sentence(), label: t(agentActivityLabelKey(label())) })}
      />
      <section class="agent-activity-content channel-activity-content" aria-label={t("chat.activity.current")}>
        <div class="channel-activity-faces">
          <For each={props.workers}>
            {(worker) => (
              <span
                class="channel-activity-face"
                data-queued={worker.queued ? "true" : undefined}
                title={tooltip(worker)}
              >
                <AgentAvatar
                  agent={worker.agent}
                  seed={worker.agent ? undefined : worker.id}
                  mood={worker.queued ? undefined : "working"}
                  class="agent-activity-avatar"
                />
              </span>
            )}
          </For>
        </div>
        <span class="channel-activity-names" title={sentence()}>
          {sentence()}
        </span>
        <Show when={busy()}>
          <span class="agent-activity-label">{t(agentActivityLabelKey(label()))}</span>
        </Show>
      </section>
    </div>
  );
}
