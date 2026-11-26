/*
 * The reader's answer to a Motion ticket that waits on them, from Atelier: their own message to the
 * agent, which wakes it like any message of theirs, then the same text on the ticket as the owner's
 * comment (the host posts it), which also takes the ticket off Needs you.
 */
import {
  type AgentAttentionItem,
  TICKET_ANSWER_FIELD,
  TICKET_DECISION_FIELD,
  TICKET_VERDICT_FIELD,
  type TicketDecision,
  type TicketVerdict,
} from "@openbot/contracts/ipc";
import type { AppTranslate } from "@openbot/i18n";
import type { ChannelsPort } from "../channels/channels-port";

/**
 * The answers a waiting ticket offers, from why it waits (the host reads that from the ticket):
 * - an approval: Approve, and Decline with an optional note;
 * - an escalated review: Accept as is, and Send back with a note it needs;
 * - anything else, or a ticket the host has not read yet: only a written answer.
 * Each answer is the text that goes to the agent and on the ticket. An escalated review's answers also
 * carry a verdict: the host closes or reopens the ticket in Motion itself, so no agent has to. Each
 * button also says what it decides, so the host answers the ticket's decision card the same way.
 */
export interface TicketAnswers {
  primary?: { label: string; answer: string; verdict?: TicketVerdict; decision: TicketDecision };
  secondary?: {
    label: string;
    answer: (note: string) => string;
    noteRequired: boolean;
    verdict?: TicketVerdict;
    decision: TicketDecision;
  };
}

/**
 * What a waiting ticket asks, as the owner reads it: its plain summary when the host has read it,
 * else its title without the key ("EVE-40 · Title" gives "Title"). The key stays in the technical details.
 */
export function ticketTitle(item: Pick<AgentAttentionItem, "plain" | "summary">): string {
  const plain = item.plain?.asks;
  if (plain) return plain;
  const summary = item.summary ?? "";
  const parts = summary.split(" · ");
  return parts.length > 1 ? parts.slice(1).join(" · ") : summary;
}

export function ticketAnswers(item: Pick<AgentAttentionItem, "asks">, t: AppTranslate): TicketAnswers {
  if (item.asks === "approval")
    return {
      primary: {
        label: t("workspace.needsYou.ticket.approve"),
        answer: t("workspace.needsYou.ticket.approved"),
        decision: "approve",
      },
      secondary: {
        label: t("workspace.needsYou.ticket.decline"),
        answer: (note) =>
          note.trim()
            ? t("workspace.needsYou.ticket.declinedNote", { note: note.trim() })
            : t("workspace.needsYou.ticket.declined"),
        noteRequired: false,
        decision: "decline",
      },
    };
  if (item.asks === "review-escalated")
    return {
      primary: {
        label: t("workspace.needsYou.ticket.acceptAsIs"),
        answer: t("workspace.needsYou.ticket.acceptedAsIs"),
        verdict: "accept",
        decision: "approve",
      },
      secondary: {
        label: t("workspace.needsYou.ticket.sendBack"),
        answer: (note) => t("workspace.needsYou.ticket.sentBack", { note: note.trim() }),
        noteRequired: true,
        verdict: "send-back",
        decision: "decline",
      },
    };
  return {};
}

/**
 * Sends the answer. A failed message throws: the agent did not hear it. A failed comment answers
 * `commented: false`: the agent has the answer, only the copy on the ticket is missing.
 */
export async function answerTicket(
  port: Pick<ChannelsPort, "sendAgentMessage"> & { agent: Pick<ChannelsPort["agent"], "respondToPrompt"> },
  item: Pick<AgentAttentionItem, "agentId" | "requestId">,
  message: string,
  answer: string,
  verdict?: TicketVerdict,
  decision?: TicketDecision,
): Promise<{ commented: boolean }> {
  // The channels port reaches the host on the desktop and in the browser alike; `window.openbot` is the
  // desktop's preload only, and the browser client has none.
  await port.sendAgentMessage({ agentId: item.agentId, text: message, clientMessageId: crypto.randomUUID() });
  const answers = {
    [TICKET_ANSWER_FIELD]: [answer],
    ...(verdict ? { [TICKET_VERDICT_FIELD]: [verdict] } : {}),
    ...(decision ? { [TICKET_DECISION_FIELD]: [decision] } : {}),
  };
  return port.agent.respondToPrompt({ requestId: item.requestId, answers }).then(
    () => ({ commented: true }),
    () => ({ commented: false }),
  );
}
