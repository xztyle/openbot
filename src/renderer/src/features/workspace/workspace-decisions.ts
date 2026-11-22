/*
 * The one decision queue of the owner: every request of an agent that waits for them (questions,
 * approvals, browser steps, Motion tickets), every pending loop decision and every insight alert, from
 * every space, not only the one that shows. Today lists it with one-tap answers; the top bar's
 * "Needs you" and the phone's Today badge count the same list, so the numbers always agree and a
 * request of another space is never missed.
 */
import { agentAttentionKey, isTicketAttention, type LoopDecision } from "@openbot/contracts/ipc";
import type { NeedsYouRow } from "@openbot/ui/features/workspace/NeedsYou";
import type { TodayDecision } from "@openbot/ui/features/workspace/TodayView";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal } from "solid-js";
import { needsYouAction } from "../agents/needs-you";
import { useLoopDecisions } from "./loop-decisions-feed";
import { useWorkspace } from "./workspace-context";
import { insightAlerts, pollInsightAlerts, setInsightAlerts } from "./workspace-insight-alerts";
import { memberById } from "./workspace-model";

/** The loop decision that Today opened, for the Loops view to show first and scroll to. */
const [loopFocus, setLoopFocus] = createSignal<{ loopId: string; decisionId: string } | null>(null, {
  ownedWrite: true,
});

export { loopFocus, setLoopFocus };

type Sortable = Pick<TodayDecision, "blocking" | "amountUsd" | "at" | "key">;

/**
 * The order of the queue: what stops an agent's work first, then what spends the most money, then
 * the oldest. The key breaks a tie, so the order never jumps between reads.
 */
export function compareDecisions(left: Sortable, right: Sortable): number {
  if (left.blocking !== right.blocking) return left.blocking ? -1 : 1;
  const money = (right.amountUsd ?? 0) - (left.amountUsd ?? 0);
  if (money !== 0) return money;
  if (left.at !== right.at) return left.at - right.at;
  return left.key.localeCompare(right.key);
}

const LOOP_KEY = "loop-decision\n";
const ALERT_KEY = "insight:";

