/*
 * What waits on the reader in an agent's DM that its chat has no card for: a Motion ticket that the
 * agent handed to the reader. The sidebar marks the DM as waiting for it, so the DM says what it is,
 * why it waits (the host reads that from the ticket), and lets the reader answer it here: an approval
 * has Approve and Decline, an escalated review has Accept as is and Send back with a note, any ticket
 * has Reply. An answer goes to the agent as the reader's own message, which wakes it, and
 * on the ticket as the owner's comment (the host), and the ticket leaves Needs you. On a ticket that
 * waits for a decision, Reply is a question: it goes to the agent only, and the strip stays pinned
 * with its buttons ("you asked something · waiting for the answer") until the decision is answered
 * or dismissed. Writing in the chat does the same. Dismiss only clears the mark. Motion itself stays
 * one small link away.
 */
import {
  type AgentAttentionItem,
  isTicketAttention,
  type TicketDecision,
  type TicketVerdict,
} from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui/button";
import { Input } from "@openbot/ui/form";
import { Check, ExternalLink, LogIn, Ticket, X } from "@openbot/ui/icons";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { ticketDetail } from "./workspace-decisions";
import { answerTicket, ticketAnswers, ticketTitle } from "./workspace-ticket-answer";

/** How long the strip says "you asked" on its own, before the host's list says it. */
const ASKED_LOCAL_MS = 60_000;

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
  /**
   * The tickets the reader just asked about, by when, until the host says so too (`ownerAsked`): a
   * question goes to the agent only, and the ticket keeps waiting for the decision.
   */
  const [askedHere, setAskedHere] = createSignal<ReadonlyMap<string, number>>(new Map());
  const asked = (item: AgentAttentionItem) => {
    if (item.ownerAsked) return true;
    const at = askedHere().get(String(item.requestId));
    return at !== undefined && Date.now() - at < ASKED_LOCAL_MS;
  };
  // Once the host says the reader asked, its word counts: it says when the agent answered.
  createEffect(
    () => tickets().flatMap((item) => (item.ownerAsked ? [String(item.requestId)] : [])),
    (reported) => {
      if (!reported.some((key) => askedHere().has(key))) return;
      setAskedHere((map) => new Map([...map].filter(([key]) => !reported.includes(key))));
    },
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
  const answer = async (item: AgentAttentionItem, text: string, verdict?: TicketVerdict, decision?: TicketDecision) => {
    const key = String(item.requestId);
    const trimmed = text.trim();
    if (!trimmed || busy()) return;
    setFailed(null);
    setBusy(key);
    try {
      hide(key);
      const message = t("workspace.needsYou.ticket.message", { ticket: item.summary ?? "", answer: trimmed });
      const { commented } = await answerTicket(ws.channels.port(), item, message, trimmed, verdict, decision);
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
  /**
   * A question about a ticket that waits for a decision: the reader's message to the agent, nothing on
   * the ticket. The strip stays, with its buttons, until the decision itself is answered or dismissed.
   */
  const ask = async (item: AgentAttentionItem, text: string) => {
    const key = String(item.requestId);
    const trimmed = text.trim();
    if (!trimmed || busy()) return;
    setFailed(null);
    setBusy(key);
    try {
      await ws.channels.port().sendAgentMessage({
        agentId: item.agentId,
        text: t("workspace.needsYou.ticket.message", { ticket: item.summary ?? "", answer: trimmed }),
        clientMessageId: crypto.randomUUID(),
      });
      setAskedHere((map) => new Map([...map, [key, Date.now()]]));
      setReplying(null);
      setReply("");
    } catch (cause) {
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
        /** A ticket that waits for a decision: a reply to it is a question, not the answer. */
        const decides = () => answers().primary?.decision !== undefined;
        const title = () => ticketTitle(item());
        return (
          <section
            class="ws-agent-dm-wait"
            role="status"
            aria-label={t("workspace.needsYou.banner.waitsInMotion")}
            data-asked={asked(item()) ? "true" : undefined}
          >
            <header class="ws-agent-dm-wait-head">
              <span class="ws-agent-dm-wait-icon" aria-hidden="true">
                <Ticket />
              </span>
              <div class="ws-agent-dm-wait-heading">
                <span class="ws-agent-dm-wait-eyebrow">{t("workspace.needsYou.banner.waitsInMotion")}</span>
                <strong class="ws-agent-dm-wait-title">{title()}</strong>
              </div>
            </header>
            <Show when={failed() === key()}>
              <p class="ws-agent-dm-wait-error" role="alert">
                {failure() || t("workspace.today.answerFailed")}
              </p>
            </Show>
            <Show when={asked(item())}>
              <p class="ws-agent-dm-wait-asked">
                <strong>{t("workspace.needsYou.ticket.asked")}</strong>
                <span>{t("workspace.needsYou.ticket.askedNote")}</span>
              </p>
            </Show>
            <Show when={ticketDetail(item(), t)}>{(detail) => <p class="ws-agent-dm-wait-reason">{detail()}</p>}</Show>
            <div class="ws-agent-dm-wait-row">
              <Show when={answers().primary}>
                {(primary) => (
                  <Button
                    size="sm"
                    disabled={busy() !== null}
                    onClick={() => void answer(item(), primary().answer, primary().verdict, primary().decision)}
                  >
                    {primary().signIn ? <LogIn aria-hidden="true" /> : <Check aria-hidden="true" />}
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
              <Button
                variant="outline"
                size="sm"
                class="ws-agent-dm-wait-link"
                onClick={() => {
                  const url = item().url;
                  if (url) void ws.channels.port().openUrl(url);
                }}
              >
                <ExternalLink data-icon="inline-start" aria-hidden="true" />
                {t("workspace.needsYou.banner.openTicket")}
              </Button>
            </div>
            <Show when={noting() === key() ? answers().secondary : undefined}>
              {(secondary) => (
                <form
                  class="ws-agent-dm-wait-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (secondary().noteRequired && !note().trim()) return;
                    void answer(item(), secondary().answer(note()), secondary().verdict, secondary().decision);
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
                  void (decides() ? ask(item(), reply()) : answer(item(), reply()));
                }}
              >
                <Input
                  class="ws-agent-dm-wait-input"
                  value={reply()}
                  onInput={(event) => setReply(event.currentTarget.value)}
                  placeholder={
                    decides()
                      ? t("workspace.needsYou.ticket.askPlaceholder")
                      : t("workspace.needsYou.ticket.replyPlaceholder")
                  }
                  aria-label={
                    decides()
                      ? t("workspace.needsYou.ticket.askPlaceholder")
                      : t("workspace.needsYou.ticket.replyPlaceholder")
                  }
                  ref={(element: HTMLInputElement) => queueMicrotask(() => element.focus())}
                />
                <Button type="submit" size="sm" disabled={busy() !== null || !reply().trim()}>
                  {t("workspace.needsYou.ticket.send")}
                </Button>
              </form>
            </Show>
            {/* The raw reason and the ticket key are technical: only the reader opens them. */}
            <Show when={[item().summary, item().reason, item().escalationReason].filter(Boolean).join("\n")}>
              {(technical) => (
                <details class="ws-agent-dm-wait-technical">
                  <summary>{t("workspace.today.technicalDetails")}</summary>
                  <p>{technical()}</p>
                </details>
              )}
            </Show>
          </section>
        );
      }}
    </For>
  );
}
