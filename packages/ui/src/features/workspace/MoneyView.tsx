import type { GuardrailsView, SubscriptionWindowMeter } from "@openbot/contracts/guardrails";
import type { WorkspaceInsight } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { Button } from "../../button";
import { ArrowRight, CirclePause, Coins, Gauge, Hand, TriangleAlert } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState, ErrorState, LoadingState } from "../../view-state";
import { createDecisionFocus, type TodayDecision, TodayDecisionCard } from "./TodayView";
import { MemberAvatar } from "./WorkspaceAvatar";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { useCost } from "./workspace-format";
import type { WorkspaceMember } from "./workspace-types";

/** The guardrails part of Money, from the host's guardrails view. */
export interface MoneyGuardrails {
  view: GuardrailsView;
  /** The name of an agent or a space. */
  name: (scope: "agent" | "space", id: string) => string;
  member: (agentId: string) => WorkspaceMember;
  onResume: (scope: "agent" | "space", id: string) => Promise<void>;
  onOpenAgent: (agentId: string) => void;
}

/** One agent's line of Money: what it cost in the period and today. */
export interface MoneyAgentRow {
  member: WorkspaceMember;
  costUsd: number;
  todayUsd?: number | undefined;
  turns?: number | undefined;
  onOpen?: (() => void) | undefined;
}

export interface MoneyViewProps {
  /** The report of the last 30 days, null while it loads or where the reader may not read it. */
  report: WorkspaceInsight | null;
  loading?: boolean | undefined;
  /** The report did not load: the costs say so with Retry, not that there were none. */
  failed?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  /** What the agents cost today, from the fleet. */
  todayUsd: number;
  /** The requests to spend money that wait for the owner, from every space. */
  spend: readonly TodayDecision[];
  agents: readonly MoneyAgentRow[];
  /** The plan's usage and limits page. */
  onOpenUsage?: (() => void) | undefined;
  /** The detailed cost table of Insights. */
  onOpenDetails?: (() => void) | undefined;
  /** The alert rules, with the briefing. */
  onOpenRules?: (() => void) | undefined;
  /** The guardrails of the host: pauses, the subscription meter, today's use and failovers. */
  guardrails?: MoneyGuardrails | null | undefined;
  onBack?: (() => void) | undefined;
  class?: string;
}

/**
 * Money, in one place: what the agents cost today, this week and this month next to the revenue and
 * the ad spend that the host reads, the spend that waits for the owner's OK, each agent's cost, the
 * plan's limits and the rules that alert the owner.
 */
