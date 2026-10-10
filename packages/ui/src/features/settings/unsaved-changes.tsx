import { ConfirmDialog } from "@openbot/ui";
import { createEffect, createSignal } from "solid-js";
import { useText } from "../../text";

export interface UnsavedGuardOptions {
  /** Whether the form holds changes that were not saved. */
  dirty: () => boolean;
  /** Called when the person chose to discard, before the waiting leave runs. */
  onDiscard?: (() => void) | undefined;
  /**
   * Whether the browser asks to confirm when the tab or window closes while there are unsaved
   * changes. Only a web page sets this: a desktop window must close without a prompt.
   */
  warnOnPageClose?: (() => boolean) | undefined;
}

export interface UnsavedGuard {
  /**
   * Runs `leave` now when nothing is unsaved. Otherwise it asks first, and `leave` runs only when
   * the person chooses to discard.
   */
  request(leave: () => void): void;
  /** A question is waiting for its answer. */
  pending(): boolean;
  /** The person chose to discard: the waiting leave runs. */
  discard(): void;
  /** The person chose to keep editing: the waiting leave is dropped. */
  keep(): void;
}

/**
 * One rule for every way out of a form: Back, Close, another agent, Escape, a click outside. The
 * form passes each leave through `request`, and shows `DiscardChangesDialog` once.
 */
export function createUnsavedGuard(options: UnsavedGuardOptions): UnsavedGuard {
  // An object, not the function itself: a signal setter calls a function it is given.
  const [waiting, setWaiting] = createSignal<{ leave: () => void } | null>(null);
  // The handler exists only while there is something to lose, so a clean page closes at once.
  createEffect(
    () => options.dirty() && (options.warnOnPageClose?.() ?? false),
    (active) => {
      if (!active) return;
      const handler = (event: BeforeUnloadEvent) => {
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", handler);
      return () => window.removeEventListener("beforeunload", handler);
    },
  );
  // A save that finished while the question was open leaves nothing to discard.
  createEffect(
    () => options.dirty(),
    (dirty) => {
      if (!dirty) setWaiting(null);
    },
  );
  return {
    request(leave) {
      if (!options.dirty()) {
        leave();
        return;
      }
      setWaiting({ leave });
    },
    pending: () => waiting() !== null,
    discard() {
      const target = waiting();
      setWaiting(null);
      options.onDiscard?.();
      target?.leave();
    },
    keep() {
      setWaiting(null);
    },
  };
}

/**
 * The question that goes with a guard. Focus starts on Keep editing, so a stray Enter does not throw
 * the work away.
 */
export function DiscardChangesDialog(props: {
  guard: UnsavedGuard;
  /** What is lost, when the default sentence is too general. */
  description?: string | undefined;
}) {
  const { t } = useText();
  return (
    <ConfirmDialog
      open={props.guard.pending()}
      onCancel={() => props.guard.keep()}
      onConfirm={() => props.guard.discard()}
      title={t("common.unsaved.title")}
      description={props.description ?? t("common.unsaved.description")}
      confirmLabel={t("common.unsaved.discard")}
      cancelLabel={t("common.unsaved.keepEditing")}
      initialFocus="cancel"
    />
  );
}