/** Every decision that waits for the reader, in queue order, with what each one opens and answers. */
export function useDecisionQueue() {
  const ws = useWorkspace();
  const { t, format } = useText();
  const loops = useLoopDecisions(ws);
  // The insight alerts of the owner and the admins: money spent with no sale, a goal behind.
  pollInsightAlerts(() => {
    const read = ws.channels.port().agent.workspaceInsight;
    return ws.viewAvailable("insights") && read ? async () => (await read({ days: 1 })).alerts : undefined;
  });
  const agentName = (agentId: string | undefined) =>
    ws.env.agents().find((agent) => agent.id === agentId)?.name ?? t("chat.message.agentFallback");
  /** "Trading · #launch", or only the place when the workspace has one space. */
  const where = (spaceId: string | undefined, place: string | undefined) => {
    const space = ws.spaces.available() && spaceId ? ws.spaces.space(spaceId)?.name : undefined;
    return [space, place].filter(Boolean).join(" · ") || undefined;
  };
  const openSpaceView = (spaceId: string, view: "loops" | "insights") => {
    if (ws.spaces.available() && ws.spaces.current() !== spaceId) ws.spaces.select(spaceId);
    ws.openView(view);
  };

  const requests = createMemo((): TodayDecision[] =>
    (ws.env.needsYou?.() ?? []).map((item) => {
      const place = ws.needsYouPlace(item);
      const channel = "channelId" in place ? ws.summary(place.channelId) : undefined;
      const spaceId =
        "channelId" in place ? ws.spaces.channelSpace(place.channelId) : ws.spaces.agentSpace(item.agentId);
      const ticket = isTicketAttention(item);
      const approval =
        item.kind === "approval"
          ? (decision: "accept" | "decline") => () =>
              ws.channels.port().agent.respondToApproval({ requestId: item.requestId, decision })
          : undefined;
      const browser = item.kind === "browser-takeover" || item.kind === "sign-in" || item.kind === "secret";
      return {
        key: agentAttentionKey(item),
        member: memberById(ws.directory(), item.agentId, agentName(item.agentId)),
        kind: ticket ? "ticket" : item.kind,
        action: needsYouAction(item, t),
        summary: item.summary,
        where: where(
          spaceId,
          channel ? t("workspace.activity.in", { channel: channel.name }) : t("workspace.activity.directMessage"),
        ),
        blocking: !ticket,
        at: Date.parse(item.createdAt) || 0,
        approve: approval?.("accept"),
        reject: approval?.("decline"),
        openLabel: browser
          ? t("workspace.today.takeOver")
          : item.kind === "question" || item.kind === "form"
            ? t("workspace.today.answer")
            : t("workspace.needsYou.open"),
        open: () => ws.openNeedsYou(item),
      };
    }),
  );

  const decide = async (decision: LoopDecision, approve: boolean, note?: string) => {
    const run = ws.channels.port().agent.workspaceLoopAction;
    if (!run) throw new Error(t("workspace.loops.failed"));
    await run({ kind: "decide", decisionId: decision.id, approve, ...(note ? { note } : {}) });
    loops.refresh();
  };
  const decisions = createMemo((): TodayDecision[] =>
    loops.decisions().map((decision) => {
      const question = decision.subject === "question";
      const amount = decision.amountUsd === undefined ? "" : ` ${format.currencyUsd(decision.amountUsd)}`;
      return {
        key: `${LOOP_KEY}${decision.id}`,
        member: memberById(ws.directory(), decision.requestedBy ?? "", agentName(decision.requestedBy)),
        kind: "decision",
        action: question ? t("workspace.loops.needsYou.answer") : t("workspace.loops.needsYou.approve", { amount }),
        summary: [decision.title, decision.detail].filter(Boolean).join(" — "),
        where: where(decision.spaceId, t("workspace.view.loops")),
        amountUsd: decision.amountUsd,
        blocking: true,
        at: decision.createdAt,
        ...(question
          ? { answer: (text: string) => decide(decision, true, text) }
          : { approve: () => decide(decision, true), reject: () => decide(decision, false) }),
        openLabel: t("workspace.needsYou.open"),
        open: () => {
          setLoopFocus({ loopId: decision.loopId, decisionId: decision.id });
          openSpaceView(decision.spaceId, "loops");
        },
      };
    }),
  );

  const alerts = createMemo((): TodayDecision[] =>
    insightAlerts().map((alert) => ({
      key: `${ALERT_KEY}${alert.id}`,
      member: { id: "insight", kind: "agent", name: t("insight.title"), avatarSeed: "insight" },
      kind: "alert",
      action: alert.text,
      where: where(alert.spaceId, t("insight.needsYou.alert")),
      blocking: false,
      at: Date.parse(alert.createdAt) || 0,
      reject: async () => {
        const run = ws.channels.port().agent.workspaceInsightAction;
        if (!run) throw new Error(t("workspace.today.answerFailed"));
        const report = await run({ kind: "alert-dismiss", alertId: alert.id });
        setInsightAlerts(report.alerts);
      },
      rejectLabel: t("workspace.today.dismiss"),
      openLabel: t("workspace.needsYou.open"),
      open: () => openSpaceView(alert.spaceId, "insights"),
    })),
  );

  const queue = createMemo(() => [...requests(), ...decisions(), ...alerts()].sort(compareDecisions));
  /** The same queue as the rows of the top bar's list. */
  const rows = createMemo((): NeedsYouRow[] =>
    queue().map((decision) => ({
      key: decision.key,
      member: decision.member,
      kind: decision.kind,
      action: decision.action,
      summary: decision.summary,
      where: decision.where,
      at: decision.at,
    })),
  );
  const open = (key: string) =>
    queue()
      .find((decision) => decision.key === key)
      ?.open();
  return { queue, rows, open };
}
