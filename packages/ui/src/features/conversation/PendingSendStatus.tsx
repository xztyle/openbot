import { Button } from "@openbot/ui";
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
 * The delivery line under a message the host has not stored yet. The status text is a polite live
 * region, so a reader hears the message go from sending to failed without moving focus. A message
 * whose repeat the host cannot detect offers no Retry: the first send may have arrived.
 */
export function PendingSendStatus(props: PendingSendStatusProps): JSX.Element {
  const { t } = useText();
  const noteId = `pending-send-note-${createUniqueId()}`;
  const blocked = () => !props.canEdit && Boolean(props.editBlockedReason);
  const label = () => {
    if (props.state === "held") return t("chat.send.held");
    if (props.state === "waiting") return t("chat.send.waiting");
    if (props.state === "sending") return t("chat.send.sending");
    return props.retrySafe ? t("chat.send.failed") : t("chat.send.unconfirmed");
  };
  return (
    <div class="pending-send-status" data-state={props.state}>
      <Show when={!props.updateRequired || props.state !== "failed"}>
        <span role="status" class="pending-send-label">
          {label()}
          <Show when={props.state === "failed" && props.error}>
            {(error) => <span class="pending-send-error">{error()}</span>}
          </Show>
        </span>
      </Show>
      <Show when={blocked() && (props.state === "held" || props.state === "failed")}>
        <span class="pending-send-note" id={noteId}>
          {props.editBlockedReason}
        </span>
      </Show>
      <Show when={props.state === "held"}>
        <Button
          variant="ghost"
          size="xs"
          disabled={!props.canEdit}
          aria-describedby={blocked() ? noteId : undefined}
          onClick={() => props.onUndo?.()}
        >
          {t("chat.send.undo")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!props.canEdit}
          aria-describedby={blocked() ? noteId : undefined}
          onClick={() => props.onEdit()}
        >
          {t("chat.send.edit")}
        </Button>
      </Show>
      <Show when={props.state === "failed"}>
        <Show when={props.retrySafe && !props.updateRequired}>
          <Button variant="ghost" size="xs" onClick={() => props.onRetry()}>
            {t("common.retry")}
          </Button>
        </Show>
        <Button
          variant="ghost"
          size="xs"
          disabled={!props.canEdit}
          aria-describedby={blocked() ? noteId : undefined}
          onClick={() => props.onEdit()}
        >
          {t("chat.send.edit")}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => props.onDismiss()}>
          {t("chat.send.dismiss")}
        </Button>
      </Show>
    </div>
  );
}
