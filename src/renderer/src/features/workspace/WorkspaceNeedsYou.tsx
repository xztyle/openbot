/*
 * "Needs you": every request of an agent that waits for the reader in the space that shows, from the
 * host's list. The top bar has a button with the count, Activity starts with the list, and a phone's
 * Home has a chip. A row opens the chat that answers the request.
 */
import { agentAttentionKey, isTicketAttention } from "@openbot/contracts/ipc";
import { NeedsYouButton, type NeedsYouRow, NeedsYouSection } from "@openbot/ui/features/workspace/NeedsYou";
import { useText } from "@openbot/ui/text";
import { createMemo } from "solid-js";
import { needsYouAction } from "../agents/needs-you";
import { useLoopDecisions } from "./loop-decisions-feed";
import { useWorkspace } from "./workspace-context";
import { memberById } from "./workspace-model";

/** The key of a loop decision's row, apart from the keys of agent requests. */
const LOOP_DECISION_KEY = "loop-decision\n";

/** The rows of the requests that wait for the reader, and the action that opens one. */
export function useNeedsYouRows() {
  const ws = useWorkspace();
  const { t, format } = useText();
  const loopDecisions = useLoopDecisions(ws);
  const decisionRows = createMemo((): NeedsYouRow[] =>
    loopDecisions.decisions().map((decision) => {
      const agent = ws.env.agents().find((candidate) => candidate.id === decision.requestedBy);
      const amount = decision.amountUsd === undefined ? "" : ` ${format.currencyUsd(decision.amountUsd)}`;
      return {
        key: `${LOOP_DECISION_KEY}${decision.id}`,
        member: memberById(ws.directory(), decision.requestedBy ?? "", agent?.name ?? t("chat.message.agentFallback")),
        kind: "decision",
        action:
          decision.subject === "question"
            ? t("workspace.loops.needsYou.answer")
            : t("workspace.loops.needsYou.approve", { amount }),
        summary: decision.title,
        where: t("workspace.view.loops"),
        at: decision.createdAt,
      };
    }),
  );
  const requestRows = createMemo((): NeedsYouRow[] =>
    ws.needsYou().map((item) => {
      const agent = ws.env.agents().find((candidate) => candidate.id === item.agentId);
      const place = ws.needsYouPlace(item);
      const channel = "channelId" in place ? ws.summary(place.channelId) : undefined;
      return {
        key: agentAttentionKey(item),
        member: memberById(ws.directory(), item.agentId, agent?.name ?? t("chat.message.agentFallback")),
        kind: isTicketAttention(item) ? "ticket" : item.kind,
        action: needsYouAction(item, t),
        summary: item.summary,
        where: channel ? t("workspace.activity.in", { channel: channel.name }) : t("workspace.activity.directMessage"),
        at: Date.parse(item.createdAt),
      };
    }),
  );
  const rows = createMemo(() => [...requestRows(), ...decisionRows()].sort((left, right) => left.at - right.at));
  const open = (key: string) => {
    if (key.startsWith(LOOP_DECISION_KEY)) {
      ws.openView("loops");
      return;
    }
    const item = ws.needsYou().find((candidate) => agentAttentionKey(candidate) === key);
    if (item) ws.openNeedsYou(item);
  };
  return { rows, open };
}

export function WorkspaceNeedsYouButton() {
  const needsYou = useNeedsYouRows();
  return <NeedsYouButton rows={needsYou.rows()} onOpen={needsYou.open} />;
}

export function WorkspaceNeedsYouSection() {
  const needsYou = useNeedsYouRows();
  return <NeedsYouSection rows={needsYou.rows()} onOpen={needsYou.open} />;
}
