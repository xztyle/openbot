import { type InsightGoal, insightGoalPace, type WorkspaceInsight } from "@openbot/contracts/ipc";
import { Dynamic, type JSX } from "@solidjs/web";
import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";
import { Button } from "../../button";
import { Input } from "../../form";
import {
  ArrowRight,
  Check,
  CircleCheck,
  CirclePause,
  CirclePlus,
  CircleQuestionMark,
  Coins,
  Globe2,
  Hand,
  KeyRound,
  LayoutDashboard,
  LogIn,
  ShieldCheck,
  Sparkles,
  Square,
  Sunrise,
  Target,
  Ticket,
  TriangleAlert,
  Zap,
} from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import type { NeedsYouKind } from "./NeedsYou";
import { MemberAvatar } from "./WorkspaceAvatar";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { useCost, useRecentTime, useWorkspaceDuration } from "./workspace-format";
import type { WorkspaceMember } from "./workspace-types";

/**
 * One thing that waits for the owner, from any space: an agent's question or approval, a browser
 * step, a loop decision or an insight alert. The one-tap answers are there when the host takes them
 * from here; `open` always goes to the exact place where the request waits.
 */
export interface TodayDecision {
  key: string;
  /** The agent that asks. */
  member: WorkspaceMember;
  kind: NeedsYouKind;
  /** What the owner does, in a few words: "Approve $40", "Sign in on accounts.google.com". */
  action: string;
  /** What the agent asks, when it is safe to show. */
  summary?: string | undefined;
  /** A second line under the summary, such as why a payment is asked or what a proposal changes. */
  detail?: string | undefined;
  /** Where it waits: "Trading · #launch". */
  where?: string | undefined;
  /** Money that the answer lets an agent spend. */
  amountUsd?: number | undefined;
  /** The agent's work stops until the owner answers. */
  blocking: boolean;
  at: number;
  approve?: (() => Promise<void>) | undefined;
  /** The label of `approve` when it is not "Approve", such as "Apply" or "Resume". */
  approveLabel?: string | undefined;
  reject?: (() => Promise<void>) | undefined;
  /** The label of `reject` when it is not "Decline", such as "Dismiss" for an alert. */
  rejectLabel?: string | undefined;
  /** A written answer, such as for a loop question. */
  answer?: ((text: string) => Promise<void>) | undefined;
  /** The label of `open`: "Open", "Answer", "Take over". */
  openLabel: string;
  open: () => void;
}

/** An agent that works now. */
export interface TodayWorker {
  member: WorkspaceMember;
  /** What it does, in plain words. */
  task: string;
  /** Where: "#launch" or "Trading · #launch". */
  where?: string | undefined;
  startedAt?: number | undefined;
  todayCostUsd?: number | undefined;
  /** Stops the run. Absent where it cannot be stopped from here: the agent's chat has Stop then. */
  onStop?: (() => void) | undefined;
  stopping?: boolean | undefined;
  onOpen: () => void;
}

/** Something an agent made lately: a page, an app, a file. */
export interface TodayShipped {
  id: string;
  title: string;
  agent?: WorkspaceMember | undefined;
  at: number;
  onOpen: () => void;
}

/** A step of the first-run guide. */
export interface TodayStep {
  id: string;
  title: string;
  hint: string;
  done: boolean;
  onSelect: () => void;
}

export interface TodayViewProps {
  /** The reader's first name, for the greeting. */
  name: string;
  decisions: readonly TodayDecision[];
  working: readonly TodayWorker[];
  /** The insight report of the last 7 days, or null where the reader may not see it or it did not load. */
  report: WorkspaceInsight | null;
  /** What agents made lately, newest first. */
  shipped: readonly TodayShipped[];
  /** What the agents cost today, from the fleet. */
  todayCostUsd?: number | undefined;
  /** The first-run guide. Empty when every step is done or the owner hid it. */
  steps?: readonly TodayStep[] | undefined;
  onHideSteps?: (() => void) | undefined;
  onOpenMoney?: (() => void) | undefined;
  onOpenGoals?: (() => void) | undefined;
  onOpenBriefing?: (() => void) | undefined;
  onOpenShipped?: (() => void) | undefined;
  /** Asks an agent or assigns work: the command bar. */
  onAsk?: (() => void) | undefined;
  /** At the end of the header, such as the account button on a phone. */
  actions?: JSX.Element;
  onBack?: (() => void) | undefined;
  class?: string;
}

