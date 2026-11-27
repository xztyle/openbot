import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { useText } from "./text";
import { cx } from "./utils";

export interface PlainErrorTextProps {
  /** The sentence the owner reads, in their language. */
  text: string;
  /** What the provider or the server wrote, behind a collapsed "technical details". */
  technical?: string | null | undefined;
  class?: string;
}

/**
 * An error in plain words, with the technical text closed below it. The details never open by
 * themselves: the owner opens them only when they want to see what the provider wrote.
 */
export function PlainErrorText(props: PlainErrorTextProps): JSX.Element {
  const { t } = useText();
  return (
    <span class={cx("ui-plain-error", props.class)}>
      <span>{props.text}</span>
      <Show when={props.technical}>
        {(technical) => (
          <details class="ui-plain-error-details">
            <summary>{t("agent.error.technicalDetails")}</summary>
            <code class="ui-plain-error-technical">{technical()}</code>
          </details>
        )}
      </Show>
    </span>
  );
}
