import { Dynamic, type JSX } from "@solidjs/web";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { Button } from "../../button";
import {
  Brain,
  ChevronRight,
  CircleX,
  FileText,
  Globe2,
  LoaderCircle,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { useWorkspaceDuration } from "./workspace-format";
import type { AgentStepKind, AgentStepView } from "./workspace-types";

const STEP_ICON = {
  search: Search,
  browse: Globe2,
  tool: Wrench,
  shell: Terminal,
  file: FileText,
  skill: Sparkles,
  think: Brain,
} as const satisfies Record<AgentStepKind, typeof Search>;

export interface StepTrailProps {
  steps: readonly AgentStepView[];
  /** The time of the whole turn. While it streams, the caller updates it. */
  durationMs?: number | undefined;
  /** The agent still works: the newest step spins and the trail starts open. */
  streaming?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  class?: string;
}

/**
 * The transparent trail of an agent answer: "7 steps · 42s", which opens the searches, tools,
 * files and skills of the turn.
 */
export function StepTrail(props: StepTrailProps): JSX.Element {
  const { t } = useText();
  const duration = useWorkspaceDuration();
  const listId = createUniqueId();
  const [choice, setChoice] = createSignal<boolean>();
  const open = () => choice() ?? props.defaultOpen ?? props.streaming ?? false;
  const failed = () => props.steps.filter((step) => step.status === "failed").length;
  const summary = () => {
    const count = t("workspace.steps.count", { count: props.steps.length });
    const time = props.durationMs === undefined ? undefined : duration(props.durationMs);
    if (props.streaming)
      return time
        ? t("workspace.steps.workingFor", { steps: count, time })
        : t("workspace.steps.working", { steps: count });
    return time ? t("workspace.steps.summary", { steps: count, time }) : count;
  };
  return (
    <div
      class={cx("ws-steps", props.class)}
      data-open={open() ? "" : undefined}
      data-streaming={props.streaming ? "" : undefined}
    >
      <Button
        variant="ghost"
        size="xs"
        class="ws-steps-header"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={listId}
        onClick={() => setChoice(!open())}
      >
        <Show when={props.streaming} fallback={<ChevronRight class="ws-steps-chevron" aria-hidden="true" />}>
          <LoaderCircle class="ws-steps-spinner" aria-hidden="true" />
        </Show>
        <span>{summary()}</span>
        <Show when={failed() > 0}>
          <span class="ws-steps-failed">{t("workspace.steps.failed", { count: failed() })}</span>
        </Show>
      </Button>
      <Show when={open()}>
        <ol id={listId} class="ws-steps-list" aria-live={props.streaming ? "polite" : undefined}>
          <For each={props.steps} keyed={(step) => step.id}>
            {(step) => (
              <li class="ws-step" data-status={step().status}>
                <span class="ws-step-icon" aria-hidden="true">
                  <Show
                    when={step().status === "running"}
                    fallback={
                      <Show when={step().status === "failed"} fallback={<Dynamic component={STEP_ICON[step().kind]} />}>
                        <CircleX />
                      </Show>
                    }
                  >
                    <LoaderCircle class="ws-steps-spinner" />
                  </Show>
                </span>
                <span class="ws-step-copy">
                  <span class="ws-step-label">{step().label}</span>
                  <Show when={step().detail}>
                    <span class="ws-step-detail">{step().detail}</span>
                  </Show>
                </span>
                <Show when={step().durationMs !== undefined && step().status !== "running"}>
                  <span class="ws-step-time">{duration(step().durationMs ?? 0)}</span>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
}