const KIND_ICON = {
  question: CircleQuestionMark,
  form: CircleQuestionMark,
  "api-key": KeyRound,
  approval: ShieldCheck,
  "browser-takeover": Globe2,
  "sign-in": LogIn,
  secret: KeyRound,
  decision: ShieldCheck,
  ticket: Ticket,
  alert: TriangleAlert,
  proposal: Sparkles,
  pause: CirclePause,
  injection: ShieldCheck,
} as const satisfies Record<NeedsYouKind, typeof Hand>;

/** The key of the greeting for an hour of the day. */
function greetingKey(hour: number) {
  if (hour < 5) return "workspace.today.greeting.night" as const;
  if (hour < 12) return "workspace.today.greeting.morning" as const;
  if (hour < 18) return "workspace.today.greeting.afternoon" as const;
  return "workspace.today.greeting.evening" as const;
}

/**
 * Keeps the focus in a list of decision cards when the card that holds it goes away, as one does
 * after Approve, Decline or an answer: the next card takes it, or the heading when none is left.
 * Without it the focus fell to the page, and a keyboard or a screen reader started at the top.
 */
export function createDecisionFocus(items: () => readonly unknown[]) {
  let section: HTMLElement | undefined;
  let held: { card: HTMLElement; index: number } | null = null;
  const cards = () => Array.from(section?.querySelectorAll<HTMLElement>(".ws-today-decision") ?? []);
  createEffect(
    () => items().length,
    () => {
      const lost = held;
      if (!lost || lost.card.isConnected) return;
      held = null;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const rest = cards();
        const target = rest[Math.min(lost.index, rest.length - 1)] ?? section?.querySelector<HTMLElement>("h3");
        target?.focus();
      });
    },
  );
  return {
    ref: (element: HTMLElement) => {
      section = element;
    },
    onFocusIn: (event: FocusEvent) => {
      const card = event.target instanceof Element ? event.target.closest<HTMLElement>(".ws-today-decision") : null;
      held = card ? { card, index: cards().indexOf(card) } : null;
    },
    onFocusOut: (event: FocusEvent) => {
      // A removed card's focus leaves with no next element: keep it held for the effect above.
      const next = event.relatedTarget;
      if (next instanceof Node && !section?.contains(next)) held = null;
    },
  };
}

/**
 * Today: the owner's home. What waits for them from every space, with one-tap answers; the agents
 * that work now, with Stop; and the briefing as cards: spend, goals and what the agents made. A new
 * workspace also gets a short guide to goals, loops, the briefing and costs.
 */
