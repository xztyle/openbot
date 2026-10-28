import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { useText } from "../../text";
import { MemberAvatar } from "./WorkspaceAvatar";
import type { WorkspaceMember } from "./workspace-types";

export interface TypingAgent {
  member: WorkspaceMember;
  state: "thinking" | "working";
  /** What it works on, such as "Running the level tests". */
  label?: string | undefined;
}

export interface TypingIndicatorProps {
  /** Humans who type now. */
  humans: readonly WorkspaceMember[];
  /** Agents that think or work on an answer now. */
  agents: readonly TypingAgent[];
}

/**
 * The line over the composer: "Fonikad is typing…" and "QA is working… Running the level tests".
 * It keeps its height when nobody types, so the messages do not jump.
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
  return (
    <div class="ws-typing" aria-live="polite">
      <For each={props.agents} keyed={(agent) => agent.member.id}>
        {(agent) => (
          <span class="ws-typing-agent" data-state={agent().state}>
            <MemberAvatar member={agent().member} size="xs" />
            <span class="ws-typing-agent-text">
              {t(agent().state === "working" ? "workspace.typing.working" : "workspace.typing.thinking", {
                name: agent().member.name,
              })}
            </span>
            <Show when={agent().label}>
              <span class="ws-typing-agent-label">{agent().label}</span>
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
