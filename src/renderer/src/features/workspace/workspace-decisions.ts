/*
 * The one decision queue of the owner: every request of an agent that waits for them (questions,
 * approvals, browser steps, Motion tickets), every pending loop decision and every insight alert, from
 * every space, not only the one that shows. Today lists it with one-tap answers; the top bar's
 * "Needs you" and the phone's Today badge count the same list, so the numbers always agree and a
 * request of another space is never missed.
 */
import type { DecisionQueueSource } from "@openbot/contracts/agent-learning";
import { agentAttentionKey, isTicketAttention, type LoopDecision } from "@openbot/contracts/ipc";
import type { NeedsYouRow } from "@openbot/ui/features/workspace/NeedsYou";
import type { TodayDecision } from "@openbot/ui/features/workspace/TodayView";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, untrack } from "solid-js";
import { needsYouAction } from "../agents/needs-you";
import { useLoopDecisions } from "./loop-decisions-feed";
import { useWorkspace } from "./workspace-context";
import { useGuardrails, useLearningQueue } from "./workspace-host-feeds";
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
const LEARNING_KEY = "learning:";
const PAUSE_KEY = "pause:";
const INJECTION_KEY = "injection:";

/** The blocked injections that the reader dismissed, at most this many per workspace. */
const SEEN_LIMIT = 200;
const seenCache = new Map<string, readonly string[]>();
const [seenVersion, setSeenVersion] = createSignal(0, { ownedWrite: true });

function seenStorageKey(workspaceKey: string): string {
  return `openbot:today-seen-injections:${workspaceKey}`;
}

/**
 * The blocked injections that the reader dismissed in this workspace. One list for every surface, so
 * Today, the top bar, the sidebar and the phone's tab count the same, and kept on this device, so a
 * dismissed one does not come back when Today opens again.
 */
export function seenInjections(workspaceKey: string): ReadonlySet<string> {
  seenVersion();
  let ids = seenCache.get(workspaceKey);
  if (!ids) {
    try {
      const saved = JSON.parse(window.localStorage.getItem(seenStorageKey(workspaceKey)) ?? "[]");
      ids = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
    } catch {
      ids = [];
    }
    seenCache.set(workspaceKey, ids);
  }
  return new Set(ids);
}

export function dismissInjection(workspaceKey: string, eventId: string): void {
  // Another tab of the reader may have dismissed others since this one read the list: they stay.
  const known = seenCache.get(workspaceKey) ?? [];
  seenCache.delete(workspaceKey);
  const stored = untrack(() => seenInjections(workspaceKey));
  const ids = [...new Set([...known, ...stored, eventId])].slice(-SEEN_LIMIT);
  seenCache.set(workspaceKey, ids);
  try {
    window.localStorage.setItem(seenStorageKey(workspaceKey), JSON.stringify(ids));
  } catch {
    // Private mode: it stays dismissed until the page reloads.
  }
  setSeenVersion((version) => version + 1);
}

// A dismissal in another tab of the reader leaves this one's counts too.
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(seenStorageKey(""))) return;
    seenCache.delete(event.key.slice(seenStorageKey("").length));
    setSeenVersion((version) => version + 1);
  });

/** What a learning proposal asks, by where it comes from. */
const PROPOSAL_KEY = {
  learning: "workspace.today.proposal.learning",
  playbook: "workspace.today.proposal.playbook",
  review: "workspace.today.proposal.review",
} as const satisfies Record<DecisionQueueSource, string>;

/**
 * The dollar amount of a money approval's effect line, for the money order of the queue and the card:
 * "Hotmart · pay 19.00 USD · product X", "Meta ads · daily budget 10 → 50 USD" (the new amount,
 * after the arrow) or "Pay (19 USD)". The host always writes the currency code. A bare "$" is not
 * dollars: in Colombia or Mexico it is the peso, and in a shell command "$1" is an argument. An
 * amount in another currency gives none.
 */
