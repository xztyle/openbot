import type { AttachmentSummary, InstalledSkill } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { ArrowRight, Button, Dialog, MessageCircle, X } from "@openbot/ui";
import { For, Show } from "solid-js";
import type { AgentMessage, AgentProfile, ChatActionMarkerStatus } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
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
 * A peek at a message between agents, drawn as a translucent layer over the chat: who messaged
 * whom, the full text, the message it answers, its replies, and a button that opens the real
 * conversation. The chat row shows no text, so the text is drawn only here.
 * It opens from the marker with a click or the keyboard, closes with Escape, a click outside or its
 * button, keeps focus inside while it is open, and gives focus back to the marker.
 */
export function AgentMessageDialog(props: AgentMessageDialogProps) {
  const { t } = useText();
  const name = (value: string | null) => value ?? t("chat.marker.unavailableAgent");
  const agentFor = (agentId: string | undefined) => props.agents.find((agent) => agent.id === agentId);
  const opened = () => props.entries.find((entry) => entry.message.exchange?.messageId === props.openedMessageId);
  /** The relation of an entry to the opened message, when it is not the opened message itself. */
  const relation = (entry: AgentMessageDialogEntry): AppTextKey | null => {
    const exchange = entry.message.exchange;
    if (!exchange || exchange.messageId === props.openedMessageId) return null;
    return exchange.replyToMessageId === props.openedMessageId
      ? "chat.messageDialog.reply"
      : "chat.messageDialog.answers";
  };
  /** The agents the reader can open a chat with: the other side of the opened message. */
  const counterparts = () => {
    const exchange = opened()?.message.exchange;
    if (!exchange) return [];
    const ids = exchange.direction === "incoming" ? [exchange.senderAgentId] : exchange.recipientAgentIds;
    return ids.flatMap((id) => {
      const agent = agentFor(id);
      return agent ? [agent] : [];
    });
  };
  /*
   * The caller unmounts the dialog on close, which skips the focus handoff of the dialog primitive,
   * and a browser may not focus a button on a click. So focus goes back to the row here, once the
   * dialog has left.
   */
  const close = () => {
    const target = props.restoreFocusTarget;
    props.onClose();
    if (!target) return;
    window.requestAnimationFrame(() => {
      if (target.isConnected) target.focus({ preventScroll: true });
    });
  };
  return (
    <Dialog.Root
      open={true}
      onOpenChange={(open) => {
        if (!open) close();
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
                onClick={close}
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
                    <Show when={relation(entry())}>
                      {(key) => <p class="agent-message-dialog-relation">{t(key())}</p>}
                    </Show>
                    <div class="agent-message-dialog-route">
                      <span class="agent-message-dialog-party">
                        <AgentAvatar
                          agent={agentFor(entry().message.exchange?.senderAgentId)}
                          class="agent-message-dialog-avatar"
                        />
                        <span class="agent-message-dialog-names">{name(entry().senderName)}</span>
                      </span>
                      <ArrowRight class="agent-message-dialog-arrow" aria-hidden="true" />
                      <span class="sr-only">{t("chat.messageDialog.to")}</span>
                      <For each={entry().message.exchange?.recipientAgentIds ?? []}>
                        {(agentId, index) => (
                          <span class="agent-message-dialog-party">
                            <AgentAvatar agent={agentFor(agentId)} class="agent-message-dialog-avatar" />
                            <span class="agent-message-dialog-names">
                              {name(entry().recipientNames[index()] ?? null)}
                            </span>
                          </span>
                        )}
                      </For>
                      <time class="agent-message-dialog-time" datetime={entry().message.createdAt}>
                        {entry().message.time}
                      </time>
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
            <Show when={counterparts().length > 0}>
              <footer class="agent-message-dialog-footer">
                <For each={counterparts()}>
                  {(agent) => (
                    <Button
                      variant="secondary"
                      type="button"
                      data-cuelume-tap="navigate"
                      onClick={() => props.onSelectAgent(agent.id)}
                    >
                      <MessageCircle aria-hidden="true" />
                      <span>
                        {counterparts().length > 1
                          ? t("chat.messageDialog.openWith", { name: agent.name })
                          : t("chat.messageDialog.open")}
                      </span>
                    </Button>
                  )}
                </For>
              </footer>
            </Show>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
