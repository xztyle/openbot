import type { AttachmentSummary, InstalledSkill } from "@openbot/contracts/ipc";
import { Button, Dialog, X } from "@openbot/ui";
import { For, Show } from "solid-js";
import type { AgentMessage, AgentProfile, ChatActionMarkerStatus } from "../../data";
import { useText } from "../../text";
import { STATUS_LABELS } from "./ChatActionMarker";
import { MessageBody } from "./MessageRendering";

/** One message of the exchange, with the names the caller already resolved. */
export interface AgentMessageDialogEntry {
  /** The message as the chat holds it, so its text, files and quote draw as they do in the chat. */
  message: AgentMessage;
  /** The sender's name, or null when the agent no longer exists. */
  senderName: string | null;
  /** The recipients' names. A name is null for an agent that no longer exists. */
  recipientNames: Array<string | null>;
  status: ChatActionMarkerStatus;
}

export interface AgentMessageDialogProps {
  /** The messages to show, oldest first: the request, the message that was opened, its replies. */
  entries: readonly AgentMessageDialogEntry[];
  /** The message whose marker was opened. The dialog marks it. */
  openedMessageId: string;
  agents: AgentProfile[];
  skills?: InstalledSkill[] | undefined;
  onClose: () => void;
  /** Gets focus when the dialog closes: the marker that opened it. */
  restoreFocusTarget?: HTMLElement | null | undefined;
  onSelectAgent: (agentId: string) => void;
  onOpenLink: (url: string) => void;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal" | "download") => void;
  onOpenSharedFile?: ((path: string) => void) | undefined;
  onOpenWorkspaceFile?: ((path: string) => void) | undefined;
  onDownload?: ((attachment: AttachmentSummary) => void) | undefined;
}

/**
 * The full text of a message between agents, and of the reply when there is one. The marker in the
 * chat shows one redacted line; this is where nothing is cut. It opens from the marker with a click
 * or the keyboard, closes with Escape or its button, and gives focus back to the marker.
 */
export function AgentMessageDialog(props: AgentMessageDialogProps) {
  const { t } = useText();
  const name = (value: string | null) => value ?? t("chat.marker.unavailableAgent");
  return (
    <Dialog.Root
      open={true}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="agent-message-dialog-backdrop">
          <Dialog.Content
            class="agent-message-dialog"
            as="section"
            onCloseAutoFocus={(event) => {
              const target = props.restoreFocusTarget;
              if (!target?.isConnected) return;
              event.preventDefault();
              target.focus({ preventScroll: true });
            }}
          >
            <header class="agent-message-dialog-header">
              <Dialog.Title class="agent-message-dialog-title">{t("chat.messageDialog.title")}</Dialog.Title>
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label={t("common.close")}
                data-cuelume-tap="close"
                onClick={props.onClose}
              >
                <X aria-hidden="true" />
              </Button>
            </header>
            <ol class="agent-message-dialog-list">
              <For each={props.entries} keyed={(entry) => entry.message.id}>
                {(entry) => (
                  <li
                    class="agent-message-dialog-entry"
                    data-opened={entry().message.exchange?.messageId === props.openedMessageId ? "" : undefined}
                  >
                    <div class="agent-message-dialog-meta">
                      <span class="agent-message-dialog-names">
                        {t("chat.messageDialog.route", {
                          sender: name(entry().senderName),
                          recipients: entry().recipientNames.map(name).join(", "),
                        })}
                      </span>
                      <time datetime={entry().message.createdAt}>{entry().message.time}</time>
                      <span class="agent-message-dialog-status">{t(STATUS_LABELS[entry().status])}</span>
                    </div>
                    <div class="agent-message-dialog-body">
                      <Show
                        when={entry().message.body.trim() || (entry().message.attachments?.length ?? 0) > 0}
                        fallback={<p class="agent-message-dialog-empty">{t("chat.messageDialog.empty")}</p>}
                      >
                        <MessageBody
                          message={entry().message}
                          agents={props.agents}
                          skills={props.skills}
                          onSelectAgent={props.onSelectAgent}
                          onOpenLink={props.onOpenLink}
                          onPreview={props.onPreview}
                          onAttachmentAction={props.onAttachmentAction}
                          onOpenSharedFile={props.onOpenSharedFile}
                          onOpenWorkspaceFile={props.onOpenWorkspaceFile}
                          onDownload={props.onDownload}
                        />
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ol>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
