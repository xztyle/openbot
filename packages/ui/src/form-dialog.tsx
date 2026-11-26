import type { JSX } from "@solidjs/web";
import { createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { Alert, AlertContent, AlertDescription, AlertIcon } from "./alert";
import { Button, IconButton } from "./button";
import { Dialog } from "./complex";
import { ChevronLeft, TriangleAlert, X } from "./icons";
import { sheetDragToDismiss } from "./sheet-drag";
import { useText } from "./text";
import { cx, PHONE_LAYOUT_QUERY } from "./utils";

export type FormDialogSize = "sm" | "md" | "lg";

export interface FormDialogStep {
  current: number;
  total: number;
}

export interface FormDialogProps {
  open: boolean;
  /** Escape, an overlay click, the close button and Cancel call it with `false`. Not while `busy`. */
  onOpenChange: (open: boolean) => void;
  title: JSX.Element;
  /** One sentence under the title: what the thing is for. */
  description?: JSX.Element;
  /** `sm` 440 px, `md` 520 px (the default), `lg` 640 px. A phone shows every size full screen. */
  size?: FormDialogSize;
  /** "Step 1 of 2" at the start of the footer, for a flow in steps. */
  step?: FormDialogStep;
  /** A failure of the last submit. It shows above the footer, in the reader's language. */
  error?: JSX.Element | null;
  /** The submit runs: the primary button spins and the dialog does not close. */
  busy?: boolean;
  /**
   * The primary action. Without it the dialog has no footer, as a picker that acts on a row.
   * Use a verb with its object: "Create channel", "Add people", "Save".
   */
  submitLabel?: JSX.Element;
  submitDisabled?: boolean;
  /** Enter in a field and the primary button call it, unless it is disabled or busy. */
  onSubmit?: () => void;
  /** The button left of the primary. Cancel by default; "Back" in a later step. */
  secondaryLabel?: JSX.Element;
  /** Runs instead of closing the dialog, as Back in a later step does. */
  onSecondary?: () => void;
  /** No secondary button: a dialog whose primary action is Done, such as a list to manage. */
  hideSecondary?: boolean;
  /** Content at the start of the footer instead of the step, such as a link to another flow. */
  footerStart?: JSX.Element;
  /** A Back button before the title, for a dialog that opened from another one (a picker, a list). */
  onBack?: (() => void) | undefined;
  /** Called when the dialog closes, before the focus goes back to the opener (Kobalte's `onCloseAutoFocus`). */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
  /** The element that takes the focus when the dialog opens. By default the first field of the body. */
  initialFocus?: () => HTMLElement | null | undefined;
  /**
   * False keeps the dialog open on a click or focus outside it, for a form the user types into: a
   * password manager's autofill popup sits outside the dialog. Escape, Cancel and the close button
   * still close it.
   */
  dismissible?: boolean;
  class?: string;
  children: JSX.Element;
}

/** Whether the window is phone width now. The sheet follows a rotation or a resize. */
function createPhoneWidth(): () => boolean {
  const query = typeof window === "undefined" ? undefined : window.matchMedia?.(PHONE_LAYOUT_QUERY);
  const [phone, setPhone] = createSignal(query?.matches ?? false);
  if (query) {
    const change = (event: MediaQueryListEvent) => setPhone(event.matches);
    query.addEventListener("change", change);
    onCleanup(() => query.removeEventListener("change", change));
  }
  return phone;
}

const FIELD_SELECTOR =
  "input:not([type=hidden]):not([type=file]):not([disabled]), textarea:not([disabled]), select:not([disabled])";

/**
 * The one frame of a flow that makes or changes something: a title, a short description, the
 * fields, an inline error, and Cancel with the primary action. A dialog on a computer and, on a phone,
 * the sheet of `ActionSheet` at full height. See `docs/ux/standard.md`.
 */
export function FormDialog(props: FormDialogProps): JSX.Element {
  const { t } = useText();
  const formId = createUniqueId();
  const phone = createPhoneWidth();
  let body: HTMLDivElement | undefined;
  const close = () => {
    if (!props.busy) props.onOpenChange(false);
  };
  const submit = () => {
    if (props.busy || props.submitDisabled || !props.onSubmit) return;
    props.onSubmit();
  };
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (open) props.onOpenChange(true);
        else close();
      }}
    >
      <Dialog.Portal>
        {/* On a phone, the overlay sheet of `ActionSheet`: it rises from the bottom edge, under the status bar. */}
        <Dialog.Overlay class={cx("ui-form-dialog-overlay", phone() && "ui-sheet-overlay")}>
          <Dialog.Content
            as="section"
            class={cx("ui-form-dialog", props.class)}
            // On a phone a drag down on the sheet closes it, as on the action sheet. Not while busy.
            ref={(element: HTMLElement) => {
              if (phone()) sheetDragToDismiss(close)(element);
            }}
            data-size={props.size ?? "md"}
            aria-busy={props.busy ? "true" : undefined}
            onCloseAutoFocus={(event: Event) => props.onCloseAutoFocus?.(event)}
            onInteractOutside={(event: Event) => {
              if (props.dismissible === false) event.preventDefault();
            }}
            onOpenAutoFocus={(event: Event) => {
              // The first field takes the focus, not the close button in the corner.
              event.preventDefault();
              // A dialog with no field, as the shortcuts sheet, takes the focus itself: it reads its title,
              // and the focus leaves the page behind, which the modal hides from a screen reader.
              const target =
                props.initialFocus?.() ??
                body?.querySelector<HTMLElement>(FIELD_SELECTOR) ??
                (event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
              requestAnimationFrame(() => target?.focus({ preventScroll: true }));
            }}
          >
            <Show when={phone()}>
              <span class="ui-sheet-handle" aria-hidden="true" />
            </Show>
            <header class="ui-form-dialog-header">
              <Show when={props.onBack}>
                {(back) => (
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    class="ui-form-dialog-back"
                    label={t("common.back")}
                    disabled={props.busy}
                    onClick={() => back()()}
                  >
                    <ChevronLeft />
                  </IconButton>
                )}
              </Show>
              <div class="ui-form-dialog-heading">
                <Dialog.Title as="h2" class="ui-form-dialog-title">
                  {props.title}
                </Dialog.Title>
                <Show when={props.description}>
                  <Dialog.Description class="ui-form-dialog-description">{props.description}</Dialog.Description>
                </Show>
              </div>
              <IconButton
                variant="ghost"
                size="icon-sm"
                class="ui-form-dialog-close"
                label={t("common.close")}
                disabled={props.busy}
                onClick={close}
              >
                <X />
              </IconButton>
            </header>
            <form
              id={formId}
              class="ui-form-dialog-form"
              novalidate
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <div ref={body} class="ui-form-dialog-body">
                {props.children}
              </div>
            </form>
            <Show when={props.error}>
              {(error) => (
                <Alert tone="danger" report={false} role="alert" class="ui-form-dialog-error">
                  <AlertIcon>
                    <TriangleAlert />
                  </AlertIcon>
                  <AlertContent>
                    <AlertDescription>{error()}</AlertDescription>
                  </AlertContent>
                </Alert>
              )}
            </Show>
            <Show when={props.submitLabel}>
              <footer class="ui-form-dialog-footer">
                <span class="ui-form-dialog-footer-start">
                  <Show when={props.footerStart} fallback={<FormDialogStepLabel step={props.step} />}>
                    {props.footerStart}
                  </Show>
                </span>
                <Show when={!props.hideSecondary}>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={props.busy}
                    onClick={() => (props.onSecondary ? props.onSecondary() : close())}
                  >
                    {props.secondaryLabel ?? t("common.cancel")}
                  </Button>
                </Show>
                <Button type="submit" form={formId} loading={props.busy} disabled={props.submitDisabled}>
                  {props.submitLabel}
                </Button>
              </footer>
            </Show>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FormDialogStepLabel(props: { step: FormDialogStep | undefined }): JSX.Element {
  const { t } = useText();
  return (
    <Show when={props.step}>
      {(step) => (
        <span class="ui-form-dialog-step">{t("common.step", { current: step().current, total: step().total })}</span>
      )}
    </Show>
  );
}

export interface FormSectionProps {
  /** A short heading for a group of fields. */
  title?: JSX.Element;
  description?: JSX.Element;
  class?: string;
  children: JSX.Element;
}

/** A group of fields in a form dialog or a settings page, with an optional heading. */
export function FormSection(props: FormSectionProps): JSX.Element {
  return (
    <fieldset class={cx("ui-form-section", props.class)}>
      <Show when={props.title}>
        <legend class="ui-form-section-title">{props.title}</legend>
      </Show>
      <Show when={props.description}>
        <p class="ui-form-section-description">{props.description}</p>
      </Show>
      {props.children}
    </fieldset>
  );
}
