import type { JSX } from "@solidjs/web";
import { createUniqueId, Show } from "solid-js";
import { Alert, AlertContent, AlertDescription, AlertIcon } from "./alert";
import { Button, IconButton } from "./button";
import { Dialog } from "./complex";
import { TriangleAlert, X } from "./icons";
import { useText } from "./text";
import { cx } from "./utils";

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
  /** Content at the start of the footer instead of the step, such as a link to another flow. */
  footerStart?: JSX.Element;
  /** The element that takes the focus when the dialog opens. By default the first field of the body. */
  initialFocus?: () => HTMLElement | null | undefined;
  class?: string;
  children: JSX.Element;
}

const FIELD_SELECTOR = "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])";

/**
 * The one frame of a flow that makes or changes something: a title, a short description, the
 * fields, an inline error, and Cancel with the primary action. A dialog on a computer and a full
 * screen sheet on a phone. See `docs/ux/standard.md`.
 */
export function FormDialog(props: FormDialogProps): JSX.Element {
  const { t } = useText();
  const formId = createUniqueId();
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
        <Dialog.Overlay class="ui-form-dialog-overlay">
          <Dialog.Content
            as="section"
            class={cx("ui-form-dialog", props.class)}
            data-size={props.size ?? "md"}
            aria-busy={props.busy ? "true" : undefined}
            onOpenAutoFocus={(event: Event) => {
              // The first field takes the focus, not the close button in the corner.
              event.preventDefault();
              const target = props.initialFocus?.() ?? body?.querySelector<HTMLElement>(FIELD_SELECTOR);
              requestAnimationFrame(() => target?.focus({ preventScroll: true }));
            }}
          >
            <header class="ui-form-dialog-header">
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
                <Button
                  type="button"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => (props.onSecondary ? props.onSecondary() : close())}
                >
                  {props.secondaryLabel ?? t("common.cancel")}
                </Button>
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
