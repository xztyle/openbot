/*
 * What waits on the reader in an agent's DM that its chat has no card for: a Motion ticket that the
 * agent handed to the reader. The sidebar marks the DM as waiting for it, so the DM says what it is
 * and lets the reader answer it here: a ticket that asks for an approval has Approve and Decline,
 * any ticket has Reply. An answer goes to the agent as the reader's own message, which wakes it, and
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
import { answerTicket, ticketAsksApproval } from "./workspace-ticket-answer";

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
        const approval = () => ticketAsksApproval(item().summary);
        return (
          <div class="ws-agent-dm-wait" role="status">
            <div class="ws-agent-dm-wait-row">
              <Ticket class="ws-agent-dm-wait-icon" aria-hidden="true" />
              <span class="ws-agent-dm-wait-text">
                {t("workspace.needsYou.banner.ticket", { ticket: item().summary ?? "" })}
                {failed() === key() ? ` · ${failure() || t("workspace.today.answerFailed")}` : ""}
              </span>
              <Show when={approval()}>
                <Button
                  size="sm"
                  disabled={busy() !== null}
                  onClick={() => void answer(item(), t("workspace.needsYou.ticket.approved"))}
                >
                  <Check aria-hidden="true" />
                  {t("workspace.needsYou.ticket.approve")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy() !== null}
                  onClick={() => void answer(item(), t("workspace.needsYou.ticket.declined"))}
                >
                  <X aria-hidden="true" />
                  {t("workspace.needsYou.ticket.decline")}
                </Button>
              </Show>
              <Button
                variant={approval() ? "ghost" : "secondary"}
                size="sm"
                disabled={busy() !== null}
                onClick={() => {
                  setReply("");
                  setReplying(replying() === key() ? null : key());
                }}
              >
                {t("workspace.needsYou.ticket.reply")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void dismiss(item().requestId)}>
                {t("workspace.today.dismiss")}
              </Button>
            </div>
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
