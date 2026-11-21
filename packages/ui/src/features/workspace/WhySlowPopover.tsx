import type { InsightSlowKind, WorkspaceWhySlow } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { buttonVariants } from "../../button";
import { Popover } from "../../complex";
import { Hourglass } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";

const KIND_KEY = {
  queued: "insight.slow.kind.queued",
  running: "insight.slow.kind.running",
  teammate: "insight.slow.kind.teammate",
  owner: "insight.slow.kind.owner",
  blocked: "insight.slow.kind.blocked",
  failed: "insight.slow.kind.failed",
} as const satisfies Record<InsightSlowKind, string>;

/** "3 h 5 min", "12 min", "40 s". */
function useDuration() {
  const { format } = useText();
  return (ms: number) => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${format.number(seconds)} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${format.number(minutes)} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${format.number(hours)} h ${format.number(rest)} min` : `${format.number(hours)} h`;
  };
}

export interface WhySlowPopoverProps {
  /** Reads the timeline; called each time the popover opens. */
  read: () => Promise<WorkspaceWhySlow>;
  /** The agent's name, for the button's label. */
  name: string;
  class?: string | undefined;
}

/**
 * "Why is this slow?": a small button on the working line that opens where the time of the request
 * went, from the host's stored rows: how long it waited in the queue, worked, waited for a teammate
 * or for the reader, was held by the plan limit, and each attempt that failed.
 */
export function WhySlowPopover(props: WhySlowPopoverProps): JSX.Element {
  const { t } = useText();
  const duration = useDuration();
  const [open, setOpen] = createSignal(false);
  const [timeline, setTimeline] = createSignal<WorkspaceWhySlow | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onCleanup(() => clearInterval(timer));
  function load() {
    setFailed(false);
    props
      .read()
      .then(setTimeline)
      .catch(() => setFailed(true));
  }
  return (
    <Popover.Root
      open={open()}
      onOpenChange={(next) => {
        setOpen(next);
        clearInterval(timer);
        if (!next) return;
        setNow(Date.now());
        load();
        timer = setInterval(() => setNow(Date.now()), 1000);
      }}
      placement="top-start"
      gutter={6}
    >
      <Popover.Trigger
        class={cx(buttonVariants({ variant: "ghost", size: "icon-xs" }), "ws-why-slow-button", props.class)}
        aria-label={`${t("insight.slow.button")} · ${props.name}`}
        title={t("insight.slow.button")}
      >
        <Hourglass aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="ui-popover-menu-surface ws-why-slow">
          <Popover.Title class="ws-why-slow-title">{t("insight.slow.title")}</Popover.Title>
          <Show
            when={timeline()}
            fallback={<p class="ws-why-slow-note">{failed() ? t("insight.slow.failed") : t("insight.slow.loading")}</p>}
          >
            {(slow) => (
              <Show
                when={slow().segments.length > 0}
                fallback={<p class="ws-why-slow-note">{t("insight.slow.none")}</p>}
              >
                <p class="ws-why-slow-total">
                  {slow().endedAt === null
                    ? t("insight.slow.total", { duration: duration(now() - (slow().startedAt ?? now())) })
                    : t("insight.slow.totalDone", {
                        duration: duration((slow().endedAt ?? 0) - (slow().startedAt ?? 0)),
                      })}
                </p>
                <ol class="ws-why-slow-list">
                  <For each={slow().segments} keyed={(segment) => `${segment.kind}:${segment.startAt}`}>
                    {(segment) => (
                      <li class="ws-why-slow-segment" data-kind={segment().kind}>
                        <span class="ws-why-slow-kind">{t(KIND_KEY[segment().kind])}</span>
                        <span class="ws-why-slow-time">
                          {segment().kind === "failed"
                            ? ""
                            : segment().endAt === null
                              ? `${duration(now() - segment().startAt)} · ${t("insight.slow.open")}`
                              : duration((segment().endAt ?? 0) - segment().startAt)}
                        </span>
                        <Show when={segment().detail}>
                          {(detail) => <span class="ws-why-slow-detail">{detail()}</span>}
                        </Show>
                      </li>
                    )}
                  </For>
                </ol>
                <Show when={slow().queueAhead > 0}>
                  <p class="ws-why-slow-note">{t("insight.slow.ahead", { count: slow().queueAhead })}</p>
                </Show>
              </Show>
            )}
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
