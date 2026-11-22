import type { WorkspaceInsight } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, For, Show } from "solid-js";
import { Button } from "../../button";
import { ArrowRight, Coins, Gauge, Hand, TriangleAlert } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState, LoadingState } from "../../view-state";
import { type TodayDecision, TodayDecisionCard } from "./TodayView";
import { MemberAvatar } from "./WorkspaceAvatar";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { useCost } from "./workspace-format";
import type { WorkspaceMember } from "./workspace-types";

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
  const cost = useCost();
  const costs = () => props.report?.costs;
  const change = () => {
    const current = costs();
    if (!current || current.previousWeekUsd <= 0) return null;
    return (current.weekUsd - current.previousWeekUsd) / current.previousWeekUsd;
  };
  /** Revenue and ad spend of the period, in dollars: entries in other currencies show apart. */
  const money = createMemo(() => {
    let revenue = 0;
    let spend = 0;
    let other = false;
    for (const entry of props.report?.money ?? []) {
      if (entry.currency.toUpperCase() !== "USD") {
        other = true;
        continue;
      }
      if (entry.kind === "revenue") revenue += entry.amount;
      else spend += entry.amount;
    }
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
                <div>
                  <dt>{t("insight.costs.total", { days: props.report?.days ?? 30 })}</dt>
                  <dd>{cost(current().totalUsd)}</dd>
                </div>
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
        </dl>
        <Show when={money().other}>
          <p class="ws-insight-note">{t("workspace.money.otherCurrency")}</p>
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
        <section class="ws-today-section" aria-labelledby={`ws-money-waiting-${uid}`}>
          <h3
            id={`ws-money-waiting-${uid}`}
            class="ws-today-heading"
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
                <EmptyState
                  size="compact"
                  icon={<Coins />}
                  title={t("insight.costs.emptyTitle")}
                  description={t("insight.costs.empty")}
                />
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
