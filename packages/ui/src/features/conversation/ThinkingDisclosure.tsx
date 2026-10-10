import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import { Button, ChevronDown } from "@openbot/ui";
import { createMemo, createSignal, createUniqueId, Show } from "solid-js";
import { useText } from "../../text";
import { ThinkingText, type ThinkingTextProps } from "./ThinkingText";

export interface ThinkingDisclosureProps extends Omit<ThinkingTextProps, "streaming"> {
  /** Starts open. A finished turn starts closed. */
  defaultOpen?: boolean | undefined;
  /** Shows a line of the last step while closed. Off, the closed row is only its label. Default on. */
  showPreview?: boolean | undefined;
}

/** The longest preview the closed row keeps. The row clips it to one line anyway. */
const PREVIEW_LIMIT = 200;

/**
 * What a model thought in a finished turn, as one quiet row in the chat. Closed, it shows a line of
 * the last step, like the activity line did while the turn ran. Open, it shows all of the reasoning.
 * The row is a button, so Enter and Space open it.
 */
export function ThinkingDisclosure(props: ThinkingDisclosureProps) {
  const { t } = useText();
  const panelId = createUniqueId();
  const [open, setOpen] = createSignal(props.defaultOpen === true);
  const preview = createMemo(() => {
    const last = props.items.findLast((item) => item.trim() !== "");
    if (!last) return "";
    const line = markdownPreviewText(last);
    return line.length > PREVIEW_LIMIT ? `${line.slice(0, PREVIEW_LIMIT).trimEnd()}…` : line;
  });
  return (
    <section class="thinking-disclosure" data-open={open() ? "" : undefined}>
      <Button
        variant="ghost"
        type="button"
        class="thinking-disclosure-toggle"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={panelId}
        data-cuelume-tap={open() ? "close" : "open"}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown class="thinking-disclosure-chevron" aria-hidden="true" />
        <span class="thinking-disclosure-label">{t("chat.thinking.label")}</span>
        <Show when={!open() && props.showPreview !== false && preview()}>
          <span class="thinking-disclosure-preview">{preview()}</span>
        </Show>
      </Button>
      <div id={panelId} class="thinking-disclosure-panel">
        <Show when={open()}>
          <ThinkingText
            items={props.items}
            agents={props.agents}
            skills={props.skills}
            onSelectAgent={props.onSelectAgent}
            onOpenLink={props.onOpenLink}
          />
        </Show>
      </div>
    </section>
  );
}