export function MoneyView(props: MoneyViewProps): JSX.Element {
  const { t, format } = useText();
  const uid = createUniqueId();
  const decisionFocus = createDecisionFocus(() => props.spend);
  /** The report did not load: an empty list would say that nothing cost anything. */
  const unread = () => Boolean(props.failed) && !props.report;
  const cost = useCost();
  const costs = () => props.report?.costs;
  const change = () => {
    const current = costs();
    if (!current || current.previousWeekUsd <= 0) return null;
    return (current.weekUsd - current.previousWeekUsd) / current.previousWeekUsd;
  };
  /**
   * Revenue and ad spend of the period, in dollars, and apart for each other currency: a shop in
   * Colombia sells in pesos. Agent costs are dollars, so only the dollar net takes them off.
   */
  const money = createMemo(() => {
    let revenue = 0;
    let spend = 0;
    const others = new Map<string, { revenue: number; spend: number }>();
    for (const entry of props.report?.money ?? []) {
      const code = entry.currency.toUpperCase();
      if (code !== "USD") {
        const known = others.get(code) ?? { revenue: 0, spend: 0 };
        if (entry.kind === "revenue") known.revenue += entry.amount;
        else known.spend += entry.amount;
        others.set(code, known);
        continue;
      }
      if (entry.kind === "revenue") revenue += entry.amount;
      else spend += entry.amount;
    }
    const other = [...others]
      .filter(([, total]) => total.revenue > 0 || total.spend > 0)
      .map(([code, total]) => ({ code, ...total }));
    return { revenue, spend, other };
  });
  /** The team's cost per day of the period, for the bars. */
  const daily = createMemo(() => {
    const current = costs();
    if (!current) return [];
    return current.days.map((day, index) => ({
      day,
      usd: current.agents.reduce((sum, agent) => sum + (agent.daily[index] ?? 0), 0),
    }));
  });
  const peak = () => Math.max(0, ...daily().map((entry) => entry.usd));
  const settings = () => props.report?.briefing.settings;
  return (
    <section class={cx("ws-view ws-money", props.class)} aria-label={t("workspace.view.money")}>
      <WorkspacePaneHeader
        icon={<Coins aria-hidden="true" />}
        title={t("workspace.view.money")}
        subtitle={t("workspace.money.subtitle")}
        onBack={props.onBack}
      />
      <div class="ws-view-scroll ws-today-scroll">
        <Show when={unread()}>
          <ErrorState size="compact" title={t("workspace.money.loadFailed")} onRetry={props.onRetry} />
        </Show>
        <dl class="ws-money-figures">
          <div>
            <dt>{t("workspace.today.spendToday")}</dt>
            <dd>{cost(props.todayUsd)}</dd>
          </div>
          <Show when={costs()}>
            {(current) => (
              <>
                <div>
                  <dt>{t("workspace.today.spendWeek")}</dt>
                  <dd>
                    {cost(current().weekUsd)}
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
                {/* A report of 7 days is the week tile already: one tile, not two that say the same. */}
                <Show when={(props.report?.days ?? 7) !== 7}>
                  <div>
                    <dt>{t("insight.costs.total", { days: props.report?.days ?? 30 })}</dt>
                    <dd>{cost(current().totalUsd)}</dd>
                  </div>
                </Show>
              </>
            )}
          </Show>
          <Show when={money().revenue > 0 || money().spend > 0}>
            <div>
              <dt>{t("workspace.money.revenue")}</dt>
              <dd>{format.currencyUsd(money().revenue)}</dd>
            </div>
            <div>
              <dt>{t("workspace.money.adSpend")}</dt>
              <dd>{format.currencyUsd(money().spend)}</dd>
            </div>
            <div>
              <dt>{t("workspace.money.net")}</dt>
              <dd data-negative={money().revenue - money().spend - (costs()?.totalUsd ?? 0) < 0 ? "" : undefined}>
                {format.currencyUsd(money().revenue - money().spend - (costs()?.totalUsd ?? 0))}
              </dd>
            </div>
          </Show>
          <For each={money().other}>
            {(total) => (
              <>
                <div>
                  <dt>{t("workspace.money.revenue")}</dt>
                  <dd>{format.currency(total.revenue, total.code)}</dd>
                </div>
                <div>
                  <dt>{t("workspace.money.adSpend")}</dt>
                  <dd>{format.currency(total.spend, total.code)}</dd>
                </div>
              </>
            )}
          </For>
        </dl>
        <Show when={money().other.length > 0}>
          <p class="ws-insight-note">{t("workspace.money.otherCurrencyNet")}</p>
        </Show>
        <Show when={daily().length > 1 && peak() > 0}>
          <figure class="ws-money-chart" aria-label={t("insight.costs.daily")}>
            <figcaption class="ws-today-card-title">{t("insight.costs.daily")}</figcaption>
            <ol class="ws-money-bars">
              <For each={daily()}>
                {(entry) => (
                  <li
                    title={`${entry.day}: ${cost(entry.usd)}`}
                    style={{ height: `${Math.max(2, Math.round((entry.usd / peak()) * 100))}%` }}
                  >
                    <span class="sr-only">{`${entry.day}: ${cost(entry.usd)}`}</span>
                  </li>
                )}
              </For>
            </ol>
          </figure>
        </Show>
        <section
          ref={decisionFocus.ref}
          class="ws-today-section"
          aria-labelledby={`ws-money-waiting-${uid}`}
          onFocusIn={decisionFocus.onFocusIn}
          onFocusOut={decisionFocus.onFocusOut}
        >
          <h3
            id={`ws-money-waiting-${uid}`}
            class="ws-today-heading"
            tabindex="-1"
            data-tone={props.spend.length ? "warn" : undefined}
          >
            <Hand aria-hidden="true" />
            <span>{t("workspace.money.waiting", { count: props.spend.length })}</span>
          </h3>
          <Show
            when={props.spend.length > 0}
            fallback={<p class="ws-today-quiet">{t("workspace.money.noSpendWaiting")}</p>}
          >
            <ul class="ws-today-decisions">
              <For each={props.spend} keyed={(decision) => decision.key}>
                {(decision) => (
                  <li>
                    <TodayDecisionCard decision={decision()} />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
        <section class="ws-today-section" aria-labelledby={`ws-money-agents-${uid}`}>
          <h3 id={`ws-money-agents-${uid}`} class="ws-today-heading">
            <Coins aria-hidden="true" />
            <span>{t("workspace.money.byAgent")}</span>
            <Show when={props.onOpenDetails}>
              {(open) => (
                <Button variant="ghost" size="sm" class="ws-today-heading-action" onClick={() => open()()}>
                  {t("workspace.money.details")}
                  <ArrowRight aria-hidden="true" />
                </Button>
              )}
            </Show>
          </h3>
          <Show
            when={props.agents.length > 0}
            fallback={
              <Show when={!props.loading} fallback={<LoadingState label={t("workspace.view.money")} />}>
                <Show when={!unread()}>
                  <EmptyState
                    size="compact"
                    icon={<Coins />}
                    title={t("insight.costs.emptyTitle")}
                    description={t("insight.costs.empty")}
                  />
                </Show>
              </Show>
            }
          >
            <ul class="ws-money-agents">
              <For each={props.agents} keyed={(row) => row.member.id}>
                {(row) => (
                  <li>
                    <Button variant="ghost" class="ws-money-agent" onClick={() => row().onOpen?.()}>
                      <MemberAvatar member={row().member} size="sm" />
                      <span class="ws-money-agent-name ws-truncate">{row().member.name}</span>
                      <Show when={row().todayUsd}>
                        {(today) => (
                          <span class="ws-today-card-meta">
                            {t("workspace.today.costToday", { cost: cost(today()) })}
                          </span>
                        )}
                      </Show>
                      <span class="ws-money-agent-cost">{cost(row().costUsd)}</span>
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
        <Show when={props.guardrails}>{(guard) => <MoneyGuardrailsSection guard={guard()} />}</Show>
        <div class="ws-today-cards">
          <article class="ws-today-card">
            <h4 class="ws-today-card-title">
              <Gauge aria-hidden="true" />
              {t("workspace.money.plan")}
            </h4>
            <p class="ws-today-briefing-text">{t("workspace.money.planHint")}</p>
            <Show when={props.onOpenUsage}>
              {(open) => (
                <Button variant="ghost" size="sm" class="ws-today-card-link" onClick={() => open()()}>
                  {t("workspace.money.openPlan")}
                  <ArrowRight aria-hidden="true" />
                </Button>
              )}
            </Show>
          </article>
          <Show when={settings()}>
            {(rules) => (
              <article class="ws-today-card">
                <h4 class="ws-today-card-title">
                  <TriangleAlert aria-hidden="true" />
                  {t("workspace.money.rules")}
                </h4>
                <p class="ws-today-briefing-text">
                  {t("workspace.money.rule", {
                    amount: format.currencyUsd(rules().alertMinSpend),
                    days: rules().alertDays,
                  })}
                </p>
                <Show when={props.onOpenRules}>
                  {(open) => (
                    <Button variant="ghost" size="sm" class="ws-today-card-link" onClick={() => open()()}>
                      {t("workspace.money.editRules")}
                      <ArrowRight aria-hidden="true" />
                    </Button>
                  )}
                </Show>
              </article>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}

/**
 * What the guardrails hold: the agents and spaces paused now with Resume, each subscription's use with
 * when it runs out, today's biggest spenders, and the agents moved to another model.
 */
function MoneyGuardrailsSection(props: { guard: MoneyGuardrails }): JSX.Element {
  const { t, format, errorMessage } = useText();
  const cost = useCost();
  const uid = createUniqueId();
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const view = () => props.guard.view;
  /**
   * A meter's time is in epoch seconds; a pause's and a failover's is an ISO time. Null for a time that
   * does not parse: a date format throws on it, and the view would not render.
   */
  const time = (at: string | number) => {
    const ms = typeof at === "number" ? at * 1000 : Date.parse(at);
    return Number.isFinite(ms) ? format.date(ms, { weekday: "short", hour: "numeric", minute: "2-digit" }) : null;
  };
  const pauseEnd = (until: string | null) => {
    if (until === null) return t("trust.guardrails.untilOwner");
    const at = time(until);
    return at ? t("trust.guardrails.until", { time: at }) : null;
  };
  const windowLabel = (window: SubscriptionWindowMeter) =>
    window.windowDurationMins === null
      ? ""
      : window.windowDurationMins < 24 * 60
        ? t("trust.guardrails.window.hours", { count: Math.round(window.windowDurationMins / 60) })
        : t("trust.guardrails.window.days", { count: Math.round(window.windowDurationMins / (24 * 60)) });
  const spenders = createMemo(() =>
    view()
      .usage.filter((row) => row.scope === "agent" && row.costUsd > 0)
      .sort((left, right) => right.costUsd - left.costUsd)
      .slice(0, 5),
  );
  async function resume(scope: "agent" | "space", id: string) {
    setBusy(`${scope}:${id}`);
    setError(null);
    try {
      await props.guard.onResume(scope, id);
    } catch (failure) {
      setError(errorMessage(failure, t("workspace.today.answerFailed")));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <Show when={view().pauses.length > 0}>
        <section class="ws-today-section" aria-labelledby={`ws-money-paused-${uid}`}>
          <h3 id={`ws-money-paused-${uid}`} class="ws-today-heading" data-tone="warn">
            <CirclePause aria-hidden="true" />
            <span>{t("trust.guardrails.paused")}</span>
          </h3>
          <ul class="ws-money-agents">
            <For each={view().pauses} keyed={(pause) => `${pause.scope}:${pause.id}`}>
              {(pause) => (
                <li class="ws-money-row">
                  <span class="ws-money-row-copy">
                    <strong>{props.guard.name(pause().scope, pause().id)}</strong>
                    <span class="ws-today-card-meta">
                      {[pause().detail, pauseEnd(pause().until)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    disabled={busy() === `${pause().scope}:${pause().id}`}
                    onClick={() => void resume(pause().scope, pause().id)}
                  >
                    {t("trust.guardrails.resume")}
                  </Button>
                </li>
              )}
            </For>
          </ul>
          <Show when={error()}>
            {(message) => (
              <p class="ws-today-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </section>
      </Show>
      <div class="ws-today-cards">
        <article class="ws-today-card">
          <h4 class="ws-today-card-title">
            <Gauge aria-hidden="true" />
            {t("trust.guardrails.meter")}
          </h4>
          <For each={view().meter} fallback={<p class="ws-today-briefing-text">{t("trust.guardrails.meterEmpty")}</p>}>
            {(account) => (
              <div class="ws-money-meter">
                <p class="ws-money-meter-head">
                  <strong>
                    {account.provider}
                    {account.label ? ` · ${account.label}` : ""}
                  </strong>
                  <Show when={account.nearlyExhausted}>
                    <span class="ws-today-amount">{t("trust.guardrails.nearlyOut")}</span>
                  </Show>
                </p>
                <For each={account.windows}>
                  {(window) => (
                    <div class="ws-money-window">
                      <span class="ws-today-goal-bar" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, Math.round(window.usedPercent))}%` }} />
                      </span>
                      <span class="ws-today-card-meta">
                        {[
                          windowLabel(window),
                          t("trust.guardrails.window.used", { percent: Math.round(window.usedPercent) }),
                          window.exhaustsAt
                            ? t("trust.guardrails.window.runsOut", { time: time(window.exhaustsAt) ?? "" })
                            : window.resetsAt
                              ? t("trust.guardrails.window.resets", { time: time(window.resetsAt) ?? "" })
                              : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </article>
        <article class="ws-today-card">
          <h4 class="ws-today-card-title">
            <Coins aria-hidden="true" />
            {t("workspace.money.topToday")}
          </h4>
          <Show
            when={spenders().length > 0}
            fallback={<p class="ws-today-briefing-text">{t("trust.guardrails.todayEmpty")}</p>}
          >
            <ul class="ws-today-shipped">
              <For each={spenders()} keyed={(row) => row.id}>
                {(row) => (
                  <li>
                    <Button
                      variant="ghost"
                      class="ws-today-shipped-item"
                      onClick={() => props.guard.onOpenAgent(row().id)}
                    >
                      <MemberAvatar member={props.guard.member(row().id)} size="xs" />
                      <span class="ws-truncate">{props.guard.name("agent", row().id)}</span>
                      <span class="ws-today-card-meta">
                        {row().state === "paused"
                          ? t("trust.guardrails.state.paused")
                          : row().state === "warn"
                            ? t("trust.guardrails.state.warn")
                            : ""}
                      </span>
                      <span class="ws-money-agent-cost">{cost(row().costUsd)}</span>
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </article>
        <Show when={view().failovers.length > 0}>
          <article class="ws-today-card">
            <h4 class="ws-today-card-title">
              <ArrowRight aria-hidden="true" />
              {t("trust.guardrails.failovers")}
            </h4>
            <ul class="ws-today-shipped">
              <For each={view().failovers} keyed={(row) => row.agentId}>
                {(row) => (
                  <li>
                    <Button
                      variant="ghost"
                      class="ws-today-shipped-item"
                      onClick={() => props.guard.onOpenAgent(row().agentId)}
                    >
                      <MemberAvatar member={props.guard.member(row().agentId)} size="xs" />
                      <span class="ws-truncate">
                        {props.guard.name("agent", row().agentId)}:{" "}
                        {t("trust.guardrails.failoverRow", {
                          from: `${row().from.provider}/${row().from.model}`,
                          to: `${row().to.provider}/${row().to.model}`,
                        })}
                      </span>
                      <span class="ws-today-card-meta">{time(row().since)}</span>
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </article>
        </Show>
      </div>
    </>
  );
}
