import { IconButton, Pencil, RotateCcw, TriangleAlert, Undo2, X } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createUniqueId, Show } from "solid-js";

export interface PendingSendStatusProps {
  /**
   * `held` is the few seconds a message to a working agent stays with the client, so Undo and Edit
   * can still take it back. After that the host steers it into the running turn and cannot.
   */
  state: "held" | "waiting" | "sending" | "failed";
  /** Why the send failed, when the host or the connection said. */
  error?: string | null;
  /** The composer shows the update notice; keep recovery actions without a second error. */
  updateRequired?: boolean;
  /** The host drops a repeated send of this message, so Retry cannot store it twice. */
  retrySafe: boolean;
  /**
   * Whether Undo and Edit can put the message back in the composer, ahead of what is written there.
   * False while the composer holds a queued message that is being edited.
   */
  canEdit: boolean;
  /** Why Undo and Edit are off, shown as text so a touch screen sees it too. */
  editBlockedReason?: string | null | undefined;
  onRetry: () => void;
  onEdit: () => void;
  onDismiss: () => void;
  /** Takes back a held message: it returns to the composer with the files it carried. */
  onUndo?: () => void;
}

/**
 * The delivery status beside the time of a message the host has not stored yet. A send in flight
 * shows nothing; only a held message (with Undo and Edit) and a failure show. The status text is a polite live region that stays while the
 * send runs, so a reader hears the failure without moving focus. A message whose repeat the host
 * cannot detect offers no Retry: the first send may have arrived.
 */
export function PendingSendStatus(props: PendingSendStatusProps): JSX.Element {
  const { t } = useText();
  const noteId = `pending-send-note-${createUniqueId()}`;
  const failed = () => props.state === "failed";
  const held = () => props.state === "held";
  const blocked = () => !props.canEdit && Boolean(props.editBlockedReason);
  return (
    <div class="pending-send-status" data-state={props.state}>
      <span role="status" class="pending-send-label">
        <Show when={held()}>{t("chat.send.held")}</Show>
        <Show when={failed() && !props.updateRequired}>
          <TriangleAlert aria-hidden="true" />
          {props.retrySafe ? t("chat.send.failed") : t("chat.send.unconfirmed")}
          <Show when={props.error}>{(error) => <span class="pending-send-error">{error()}</span>}</Show>
        </Show>
      </span>
      <Show when={blocked() && (held() || failed())}>
        <span class="pending-send-note" id={noteId}>
          {props.editBlockedReason}
        </span>
      </Show>
      <Show when={held()}>
        <IconButton
          variant="ghost"
          size="icon-xs"
          label={t("chat.send.undo")}
          disabled={!props.canEdit}
          aria-describedby={blocked() ? noteId : undefined}
          onClick={() => props.onUndo?.()}
        >
          <Undo2 aria-hidden="true" />
        </IconButton>
        <IconButton
          variant="ghost"
          size="icon-xs"
          label={t("chat.send.edit")}
          disabled={!props.canEdit}
          aria-describedby={blocked() ? noteId : undefined}
          onClick={() => props.onEdit()}
        >
          <Pencil aria-hidden="true" />
        </IconButton>
      </Show>
      <Show when={failed()}>
        <Show when={props.retrySafe && !props.updateRequired}>
          <IconButton variant="ghost" size="icon-xs" label={t("common.retry")} onClick={() => props.onRetry()}>
            <RotateCcw aria-hidden="true" />
          </IconButton>
        </Show>
        <IconButton
          variant="ghost"
          size="icon-xs"
          label={t("chat.send.edit")}
          disabled={!props.canEdit}
          aria-describedby={blocked() ? noteId : undefined}
          onClick={() => props.onEdit()}
        >
          <Pencil aria-hidden="true" />
        </IconButton>
        <IconButton variant="ghost" size="icon-xs" label={t("chat.send.dismiss")} onClick={() => props.onDismiss()}>
          <X aria-hidden="true" />
        </IconButton>
      </Show>
    </div>
  );
}