export function amountIn(text: string): number | undefined {
  const line = text.split("\n")[0] ?? "";
  const after = line.split("→").at(-1) ?? line;
  const match = /(?:^|[\s(])(\d[\d,]*(?:\.\d+)?)\s?USD\b/u.exec(after);
  const value = match?.[1] ? Number(match[1].replaceAll(",", "")) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

/** Every decision that waits for the reader, in queue order, with what each one opens and answers. */
export function useDecisionQueue() {
  const ws = useWorkspace();
  const { t, format } = useText();
  const loops = useLoopDecisions(ws);
  // The insight alerts of the owner and the admins: money spent with no sale, a goal behind.
  pollInsightAlerts(ws, () => {
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
    // The view first: it marks the step for Back before the space changes the place on screen.
    ws.openView(view);
    if (ws.spaces.available() && ws.spaces.current() !== spaceId) ws.spaces.select(spaceId);
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
      // A money approval of the trust gate says its effect: the target, the amount, the budget after.
      const held =
        item.kind === "approval"
          ? (ws.env.approvals?.() ?? []).find(
              (entry) => entry.agentId === item.agentId && String(entry.requestId) === String(item.requestId),
            )
          : undefined;
      const effect = held?.command?.trim() || undefined;
      return {
        key: agentAttentionKey(item),
        member: memberById(ws.directory(), item.agentId, agentName(item.agentId)),
        kind: ticket ? "ticket" : item.kind,
        action: needsYouAction(item, t),
        summary: effect ?? item.summary,
        detail: effect ? (held?.reason ?? undefined) : undefined,
        amountUsd: effect ? amountIn(effect) : undefined,
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

  // The learning queue: memory, playbook and instruction proposals that wait for the owner's OK.
  const learning = useLearningQueue(ws);
  const proposals = createMemo((): TodayDecision[] =>
    learning.value().map((entry) => {
      const decideEntry = (decision: "approve" | "dismiss") => async () => {
        const calls = ws.env.efficiency?.();
        if (!calls) throw new Error(t("workspace.today.answerFailed"));
        await calls.decideQueue(entry.id, decision);
        learning.update((list) => list.filter((candidate) => candidate.id !== entry.id));
      };
      return {
        key: `${LEARNING_KEY}${entry.id}`,
        member: entry.agentId
          ? memberById(ws.directory(), entry.agentId, agentName(entry.agentId))
          : { id: "learning", kind: "agent", name: t("workspace.today.learning"), avatarSeed: "learning" },
        kind: "proposal",
        action: t(PROPOSAL_KEY[entry.source]),
        summary: entry.title,
        detail: entry.detail,
        where: where(entry.spaceId ?? undefined, undefined),
        blocking: false,
        at: Date.parse(entry.createdAt) || 0,
        approve: decideEntry("approve"),
        approveLabel: t("workspace.today.apply"),
        reject: decideEntry("dismiss"),
        rejectLabel: t("workspace.today.dismiss"),
        openLabel: t("workspace.needsYou.open"),
        open: () => ws.openView("reviews"),
      };
    }),
  );

  // The guardrails: an agent or a space that a budget paused, and a blocked prompt injection.
  const guardrails = useGuardrails(ws);
  const guarded = createMemo((): TodayDecision[] => {
    const view = guardrails.value();
    if (!view) return [];
    const pauses = view.pauses.map((pause): TodayDecision => {
      const agent = pause.scope === "agent";
      return {
        key: `${PAUSE_KEY}${pause.scope}:${pause.id}`,
        member: agent
          ? memberById(ws.directory(), pause.id, agentName(pause.id))
          : { id: pause.id, kind: "agent", name: ws.spaces.space(pause.id)?.name ?? pause.id, avatarSeed: pause.id },
        kind: "pause",
        action: t(agent ? "workspace.today.pausedAgent" : "workspace.today.pausedSpace"),
        summary: pause.detail,
        where: where(agent ? ws.spaces.agentSpace(pause.id) : pause.id, undefined),
        blocking: true,
        at: Date.parse(pause.since) || 0,
        approve: async () => {
          const calls = ws.env.trust?.();
          if (!calls) throw new Error(t("workspace.today.answerFailed"));
          guardrails.set(await calls.guardrails.resume(pause.scope, pause.id));
        },
        approveLabel: t("trust.guardrails.resume"),
        openLabel: t("workspace.needsYou.open"),
        open: () => ws.openView("trust"),
      };
    });
    const day = Date.now() - 24 * 3_600_000;
    const workspaceKey = ws.env.storageKey();
    const seen = seenInjections(workspaceKey);
    const injections = view.events
      .filter((event) => event.kind === "injection-blocked" && Date.parse(event.at) >= day && !seen.has(event.id))
      .map(
        (event): TodayDecision => ({
          key: `${INJECTION_KEY}${event.id}`,
          member: event.agentId
            ? memberById(ws.directory(), event.agentId, agentName(event.agentId))
            : { id: "guardrails", kind: "agent", name: t("trust.title"), avatarSeed: "guardrails" },
          kind: "injection",
          action: t("workspace.today.injection"),
          summary: event.summary,
          where: where(event.spaceId ?? (event.agentId ? ws.spaces.agentSpace(event.agentId) : undefined), undefined),
          blocking: false,
          at: Date.parse(event.at) || 0,
          // The host keeps the event; the owner who read it does not need it here again.
          reject: async () => dismissInjection(workspaceKey, event.id),
          rejectLabel: t("workspace.today.dismiss"),
          openLabel: t("workspace.needsYou.open"),
          open: () => ws.openView("trust"),
        }),
      );
    return [...pauses, ...injections];
  });

  const queue = createMemo(() =>
    [...requests(), ...decisions(), ...alerts(), ...proposals(), ...guarded()].sort(compareDecisions),
  );
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
