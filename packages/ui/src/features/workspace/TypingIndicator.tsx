import type { WorkspaceWhySlow } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button } from "../../button";
import { Square } from "../../icons";
import { useText } from "../../text";
import { AgentWorkGroup } from "./AgentWorkGroup";
import { StepTrail } from "./StepTrail";
import { WhySlowPopover } from "./WhySlowPopover";
import { MemberAvatar } from "./WorkspaceAvatar";
import type { AgentStepView, WorkspaceMember } from "./workspace-types";

export interface TypingAgent {
  member: WorkspaceMember;
  /**
   * `thinking`: the answer gate considers it. `routing`: the lead chooses who answers. `waiting`: it
   * has the task, and its turn waits for earlier work. `working`: its turn runs.
   */
  state: "thinking" | "routing" | "waiting" | "working";
  /** What it works on, such as "Running the level tests". */
  label?: string | undefined;
  /** The model of its turn when the automatic policy chose it, such as "on Haiku · routine run". */
  model?: string | undefined;
  /** The steps of its turn so far. They open from the line, so a person can see what it does. */
  trail?: { steps: readonly AgentStepView[]; durationMs?: number | undefined } | undefined;
  /** Stops the agent's work here, as Slack's Stop on an agent that works. A working or waiting agent has it. */
  onStop?: (() => void) | undefined;
  /** The stop was sent and the work has not ended yet. */
  stopping?: boolean | undefined;
  /** Reads where the time of its work went, for "Why is this slow?". Absent on a host without it. */
  slow?: (() => Promise<WorkspaceWhySlow>) | undefined;
}

export interface TypingIndicatorProps {
  /** Humans who type now. */
  humans: readonly WorkspaceMember[];
  /** Agents that think or work on an answer now. */
  agents: readonly TypingAgent[];
  /** Several agents share one line that opens their lines. False: each has its line (debug mode). */
  group?: boolean | undefined;
}

const STATE_TEXT = {
  thinking: "workspace.typing.thinking",
  routing: "workspace.typing.routing",
  waiting: "workspace.typing.waiting",
  working: "workspace.typing.working",
} as const satisfies Record<TypingAgent["state"], string>;

/**
 * The line over the composer: "Fonikad is typing…", "Lead is choosing who answers…", "QA will answer
 * after earlier work…" and "QA is working… Running the level tests",
 * with the steps of the agent's turn so far behind "Working · 5 steps" and a Stop button. It keeps
 * its height when nobody types, so the messages do not jump.
 */
export function TypingIndicator(props: TypingIndicatorProps): JSX.Element {
  const { t, format } = useText();
  const humans = () => {
    const names = props.humans.map((member) => member.name);
    if (names.length === 0) return "";
    if (names.length === 1) return t("workspace.typing.one", { name: names[0] ?? "" });
    if (names.length <= 3) return t("workspace.typing.many", { names: format.list(names) });
    return t("workspace.typing.several");
  };
  // Several agents at work fold into one line of faces that opens their lines.
  const [groupOpen, setGroupOpen] = createSignal(false);
  const grouped = () => props.group !== false && props.agents.length >= 2;
  return (
    <div class="ws-typing" aria-live="polite" data-grouped={grouped() ? (groupOpen() ? "open" : "folded") : undefined}>
      <Show when={grouped()}>
        <AgentWorkGroup
          members={props.agents.map((agent) => agent.member)}
          open={groupOpen()}
          onToggle={() => setGroupOpen((open) => !open)}
        />
      </Show>
      <For each={grouped() && !groupOpen() ? [] : props.agents} keyed={(agent) => agent.member.id}>
        {(agent) => (
          <span class="ws-typing-agent" data-state={agent().state}>
            <MemberAvatar member={agent().member} size="xs" mood="working" />
            <span class="ws-typing-agent-text">{t(STATE_TEXT[agent().state], { name: agent().member.name })}</span>
            <Show when={agent().label}>
              <span class="ws-typing-agent-label">{agent().label}</span>
            </Show>
            <Show when={agent().model}>
              <span class="ws-typing-agent-label ws-typing-agent-model">{agent().model}</span>
            </Show>
            <Show when={agent().state === "working" || agent().state === "waiting" ? agent().slow : undefined}>
              {(read) => <WhySlowPopover read={read()} name={agent().member.name} />}
            </Show>
            <Show when={agent().state === "working" || agent().state === "waiting" ? agent().onStop : undefined}>
              {(stop) => (
                <Button
                  variant="outline"
                  size="xs"
                  class="ws-typing-stop"
                  aria-label={t(agent().stopping ? "workspace.typing.stoppingLabel" : "workspace.typing.stopLabel", {
                    name: agent().member.name,
                  })}
                  loading={agent().stopping === true}
                  loadingLabel={t("workspace.typing.stopping")}
                  onClick={() => stop()()}
                >
                  <Square aria-hidden="true" />
                  {t("workspace.typing.stop")}
                </Button>
              )}
            </Show>
            <Show when={agent().trail}>
              {(trail) => (
                <StepTrail
                  class="ws-typing-steps"
                  steps={trail().steps}
                  durationMs={trail().durationMs}
                  streaming
                  defaultOpen={false}
                />
              )}
            </Show>
          </span>
        )}
      </For>
      <Show when={humans()}>
        <span class="ws-typing-humans">
          <span class="ws-typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {humans()}
        </span>
      </Show>
    </div>
  );
}
