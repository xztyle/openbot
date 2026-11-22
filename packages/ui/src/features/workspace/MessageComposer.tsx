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
  Quote,
  Send,
  SmilePlus,
  SquareCode,
  Strikethrough,
  Type,
} from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmojiPickerPopover, type EmojiPickerProps } from "./emoji-picker-lazy";

export type ComposerFormat =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "link"
  | "bulleted-list"
  | "numbered-list"
  | "quote"
  | "code-block";

const FORMATS = [
  { format: "bold", label: "workspace.composer.bold", icon: Bold, shortcut: "⌘B" },
  { format: "italic", label: "workspace.composer.italic", icon: Italic, shortcut: "⌘I" },
  { format: "strike", label: "workspace.composer.strike", icon: Strikethrough, shortcut: "⌘⇧X" },
  { format: "link", label: "workspace.composer.link", icon: Link, shortcut: "⌘⇧U" },
  { format: "bulleted-list", label: "workspace.composer.bulletedList", icon: List, shortcut: "⌘⇧8" },
  { format: "numbered-list", label: "workspace.composer.numberedList", icon: ListOrdered, shortcut: "⌘⇧7" },
  { format: "quote", label: "workspace.composer.quote", icon: Quote, shortcut: "⌘⇧9" },
  { format: "code", label: "workspace.composer.code", icon: Code, shortcut: "⌘⇧C" },
  { format: "code-block", label: "workspace.composer.codeBlock", icon: SquareCode, shortcut: "⌘⌥⇧C" },
] as const satisfies readonly { format: ComposerFormat; label: string; icon: typeof Bold; shortcut: string }[];

/** The formatting toolbar at the top of a message box. Each press applies its format to the selection. */
export function ComposerFormatToolbar(props: {
  onFormat: (format: ComposerFormat) => void;
  /** The formats at the caret, to show pressed buttons. */
  activeFormats?: readonly ComposerFormat[] | undefined;
  disabled?: boolean | undefined;
  class?: string | undefined;
}): JSX.Element {
  const { t } = useText();
  const active = (format: ComposerFormat) => props.activeFormats?.includes(format) ?? false;
  return (
    <div class={cx("ws-composer-toolbar", props.class)} role="toolbar" aria-label={t("workspace.composer.formatting")}>
      <For each={FORMATS}>
        {(item) => (
          <IconButton
            variant="ghost"
            size="icon-xs"
            label={t(item.label)}
            tooltip={`${t(item.label)} ${item.shortcut}`}
            aria-pressed={active(item.format) ? "true" : "false"}
            disabled={props.disabled}
            onClick={() => props.onFormat(item.format)}
          >
            <item.icon />
          </IconButton>
        )}
      </For>
    </div>
  );
}

/** Slack's "Aa": shows or hides the formatting toolbar. */
export function ComposerFormatToggle(props: { shown: boolean; onChange: (shown: boolean) => void }): JSX.Element {
  const { t } = useText();
  return (
    <IconButton
      variant="ghost"
      size="icon-xs"
      label={t(props.shown ? "workspace.composer.hideFormatting" : "workspace.composer.showFormatting")}
      aria-pressed={props.shown ? "true" : "false"}
      onClick={() => props.onChange(!props.shown)}
    >
      <Type />
    </IconButton>
  );
}

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
  /** The emoji picker of the toolbar's emoji button. It takes the place of `onEmoji`. */
  emojiPicker?: Omit<EmojiPickerProps, "class" | "autofocus"> | undefined;
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
  /** Whether the formatting toolbar shows, when the caller keeps the choice, such as across reloads. */
  toolbarShown?: boolean | undefined;
  onToolbarShownChange?: ((shown: boolean) => void) | undefined;
  /**
   * The box edits a message in place, as Slack's: Cancel and Save take the place of Send. Save calls
   * `onSend`.
   */
  edit?: { onCancel: () => void } | undefined;
  class?: string;
}

/**
 * The Slack message box: the formatting toolbar, the editor slot, and a bottom row with attach,
 * emoji, mention and Send. The editor owns Enter and Shift+Enter; the shell only renders.
 */
export function MessageComposer(props: MessageComposerProps): JSX.Element {
  const { t } = useText();
  const alsoSendId = createUniqueId();
  const [localToolbar, setLocalToolbar] = createSignal(!props.defaultToolbarHidden);
  const toolbar = () => props.toolbarShown ?? localToolbar();
  const setToolbar = (shown: boolean) => {
    if (props.onToolbarShownChange) props.onToolbarShownChange(shown);
    else setLocalToolbar(shown);
  };
  const [emojiOpen, setEmojiOpen] = createSignal(false);
  return (
    <div class={cx("ws-composer", props.class)} data-disabled={props.disabled ? "" : undefined}>
      <Show when={props.notice}>
        <div class="ws-composer-notice">{props.notice}</div>
      </Show>
      <section class="ws-composer-box" aria-label={props.label}>
        <Show when={toolbar() ? props.onFormat : undefined}>
          {(onFormat) => (
            <ComposerFormatToolbar
              onFormat={onFormat()}
              activeFormats={props.activeFormats}
              disabled={props.disabled}
            />
          )}
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
              <ComposerFormatToggle shown={toolbar()} onChange={setToolbar} />
            </Show>
            <Show when={props.emojiPicker}>
              {(picker) => (
                <EmojiPickerPopover
                  open={emojiOpen()}
                  onOpenChange={setEmojiOpen}
                  trigger={<SmilePlus aria-hidden="true" />}
                  triggerLabel={t("workspace.composer.emoji")}
                  triggerClass="ws-composer-emoji"
                  placement="top-start"
                  onPick={(emoji) => picker().onPick(emoji)}
                  recent={picker().recent}
                  skinTone={picker().skinTone}
                  onSkinToneChange={picker().onSkinToneChange}
                />
              )}
            </Show>
            <Show when={!props.emojiPicker && props.onEmoji}>
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
            <Show
              when={props.edit}
              fallback={
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
              }
            >
              {(edit) => (
                <>
                  <Button size="xs" variant="secondary" disabled={props.sending} onClick={() => edit().onCancel()}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    size="xs"
                    class="ws-composer-save"
                    disabled={!props.canSend || props.disabled}
                    loading={props.sending}
                    onClick={() => props.onSend()}
                  >
                    {t("common.save")}
                  </Button>
                </>
              )}
            </Show>
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
