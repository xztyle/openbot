import type { JSX } from "@solidjs/web";
import { type Accessor, createMemo, createRoot, createSignal, Show } from "solid-js";
import { Button } from "../../button";
import { useText } from "../../text";

/*
 * An agent's answer that the host condensed for people (`condensed` on the message) shows the short
 * text with a quiet "Condensed" mark under it; the mark opens the agent's own text and closes it again.
 * Another switch of the app, such as the workspace debug mode, can show the original by default.
 */

const [originalByDefault, setOriginalByDefault] = createRoot(() =>
  createSignal<{ read: Accessor<boolean> }>({ read: () => false }),
);

/**
 * Makes `source` decide whether a condensed answer shows the agent's original text until the reader
 * toggles it. The workspace debug mode calls it with its own signal.
 */
export function setCondensedOriginalByDefault(source: Accessor<boolean>): void {
  setOriginalByDefault({ read: source });
}

/**
 * The text that a condensed answer shows now, and the toggle between the short text and the
 * original. `original` is undefined for any other message, which always shows its own text.
 */
export function createCondensedView(original: Accessor<string | undefined>) {
  const [choice, setChoice] = createSignal<boolean | null>(null);
  const showingOriginal = createMemo(() =>
    original() === undefined ? false : (choice() ?? originalByDefault().read()),
  );
  return {
    condensed: () => original() !== undefined,
    showingOriginal,
    toggle: () => setChoice(!showingOriginal()),
  };
}

/** The mark under a condensed answer: "Condensed · Show original", or "Original · Show condensed". */
export function CondensedNote(props: { showingOriginal: boolean; onToggle: () => void }): JSX.Element {
  const { t } = useText();
  return (
    <p class="ws-message-condensed" title={t("workspace.message.condensedHint")}>
      <span>{props.showingOriginal ? t("workspace.message.original") : t("workspace.message.condensed")}</span>
      <span aria-hidden="true"> · </span>
      <Button variant="link" size="xs" class="ws-message-condensed-toggle" onClick={() => props.onToggle()}>
        <Show when={props.showingOriginal} fallback={t("workspace.message.showOriginal")}>
          {t("workspace.message.showCondensed")}
        </Show>
      </Button>
    </p>
  );
}