export function TodayView(props: TodayViewProps): JSX.Element {
  const { t, format } = useText();
  // A phone mounts Today twice (its tab, and the pane behind it): the heading ids must not clash.
  const uid = createUniqueId();
  const cost = useCost();
  const now = new Date();
  const title = () => t(greetingKey(now.getHours()), { name: props.name });
  const sentAt = () => {
    const at = Date.parse(props.report?.briefing.lastSentAt ?? "");
    return Number.isFinite(at) ? at : undefined;
  };
  const decisionFocus = createDecisionFocus(() => props.decisions);
  return (
    <section class={cx("ws-view ws-today", props.class)} aria-label={t("workspace.view.today")}>
      <WorkspacePaneHeader
        icon={<Sunrise aria-hidden="true" />}
        title={title()}
        subtitle={format.date(now.getTime(), { weekday: "long", month: "long", day: "numeric" })}
        onBack={props.onBack}
        actions={props.actions}
      />
      <div class="ws-view-scroll ws-today-scroll">
        <section
          ref={decisionFocus.ref}
          class="ws-today-section"
          aria-labelledby={`ws-today-waiting-${uid}`}
          onFocusIn={decisionFocus.onFocusIn}
          onFocusOut={decisionFocus.onFocusOut}
        >
          <h3
            id={`ws-today-waiting-${uid}`}
            class="ws-today-heading"
            tabindex="-1"
            data-tone={props.decisions.length ? "warn" : undefined}
          >
            <Hand aria-hidden="true" />
            <span>{t("workspace.today.waiting", { count: props.decisions.length })}</span>
          </h3>
          <Show
            when={props.decisions.length > 0}
            fallback={
              <p class="ws-today-clear">
                <CircleCheck aria-hidden="true" />
                {t("workspace.today.nothingWaits")}
              </p>
            }
          >
            <ul class="ws-today-decisions">
              <For each={props.decisions} keyed={(decision) => decision.key}>
                {(decision) => (
                  <li>
                    <TodayDecisionCard decision={decision()} />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
        {/* What waits on the owner comes first; the guide of a new workspace follows it. */}
        <Show when={props.steps?.length}>
          <TodayGuide steps={props.steps ?? []} onHide={props.onHideSteps} />
        </Show>
        <section class="ws-today-section" aria-labelledby={`ws-today-working-${uid}`}>
          <h3 id={`ws-today-working-${uid}`} class="ws-today-heading">
            <Zap aria-hidden="true" />
            <span>{t("workspace.today.working", { count: props.working.length })}</span>
            <Show when={props.onAsk}>
              {(ask) => (
                <Button variant="ghost" size="sm" class="ws-today-heading-action" onClick={() => ask()()}>
                  <CirclePlus aria-hidden="true" />
                  {t("workspace.today.ask")}
                </Button>
              )}
            </Show>
          </h3>
          <Show
            when={props.working.length > 0}
            fallback={<p class="ws-today-quiet">{t("workspace.today.nobodyWorking")}</p>}
          >
            <ul class="ws-today-workers">
              <For each={props.working} keyed={(worker) => worker.member.id}>
                {(worker) => (
                  <li>
                    <TodayWorkerRow worker={worker()} />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
        <section class="ws-today-section" aria-labelledby={`ws-today-briefing-${uid}`}>
          <h3 id={`ws-today-briefing-${uid}`} class="ws-today-heading">
            <Sunrise aria-hidden="true" />
            <span>{t("workspace.today.briefing")}</span>
            <Show when={props.onOpenBriefing}>
              {(open) => (
                <Button variant="ghost" size="sm" class="ws-today-heading-action" onClick={() => open()()}>
                  {t("workspace.today.briefingSettings")}
                </Button>
              )}
            </Show>
          </h3>
          <div class="ws-today-cards">
            <TodaySpendCard
              report={props.report}
              todayCostUsd={props.todayCostUsd}
              cost={cost}
              onOpen={props.onOpenMoney}
            />
            <Show when={props.report?.goals.length}>
              <TodayGoalsCard goals={props.report?.goals ?? []} onOpen={props.onOpenGoals} />
            </Show>
            <Show when={props.shipped.length > 0}>
              <TodayShippedCard shipped={props.shipped} onOpen={props.onOpenShipped} />
            </Show>
            <Show when={props.report?.briefing.lastText}>
              {(text) => (
                <article class="ws-today-card ws-today-card-wide">
                  <h4 class="ws-today-card-title">
                    <Sunrise aria-hidden="true" />
                    {t("workspace.today.lastBriefing")}
                    {/* A time that does not parse shows nothing: a date format throws on it. */}
                    <Show when={sentAt()}>
                      {(at) => (
                        <span class="ws-today-card-meta">
                          {format.date(at(), { weekday: "short", hour: "numeric", minute: "2-digit" })}
                        </span>
                      )}
                    </Show>
                  </h4>
                  <p class="ws-today-briefing-text">{text()}</p>
                </article>
              )}
            </Show>
          </div>
        </section>
      </div>
    </section>
  );
}

/** One request that waits, as a card with the agent, what it asks, the money, and the answers. */
export function TodayDecisionCard(props: { decision: TodayDecision; compact?: boolean }): JSX.Element {
  const { t, errorMessage } = useText();
  const recent = useRecentTime();
  const cost = useCost();
  const [busy, setBusy] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [answer, setAnswer] = createSignal("");
  const decision = () => props.decision;
  let card: HTMLElement | undefined;
  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      // The host's list drops the request soon; until then the card says it went.
      const focused = document.activeElement;
      const hadFocus = !focused || focused === document.body || card?.contains(focused) === true;
      setSent(true);
      // The pressed button goes away with the actions: the card keeps the focus and reads "Sent".
      if (hadFocus) card?.querySelector<HTMLElement>(".ws-today-decision-sent")?.focus();
    } catch (failure) {
      setError(errorMessage(failure, t("workspace.today.answerFailed")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      ref={card}
      tabindex="-1"
      class={cx("ws-today-decision", props.compact && "ws-today-decision-compact")}
      data-kind={decision().kind}
      data-blocking={decision().blocking ? "" : undefined}
      data-sent={sent() ? "" : undefined}
      aria-label={t("workspace.needsYou.rowLabel", { name: decision().member.name, action: decision().action })}
    >
      <div class="ws-today-decision-head">
        <span class="ws-feed-avatar">
          <MemberAvatar member={decision().member} size="lg" />
          <span class="ws-feed-kind" data-kind="needs-you" aria-hidden="true">
            <Dynamic component={KIND_ICON[decision().kind]} />
          </span>
        </span>
        <div class="ws-today-decision-copy">
          <p class="ws-today-decision-title">
            <strong>{decision().member.name}</strong>
            <span class="ws-today-decision-time">{recent(decision().at)}</span>
          </p>
          <p class="ws-today-decision-action">{decision().action}</p>
          <Show when={decision().summary}>{(summary) => <p class="ws-today-decision-summary">{summary()}</p>}</Show>
          <Show when={decision().detail}>{(detail) => <p class="ws-today-decision-detail">{detail()}</p>}</Show>
          <Show when={decision().where}>{(where) => <p class="ws-today-decision-where">{where()}</p>}</Show>
        </div>
        <Show when={decision().amountUsd !== undefined}>
          <strong class="ws-today-amount">{cost(decision().amountUsd ?? 0)}</strong>
        </Show>
      </div>
      <Show
        when={!sent()}
        fallback={
          <p class="ws-today-decision-sent" role="status" tabindex="-1">
            <Check aria-hidden="true" />
            {t("workspace.today.sent")}
          </p>
        }
      >
        <Show when={decision().answer}>
          {(send) => (
            <form
              class="ws-today-answer"
              onSubmit={(event) => {
                event.preventDefault();
                const text = answer().trim();
                if (text) void run(() => send()(text));
              }}
            >
              <Input
                value={answer()}
                aria-label={t("workspace.today.answerLabel", { name: decision().member.name })}
                placeholder={t("workspace.today.answerPlaceholder")}
                onValueChange={setAnswer}
              />
              <Button type="submit" disabled={busy() || answer().trim() === ""}>
                {t("workspace.today.send")}
              </Button>
            </form>
          )}
        </Show>
        <div class="ws-today-decision-actions">
          <Show when={decision().approve}>
            {(approve) => (
              <Button disabled={busy()} onClick={() => void run(approve())}>
                {decision().approveLabel ?? t("workspace.today.approve")}
              </Button>
            )}
          </Show>
          <Show when={decision().reject}>
            {(reject) => (
              <Button variant="outline" disabled={busy()} onClick={() => void run(reject())}>
                {decision().rejectLabel ?? t("workspace.today.decline")}
              </Button>
            )}
          </Show>
          <Button
            variant={decision().approve || decision().answer ? "ghost" : "secondary"}
            onClick={() => decision().open()}
          >
            {decision().openLabel}
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
        <Show when={error()}>
          {(message) => (
            <p class="ws-today-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </Show>
    </article>
  );
}

function TodayWorkerRow(props: { worker: TodayWorker }): JSX.Element {
  const { t } = useText();
  const cost = useCost();
  const duration = useWorkspaceDuration();
  const worker = () => props.worker;
  return (
    <div class="ws-today-worker">
      <Button variant="ghost" class="ws-today-worker-open" onClick={() => worker().onOpen()}>
        <span class="ws-today-worker-avatar" data-live="">
          <MemberAvatar member={worker().member} size="lg" />
        </span>
        <span class="ws-today-worker-copy">
          <span class="ws-today-worker-name">{worker().member.name}</span>
          <span class="ws-today-worker-task">{worker().task}</span>
          <span class="ws-today-worker-meta">
            {[
              worker().where,
              worker().startedAt ? duration(Date.now() - (worker().startedAt ?? 0)) : undefined,
              worker().todayCostUsd
                ? t("workspace.today.costToday", { cost: cost(worker().todayCostUsd ?? 0) })
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </Button>
      <Show when={worker().onStop}>
        {(stop) => (
          <Button
            variant="outline"
            class="ws-today-stop"
            disabled={worker().stopping}
            aria-label={t("workspace.typing.stopLabel", { name: worker().member.name })}
            onClick={() => stop()()}
          >
            <Square aria-hidden="true" />
            {worker().stopping ? t("workspace.typing.stopping") : t("workspace.typing.stop")}
          </Button>
        )}
      </Show>
    </div>
  );
}

function TodaySpendCard(props: {
  report: WorkspaceInsight | null;
  todayCostUsd: number | undefined;
  cost: (usd: number) => string;
  onOpen: (() => void) | undefined;
}): JSX.Element {
  const { t, format } = useText();
  const change = () => {
    const costs = props.report?.costs;
    if (!costs || costs.previousWeekUsd <= 0) return null;
    return (costs.weekUsd - costs.previousWeekUsd) / costs.previousWeekUsd;
  };
  return (
    <article class="ws-today-card">
      <h4 class="ws-today-card-title">
        <Coins aria-hidden="true" />
        {t("workspace.today.spend")}
      </h4>
      <dl class="ws-today-figures">
        <div>
          <dt>{t("workspace.today.spendToday")}</dt>
          <dd>{props.cost(props.todayCostUsd ?? 0)}</dd>
        </div>
        <Show when={props.report}>
          {(report) => (
            <div>
              <dt>{t("workspace.today.spendWeek")}</dt>
              <dd>
                {props.cost(report().costs.weekUsd)}
                <Show when={change()}>
                  {(value) => (
                    <span class="ws-today-change" data-up={value() > 0 ? "" : undefined}>
                      {t("workspace.today.vsLastWeek", {
                        change: format.percent(value(), { signDisplay: "exceptZero", maximumFractionDigits: 0 }),
                      })}
                    </span>
                  )}
                </Show>
              </dd>
            </div>
          )}
        </Show>
      </dl>
      <Show when={props.onOpen}>
        {(open) => (
          <Button variant="ghost" size="sm" class="ws-today-card-link" onClick={() => open()()}>
            {t("workspace.today.openMoney")}
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </Show>
    </article>
  );
}

/** "21 more in 12 days": what a goal still needs, so "Behind" says why. Null when there is no gap to show. */
export function goalGap(goal: Pick<InsightGoal, "target" | "current" | "deadline">, now: number) {
  const needed = goal.target - goal.current;
  if (needed <= 0) return null;
  const days = goal.deadline ? Math.ceil((Date.parse(goal.deadline) - now) / 86_400_000) : null;
  return { needed, days: days !== null && Number.isFinite(days) ? Math.max(0, days) : null };
}

const PACE_KEY = {
  done: "insight.pace.done",
  ahead: "insight.pace.ahead",
  "on-track": "insight.pace.onTrack",
  behind: "insight.pace.behind",
  unknown: "insight.pace.unknown",
} as const;

function TodayGoalsCard(props: { goals: readonly InsightGoal[]; onOpen: (() => void) | undefined }): JSX.Element {
  const { t, format } = useText();
  const now = Date.now();
  return (
    <article class="ws-today-card">
      <h4 class="ws-today-card-title">
        <Target aria-hidden="true" />
        {t("workspace.today.goals")}
      </h4>
      <ul class="ws-today-goals">
        <For each={props.goals.slice(0, 4)} keyed={(goal) => goal.id}>
          {(goal) => {
            const pace = () => insightGoalPace(goal(), now);
            const share = () => (goal().target > 0 ? Math.min(1, goal().current / goal().target) : 0);
            const gap = () => goalGap(goal(), now);
            return (
              <li class="ws-today-goal" data-pace={pace()}>
                <span class="ws-today-goal-head">
                  <span class="ws-truncate">{goal().title}</span>
                  <span class="ws-today-goal-count">
                    {format.number(goal().current)}/{format.number(goal().target)}
                  </span>
                </span>
                <span class="ws-today-goal-bar" aria-hidden="true">
                  <span style={{ width: `${Math.round(share() * 100)}%` }} />
                </span>
                <span class="ws-today-goal-pace">
                  {t(PACE_KEY[pace()])}
                  <Show when={pace() === "behind" ? gap() : null}>
                    {(missing) => (
                      <>
                        {" · "}
                        {missing().days === null
                          ? t("workspace.today.goalNeeds", { count: missing().needed })
                          : t("workspace.today.goalNeedsBy", { count: missing().needed, days: missing().days ?? 0 })}
                      </>
                    )}
                  </Show>
                </span>
              </li>
            );
          }}
        </For>
      </ul>
      <Show when={props.onOpen}>
        {(open) => (
          <Button variant="ghost" size="sm" class="ws-today-card-link" onClick={() => open()()}>
            {t("workspace.today.openGoals")}
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </Show>
    </article>
  );
}

function TodayShippedCard(props: { shipped: readonly TodayShipped[]; onOpen: (() => void) | undefined }): JSX.Element {
  const { t } = useText();
  const recent = useRecentTime();
  return (
    <article class="ws-today-card">
      <h4 class="ws-today-card-title">
        <LayoutDashboard aria-hidden="true" />
        {t("workspace.today.shipped")}
      </h4>
      <ul class="ws-today-shipped">
        <For each={props.shipped.slice(0, 4)} keyed={(item) => item.id}>
          {(item) => (
            <li>
              <Button variant="ghost" class="ws-today-shipped-item" onClick={() => item().onOpen()}>
                <Show when={item().agent}>{(agent) => <MemberAvatar member={agent()} size="xs" />}</Show>
                <span class="ws-truncate">{item().title}</span>
                <span class="ws-today-card-meta">{recent(item().at)}</span>
              </Button>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.onOpen}>
        {(open) => (
          <Button variant="ghost" size="sm" class="ws-today-card-link" onClick={() => open()()}>
            {t("workspace.today.openShipped")}
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </Show>
    </article>
  );
}

/** The first-run guide: what makes the workspace more than a chat, one step at a time. */
function TodayGuide(props: { steps: readonly TodayStep[]; onHide: (() => void) | undefined }): JSX.Element {
  const { t } = useText();
  const uid = createUniqueId();
  const done = () => props.steps.filter((step) => step.done).length;
  return (
    <section class="ws-today-guide" aria-labelledby={`ws-today-guide-title-${uid}`}>
      <div class="ws-today-guide-head">
        <h3 id={`ws-today-guide-title-${uid}`} class="ws-today-guide-title">
          {t("workspace.today.guide.title")}
        </h3>
        <span class="ws-today-card-meta">
          {t("workspace.today.guide.progress", { done: done(), total: props.steps.length })}
        </span>
        <Show when={props.onHide}>
          {(hide) => (
            <Button variant="ghost" size="sm" onClick={() => hide()()}>
              {t("workspace.today.guide.hide")}
            </Button>
          )}
        </Show>
      </div>
      <p class="ws-today-guide-intro">{t("workspace.today.guide.intro")}</p>
      <ol class="ws-today-guide-steps">
        <For each={props.steps} keyed={(step) => step.id}>
          {(step) => (
            <li>
              <Button
                variant="ghost"
                class="ws-today-guide-step"
                data-done={step().done ? "" : undefined}
                onClick={() => step().onSelect()}
              >
                <span class="ws-today-guide-check" aria-hidden="true">
                  <Show when={step().done}>
                    <Check />
                  </Show>
                </span>
                <span class="ws-today-guide-copy">
                  <span class="ws-today-guide-step-title">{step().title}</span>
                  <span class="ws-today-guide-hint">{step().hint}</span>
                </span>
                <ArrowRight aria-hidden="true" />
              </Button>
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}
