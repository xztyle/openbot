/*
 * The reader's answer to a Motion ticket that waits on them, from Atelier: their own message to the
 * agent, which wakes it like any message of theirs, then the same text on the ticket as the owner's
 * comment (the host posts it), which also takes the ticket off Needs you.
 */
import { type AgentAttentionItem, TICKET_ANSWER_FIELD } from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import type { ChannelsPort } from "../channels/channels-port";

/** A ticket whose title asks the owner to approve something ("Aprobar afiliación…", "Approve the spend"). */
export function ticketAsksApproval(summary: string | undefined): boolean {
  return /\b(aprob|aprueb|approv)/iu.test(summary ?? "");
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
): Promise<{ commented: boolean }> {
  // The channels port reaches the host on the desktop and in the browser alike; `window.openbot` is the
  // desktop's preload only, and the browser client has none.
  if (!port.sendAgentMessage) throw new Error(currentText().t("webClient.error.desktopOnly"));
  await port.sendAgentMessage({ agentId: item.agentId, text: message, clientMessageId: crypto.randomUUID() });
  return port.agent.respondToPrompt({ requestId: item.requestId, answers: { [TICKET_ANSWER_FIELD]: [answer] } }).then(
    () => ({ commented: true }),
    () => ({ commented: false }),
  );
}
