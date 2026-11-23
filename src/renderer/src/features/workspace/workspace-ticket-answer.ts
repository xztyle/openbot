/*
 * The reader's answer to a Motion ticket that waits on them, from Atelier: their own message to the
 * agent, which wakes it like any message of theirs, then the same text on the ticket as the owner's
 * comment (the host posts it), which also takes the ticket off Needs you.
 */
import { type AgentAttentionItem, TICKET_ANSWER_FIELD } from "@openbot/contracts/ipc";
import { conversationPort } from "../conversation/conversation-port";
import type { WorkspaceController } from "./workspace-controller";

/** A ticket whose title asks the owner to approve something ("Aprobar afiliación…", "Approve the spend"). */
export function ticketAsksApproval(summary: string | undefined): boolean {
  return /\b(aprob|aprueb|approv)/iu.test(summary ?? "");
}

/**
 * Sends the answer. A failed message throws: the agent did not hear it. A failed comment answers
 * `commented: false`: the agent has the answer, only the copy on the ticket is missing.
 */
export async function answerTicket(
  ws: Pick<WorkspaceController, "channels">,
  item: AgentAttentionItem,
  message: string,
  answer: string,
): Promise<{ commented: boolean }> {
  await conversationPort().agent.sendMessage({
    agentId: item.agentId,
    text: message,
    clientMessageId: crypto.randomUUID(),
  });
  return ws.channels
    .port()
    .agent.respondToPrompt({ requestId: item.requestId, answers: { [TICKET_ANSWER_FIELD]: [answer] } })
    .then(
      () => ({ commented: true }),
      () => ({ commented: false }),
    );
}
