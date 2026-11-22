import { type ComponentProps, Dynamic, type JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { buttonVariants } from "../../button";
import { Popover } from "../../complex";
import { useText } from "../../text";
import { cx } from "../../utils";
import type { EmojiPickerProps } from "./EmojiPicker";

export type { EmojiPickerProps } from "./EmojiPicker";

// The picker and its emoji (about 70 KB) are their own chunk: a workspace that starts does not need
// them. A trigger loads them when it is pressed, and a failed load is tried again by the next one.
type PickerModule = typeof import("./EmojiPicker");
const [loadedPicker, setLoadedPicker] = createSignal<PickerModule>();
let pickerLoading = false;

/** Starts the load of the picker, such as when a trigger is pressed, so it is ready when it opens. */
export function preloadEmojiPicker(): void {
  if (pickerLoading) return;
  pickerLoading = true;
  import("./EmojiPicker").then(
    (module) => setLoadedPicker(() => module),
    () => {
      pickerLoading = false;
    },
  );
}

type EmojiData = typeof import("./emoji-data");
const [loadedData, setLoadedData] = createSignal<EmojiData>();
let dataLoading = false;

/**
 * The emoji list and its search, or undefined until it has loaded. The first read starts the load,
 * and a reactive reader runs again when it is there.
 */
export function emojiData(): EmojiData | undefined {
  if (!dataLoading) {
    dataLoading = true;
    import("./emoji-data").then(
      (module) => setLoadedData(() => module),
      () => {
        dataLoading = false;
      },
    );
  }
  return loadedData();
}

/** The emoji picker, which shows once its chunk has loaded. See `EmojiPicker` in `./EmojiPicker`. */
export function EmojiPicker(props: EmojiPickerProps): JSX.Element {
  preloadEmojiPicker();
  return (
    <Show
      when={loadedPicker()}
      fallback={<div class={cx("ws-emoji-picker ws-emoji-picker-loading", props.class)} aria-busy="true" />}
    >
      {(module) => <Dynamic component={module().EmojiPicker} {...props} />}
    </Show>
  );
}

type PopoverPlacement = ComponentProps<typeof Popover.Root>["placement"];

export interface EmojiPickerPopoverProps extends EmojiPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The content of the trigger button, such as an icon. */
  trigger: JSX.Element;
  /** The accessible name and tooltip of the trigger. */
  triggerLabel: string;
  triggerClass?: string | undefined;
  placement?: PopoverPlacement | undefined;
}

/** A trigger button and the emoji picker that it opens. A pick closes the popover. */
export function EmojiPickerPopover(props: EmojiPickerPopoverProps): JSX.Element {
  const { t } = useText();
  return (
    <Popover.Root
      open={props.open}
      onOpenChange={(open) => {
        if (open) preloadEmojiPicker();
        props.onOpenChange(open);
      }}
      placement={props.placement ?? "top-end"}
      gutter={4}
    >
      <Popover.Trigger
        class={cx(buttonVariants({ variant: "ghost", size: "icon-sm" }), "ui-icon-button", props.triggerClass)}
        aria-label={props.triggerLabel}
        title={props.triggerLabel}
        onPointerDown={preloadEmojiPicker}
        onFocus={preloadEmojiPicker}
      >
        {props.trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="ui-popover-menu-surface ws-emoji-popover" aria-label={t("workspace.emoji.label")}>
          <Show when={props.open}>
            <EmojiPicker
              onPick={(emoji) => {
                props.onPick(emoji);
                props.onOpenChange(false);
              }}
              recent={props.recent}
              skinTone={props.skinTone}
              onSkinToneChange={props.onSkinToneChange}
              autofocus={props.autofocus ?? true}
              class={props.class}
            />
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
