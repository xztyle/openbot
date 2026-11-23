/*
 * What waits on the reader in an agent's DM that its chat has no card for: a Motion ticket that the
 * agent handed to the reader. The sidebar marks the DM as waiting for it, so the DM says what it is,
 * why it waits (the host reads that from the ticket), and lets the reader answer it here: an approval
 * has Approve and Decline, an escalated review has Accept as is and Send back with a note, any ticket
 * has Reply. An answer goes to the agent as the reader's own message, which wakes it, and
 * on the ticket as the owner's comment (the host), and the ticket leaves Needs you. Dismiss only
 * clears the mark. Motion itself stays one small link away.
 */
import { type AgentAttentionItem, isTicketAttention } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui/button";
import { Input } from "@openbot/ui/form";
import { Check, ExternalLink, Ticket, X } from "@openbot/ui/icons";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, Show } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { answerTicket, ticketAnswers } from "./workspace-ticket-answer";

export function WorkspaceAgentWaits(props: { agentId: string }) {
  const ws = useWorkspace();
  const { t, errorMessage } = useText();
  const [gone, setGone] = createSignal<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = createSignal<string | null>(null);
  /** What went wrong with the last answer, when the failure says it; otherwise the general sentence. */
  const [failure, setFailure] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  const [replying, setReplying] = createSignal<string | null>(null);
  const [reply, setReply] = createSignal("");
  /** The ticket whose decline or send-back note field is open. */
  const [noting, setNoting] = createSignal<string | null>(null);
  const [note, setNote] = createSignal("");
  const tickets = createMemo(() =>
    (ws.env.needsYou?.() ?? []).filter(
      (item) => item.agentId === props.agentId && isTicketAttention(item) && !gone().has(String(item.requestId)),
    ),
  );
  const hide = (key: string) => setGone((keys) => new Set([...keys, key]));
  const show = (key: string) => setGone((keys) => new Set([...keys].filter((entry) => entry !== key)));
  const dismiss = async (requestId: string | number) => {
    const key = String(requestId);
    setFailed(null);
    hide(key);
    try {
      await ws.channels.port().agent.respondToPrompt({ requestId, answers: {} });
    } catch (cause) {
      show(key);
      setFailure(errorMessage(cause, t("workspace.today.answerFailed")));
      setFailed(key);
    }
  };
  /** The reader's answer: their message to the agent first (it wakes the agent), then the ticket. */
  const answer = async (item: AgentAttentionItem, text: string) => {
    const key = String(item.requestId);
    const trimmed = text.trim();
    if (!trimmed || busy()) return;
    setFailed(null);
    setBusy(key);
    try {
      hide(key);
      const message = t("workspace.needsYou.ticket.message", { ticket: item.summary ?? "", answer: trimmed });
      const { commented } = await answerTicket(ws.channels.port(), item, message, trimmed);
      setReplying(null);
      setReply("");
      setNoting(null);
      setNote("");
      // The agent has the answer; the comment on the ticket is a copy, so its failure only shows.
      if (!commented) {
        setFailure(t("workspace.today.answerFailed"));
        setFailed(key);
      }
    } catch (cause) {
      show(key);
      setFailure(errorMessage(cause, t("workspace.today.answerFailed")));
      setFailed(key);
    } finally {
      setBusy(null);
    }
  };
  return (
    <For each={tickets()} keyed={(item) => String(item.requestId)}>
      {(item) => {
        const key = () => String(item().requestId);
        const answers = () => ticketAnswers(item(), t);
        return (
          <div class="ws-agent-dm-wait" role="status">
            <div class="ws-agent-dm-wait-row">
              <Ticket class="ws-agent-dm-wait-icon" aria-hidden="true" />
              <span class="ws-agent-dm-wait-text">
                {t("workspace.needsYou.banner.ticket", { ticket: item().summary ?? "" })}
                {failed() === key() ? ` · ${failure() || t("workspace.today.answerFailed")}` : ""}
              </span>
              <Show when={answers().primary}>
                {(primary) => (
                  <Button size="sm" disabled={busy() !== null} onClick={() => void answer(item(), primary().answer)}>
                    <Check aria-hidden="true" />
                    {primary().label}
                  </Button>
                )}
              </Show>
              <Show when={answers().secondary}>
                {(secondary) => (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy() !== null}
                    aria-expanded={noting() === key() ? "true" : "false"}
                    onClick={() => {
                      setNote("");
                      setReplying(null);
                      setNoting(noting() === key() ? null : key());
                    }}
                  >
                    <X aria-hidden="true" />
                    {secondary().label}
                  </Button>
                )}
              </Show>
              <Button
                variant={answers().primary ? "ghost" : "secondary"}
                size="sm"
                disabled={busy() !== null}
                onClick={() => {
                  setReply("");
                  setNoting(null);
                  setReplying(replying() === key() ? null : key());
                }}
              >
                {t("workspace.needsYou.ticket.reply")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void dismiss(item().requestId)}>
                {t("workspace.today.dismiss")}
              </Button>
            </div>
            <Show when={item().reason}>{(reason) => <p class="ws-agent-dm-wait-reason">{reason()}</p>}</Show>
            <Show when={noting() === key() ? answers().secondary : undefined}>
              {(secondary) => (
                <form
                  class="ws-agent-dm-wait-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (secondary().noteRequired && !note().trim()) return;
                    void answer(item(), secondary().answer(note()));
                  }}
                >
                  <Input
                    class="ws-agent-dm-wait-input"
                    value={note()}
                    onInput={(event) => setNote(event.currentTarget.value)}
                    placeholder={
                      secondary().noteRequired
                        ? t("workspace.today.notePlaceholderRequired")
                        : t("workspace.today.notePlaceholder")
                    }
                    aria-label={t("workspace.today.noteLabel")}
                    ref={(element: HTMLInputElement) => queueMicrotask(() => element.focus())}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={busy() !== null || (secondary().noteRequired && !note().trim())}
                  >
                    {secondary().label}
                  </Button>
                </form>
              )}
            </Show>
            <Show when={replying() === key()}>
              <form
                class="ws-agent-dm-wait-reply"
                onSubmit={(event) => {
                  event.preventDefault();
                  void answer(item(), reply());
                }}
              >
                <Input
                  class="ws-agent-dm-wait-input"
                  value={reply()}
                  onInput={(event) => setReply(event.currentTarget.value)}
                  placeholder={t("workspace.needsYou.ticket.replyPlaceholder")}
                  aria-label={t("workspace.needsYou.ticket.replyPlaceholder")}
                  ref={(element: HTMLInputElement) => queueMicrotask(() => element.focus())}
                />
                <Button type="submit" size="sm" disabled={busy() !== null || !reply().trim()}>
                  {t("workspace.needsYou.ticket.send")}
                </Button>
              </form>
            </Show>
            <Button
              variant="link"
              size="xs"
              class="ws-agent-dm-wait-link"
              onClick={() => {
                const url = item().url;
                if (url) void ws.channels.port().openUrl(url);
              }}
            >
              {t("workspace.needsYou.banner.openTicket")}
              <ExternalLink aria-hidden="true" />
            </Button>
          </div>
        );
      }}
    </For>
  );
}
