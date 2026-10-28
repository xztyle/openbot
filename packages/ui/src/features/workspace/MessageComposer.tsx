import type { JSX } from "@solidjs/web";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { Checkbox } from "../../checkbox";
import {
  AtSign,
  Bold,
  Code,
  Italic,
  Link,
  List,
  ListOrdered,
  Paperclip,
  Send,
  SmilePlus,
  Strikethrough,
  Type,
} from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";

export type ComposerFormat = "bold" | "italic" | "strike" | "code" | "link" | "bulleted-list" | "numbered-list";

const FORMATS = [
  { format: "bold", label: "workspace.composer.bold", icon: Bold, shortcut: "⌘B" },
  { format: "italic", label: "workspace.composer.italic", icon: Italic, shortcut: "⌘I" },
  { format: "strike", label: "workspace.composer.strike", icon: Strikethrough, shortcut: "⌘⇧X" },
  { format: "link", label: "workspace.composer.link", icon: Link, shortcut: "⌘⇧U" },
  { format: "bulleted-list", label: "workspace.composer.bulletedList", icon: List, shortcut: "⌘⇧8" },
  { format: "numbered-list", label: "workspace.composer.numberedList", icon: ListOrdered, shortcut: "⌘⇧7" },
  { format: "code", label: "workspace.composer.code", icon: Code, shortcut: "⌘⇧C" },
] as const satisfies readonly { format: ComposerFormat; label: string; icon: typeof Bold; shortcut: string }[];

export interface ComposerAlsoSend {
  channelName: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export interface MessageComposerProps {
  /**
   * The editor itself. The renderer plugs `ComposerEditor` in; the shell gives it the box, the
   * toolbar and the send button, and sends each toolbar press to `onFormat`.
   */
  editor: JSX.Element;
  /** The accessible name of the box, such as "Message #general". */
  label: string;
  /** Files and images that wait to be sent, above the editor. */
  attachments?: JSX.Element;
  /** A note above the box, such as an error or "You are replying to…". */
  notice?: JSX.Element;
  /** Applies a format to the editor's selection. Without it the toolbar does not show. */
  onFormat?: ((format: ComposerFormat) => void) | undefined;
  /** The formats at the caret, to show pressed toolbar buttons. */
  activeFormats?: readonly ComposerFormat[] | undefined;
  onAttach?: (() => void) | undefined;
  onEmoji?: (() => void) | undefined;
  /** Puts `@` at the caret and opens the member list. */
  onMention?: (() => void) | undefined;
  onSend: () => void;
  canSend: boolean;
  sending?: boolean | undefined;
  disabled?: boolean | undefined;
  /** "Also send to #general", under the composer of a thread. */
  alsoSendTo?: ComposerAlsoSend | undefined;
  /** More controls at the end of the bottom row, before Send. */
  extraActions?: JSX.Element;
  /** Starts with the formatting toolbar hidden, as in a thread. */
  defaultToolbarHidden?: boolean | undefined;
  class?: string;
}

/**
 * The Slack message box: the formatting toolbar, the editor slot, and a bottom row with attach,
 * emoji, mention and Send. The editor owns Enter and Shift+Enter; the shell only renders.
 */
export function MessageComposer(props: MessageComposerProps): JSX.Element {
  const { t } = useText();
  const alsoSendId = createUniqueId();
  const [toolbar, setToolbar] = createSignal(!props.defaultToolbarHidden);
  const active = (format: ComposerFormat) => props.activeFormats?.includes(format) ?? false;
  return (
    <div class={cx("ws-composer", props.class)} data-disabled={props.disabled ? "" : undefined}>
      <Show when={props.notice}>
        <div class="ws-composer-notice">{props.notice}</div>
      </Show>
      <section class="ws-composer-box" aria-label={props.label}>
        <Show when={props.onFormat && toolbar()}>
          <div class="ws-composer-toolbar" role="toolbar" aria-label={t("workspace.composer.formatting")}>
            <For each={FORMATS}>
              {(item) => (
                <IconButton
                  variant="ghost"
                  size="icon-xs"
                  label={t(item.label)}
                  tooltip={`${t(item.label)} ${item.shortcut}`}
                  aria-pressed={active(item.format) ? "true" : "false"}
                  disabled={props.disabled}
                  onClick={() => props.onFormat?.(item.format)}
                >
                  <item.icon />
                </IconButton>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.attachments}>
          <div class="ws-composer-attachments">{props.attachments}</div>
        </Show>
        <div class="ws-composer-editor">{props.editor}</div>
        <div class="ws-composer-footer">
          <div class="ws-composer-tools">
            <Show when={props.onAttach}>
              {(attach) => (
                <IconButton
                  variant="ghost"
                  size="icon-xs"
                  class="ws-composer-attach"
                  label={t("workspace.composer.attach")}
                  disabled={props.disabled}
                  onClick={() => attach()()}
                >
                  <Paperclip />
                </IconButton>
              )}
            </Show>
            <Show when={props.onFormat}>
              <IconButton
                variant="ghost"
                size="icon-xs"
                label={t(toolbar() ? "workspace.composer.hideFormatting" : "workspace.composer.showFormatting")}
                aria-pressed={toolbar() ? "true" : "false"}
                onClick={() => setToolbar((shown) => !shown)}
              >
                <Type />
              </IconButton>
            </Show>
            <Show when={props.onEmoji}>
              {(emoji) => (
                <IconButton
                  variant="ghost"
                  size="icon-xs"
                  label={t("workspace.composer.emoji")}
                  disabled={props.disabled}
                  onClick={() => emoji()()}
                >
                  <SmilePlus />
                </IconButton>
              )}
            </Show>
            <Show when={props.onMention}>
              {(mention) => (
                <IconButton
                  variant="ghost"
                  size="icon-xs"
                  label={t("workspace.composer.mention")}
                  disabled={props.disabled}
                  onClick={() => mention()()}
                >
                  <AtSign />
                </IconButton>
              )}
            </Show>
          </div>
          <div class="ws-composer-send-group">
            {props.extraActions}
            <Button
              size="xs"
              class="ws-composer-send"
              data-ready={props.canSend ? "" : undefined}
              aria-label={t("workspace.composer.send")}
              disabled={!props.canSend || props.disabled}
              loading={props.sending}
              onClick={() => props.onSend()}
            >
              <Send aria-hidden="true" />
            </Button>
          </div>
        </div>
      </section>
      <Show when={props.alsoSendTo}>
        {(also) => (
          <label class="ws-composer-also" for={alsoSendId}>
            <Checkbox
              id={alsoSendId}
              checked={also().checked}
              onChange={(event) => also().onChange(event.currentTarget.checked)}
            />
            <span>{t("workspace.composer.alsoSend", { channel: also().channelName })}</span>
          </label>
        )}
      </Show>
    </div>
  );
}
