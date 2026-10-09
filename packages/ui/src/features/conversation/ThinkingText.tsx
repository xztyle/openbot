import type { InstalledSkill } from "@openbot/contracts/ipc";
import { createMemo, For, Show } from "solid-js";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { MarkdownMessageText } from "./MarkdownMessageText";

export interface ThinkingTextProps {
  /** What the model thought, one entry for each step of the turn, oldest first. */
  items: readonly string[];
  /** The turn still runs, so the last step is still being written. */
  streaming?: boolean | undefined;
  agents: AgentProfile[];
  skills?: InstalledSkill[] | undefined;
  onSelectAgent: (agentId: string) => void;
  onOpenLink: (url: string) => void;
}

/**
 * The reasoning of one turn, as the provider gave it. Providers differ: some send the whole
 * reasoning, some send a summary, and some send nothing, so the text says which case the reader
 * has. The text is already redacted and bounded by the host. It scrolls inside a box of its own, and
 * the box takes focus, so a keyboard reader can read a long thought.
 */
export function ThinkingText(props: ThinkingTextProps) {
  const { t } = useText();
  const steps = createMemo(() => props.items.filter((item) => item.trim() !== ""));
  return (
    <section class="thinking-text" aria-label={t("chat.thinking.region")} tabindex="0">
      <Show
        when={steps().length > 0}
        fallback={<p class="thinking-note">{props.streaming ? t("chat.thinking.waiting") : t("chat.thinking.none")}</p>}
      >
        <For each={steps()} keyed={false}>
          {(step, index) => (
            <div class="thinking-step">
              <MarkdownMessageText
                body={step()}
                agents={props.agents}
                skills={props.skills}
                streaming={props.streaming === true && index === steps().length - 1}
                onSelectAgent={props.onSelectAgent}
                onOpenLink={props.onOpenLink}
              />
            </div>
          )}
        </For>
        <p class="thinking-note">{t("chat.thinking.note")}</p>
      </Show>
    </section>
  );
}
