import {
  INSIGHT_GOAL_SOURCES,
  type InsightAgentCost,
  type InsightAlert,
  type InsightBriefingSettings,
  type InsightGoalDraft,
  type InsightGoalSource,
  type InsightMoneyDraft,
  type InsightMoneyEntry,
  insightGoalPace,
  type WorkspaceInsight,
} from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { Button, IconButton } from "../../button";
import { Checkbox } from "../../checkbox";
import { Field, Input } from "../../form";
import { FormDialog } from "../../form-dialog";
import { Coins, Pencil, Plus, RefreshCw, Send, Sunrise, Target, Trash2, Wallet, X } from "../../icons";
import { Progress } from "../../progress";
import { SlidingTabs } from "../../sliding-tabs";
import { SwitchField } from "../../switch";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState, ErrorState, LoadingState } from "../../view-state";
import { goalGap } from "./TodayView";
import { MemberAvatar } from "./WorkspaceAvatar";
import { WorkspaceList, WorkspaceListRow } from "./WorkspaceList";
import { PaneHeaderAction, WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { WorkspaceSelect } from "./WorkspaceSelect";
import { zoneDay } from "./workspace-format";
import type { WorkspaceMember } from "./workspace-types";

export type InsightTab = "goals" | "money" | "costs" | "briefing";
export type InsightCostSort = "cost" | "idle" | "side" | "tokens" | "name";

export interface InsightViewProps {
  tab: InsightTab;
  onTabChange: (tab: InsightTab) => void;
  /** Null while the report loads. */
  report: WorkspaceInsight | null;
  loadError?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  days: number;
  onDaysChange: (days: number) => void;
  spaces: readonly { id: string; name: string }[];
  member: (agentId: string) => WorkspaceMember;
  onSaveGoal: (goal: InsightGoalDraft) => Promise<void>;
  onRemoveGoal: (goalId: string) => Promise<void>;
  onSetProgress: (goalId: string, value: number) => Promise<void>;
  onAddMoney: (entry: InsightMoneyDraft) => Promise<void>;
  onRemoveMoney: (entryId: string) => Promise<void>;
  onSync: () => Promise<void>;
  onDismissAlert: (alertId: string) => void;
  onSaveBriefing: (settings: InsightBriefingSettings) => Promise<void>;
  onSendBriefing: () => Promise<void>;
  onOpenChannel: (channelId: string) => void;
  onBack?: (() => void) | undefined;
  class?: string;
}

const TABS: readonly InsightTab[] = ["goals", "money", "costs", "briefing"];

const ALERT_KEY = {
  "spend-no-sales": "insight.alert.spendNoSales",
  "goal-behind": "insight.alert.goalBehind",
  "sync-failed": "insight.alert.syncFailed",
} as const;
const SOURCE_KEY = {
  manual: "insight.source.manual",
  "hotmart-sales": "insight.source.hotmartSales",
  "hotmart-revenue": "insight.source.hotmartRevenue",
  "meta-spend": "insight.source.metaSpend",
  "motion-closed": "insight.source.motionClosed",
  meta: "insight.source.meta",
  hotmart: "insight.source.hotmart",
  motion: "insight.source.motion",
} as const;
const SOURCE_STATE_KEY = {
  ready: "insight.sourceState.ready",
  missing: "insight.sourceState.missing",
  error: "insight.sourceState.error",
} as const;
const PACE_KEY = {
  done: "insight.pace.done",
  ahead: "insight.pace.ahead",
  "on-track": "insight.pace.onTrack",
  behind: "insight.pace.behind",
  unknown: "insight.pace.unknown",
} as const;
const MONEY_KIND_KEY = { spend: "insight.money.kind.spend", revenue: "insight.money.kind.revenue" } as const;
const SORT_KEY = {
  cost: "insight.costs.sortBy.cost",
  idle: "insight.costs.sortBy.idle",
  side: "insight.costs.sortBy.side",
  tokens: "insight.costs.sortBy.tokens",
  name: "insight.costs.sortBy.name",
} as const;

/**
 * Goals, money, the cost of each agent and the daily briefing of the host, for its owner and admins.
 * Every number comes from what the host stores; reading this view wakes no agent.
 */
export function InsightView(props: InsightViewProps): JSX.Element {
  const { t } = useText();
  return (
    <section class={cx("ws-view ws-insight", props.class)} aria-label={t("insight.title")}>
      <WorkspacePaneHeader
        icon={<Target aria-hidden="true" />}
        title={t("insight.title")}
        subtitle={t("insight.subtitle")}
        onBack={props.onBack}
      />
      <div class="ws-view-toolbar ws-insight-toolbar">
        <SlidingTabs.Root
          value={props.tab}
          onChange={(value) => {
            const tab = TABS.find((candidate) => candidate === value);
            if (tab) props.onTabChange(tab);
          }}
        >
          <SlidingTabs.List aria-label={t("insight.title")}>
            <SlidingTabs.Trigger value="goals">{t("insight.tab.goals")}</SlidingTabs.Trigger>
            <SlidingTabs.Trigger value="money">{t("insight.tab.money")}</SlidingTabs.Trigger>
            <SlidingTabs.Trigger value="costs">{t("insight.tab.costs")}</SlidingTabs.Trigger>
            <SlidingTabs.Trigger value="briefing">{t("insight.tab.briefing")}</SlidingTabs.Trigger>
          </SlidingTabs.List>
        </SlidingTabs.Root>
        <Show when={props.tab === "money" || props.tab === "costs" || props.tab === "goals"}>
          <WorkspaceSelect
            value={String(props.days)}
            label={t("insight.period")}
            options={[7, 30, 90].map((days) => ({ value: String(days), label: t("insight.lastDays", { days }) }))}
            onChange={(value) => props.onDaysChange(Number(value))}
          />
        </Show>
      </div>
      <div class="ws-view-scroll">
        <Show
          when={props.report}
          fallback={
            <Show when={props.loadError} fallback={<LoadingState label={t("insight.title")} />}>
              {(error) => <ErrorState title={t("insight.loadFailed")} description={error()} onRetry={props.onRetry} />}
            </Show>
          }
        >
          {(report) => (
            <>
              <InsightAlerts alerts={report().alerts} spaces={props.spaces} onDismiss={props.onDismissAlert} />
              <Switch>
                <Match when={props.tab === "goals"}>
                  <InsightGoals {...props} report={report()} />
                </Match>
                <Match when={props.tab === "money"}>
                  <InsightMoney {...props} report={report()} />
                </Match>
                <Match when={props.tab === "costs"}>
                  <InsightCosts {...props} report={report()} />
                </Match>
                <Match when={props.tab === "briefing"}>
                  <InsightBriefing {...props} report={report()} />
                </Match>
              </Switch>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}

function InsightAlerts(props: {
  alerts: readonly InsightAlert[];
  spaces: InsightViewProps["spaces"];
  onDismiss: (alertId: string) => void;
}): JSX.Element {
  const { t } = useText();
  return (
    <Show when={props.alerts.length > 0}>
      <section class="ws-insight-section" aria-label={t("insight.alerts")}>
        <WorkspaceList label={t("insight.alerts")}>
          <For each={props.alerts} keyed={(alert) => alert.id}>
            {(alert) => (
              <WorkspaceListRow
                class="ws-insight-alert"
                title={t(ALERT_KEY[alert().kind])}
                actions={
                  <IconButton
                    variant="ghost"
                    size="icon-xs"
                    label={t("insight.dismiss")}
                    onClick={() => props.onDismiss(alert().id)}
                  >
                    <X />
                  </IconButton>
                }
              >
                <span class="ws-insight-line">{alert().text}</span>
              </WorkspaceListRow>
            )}
          </For>
        </WorkspaceList>
      </section>
    </Show>
  );
}

/**
 * A tiny line of the last values, oldest first. Nothing for fewer than three values: two points
 * draw a lone slant that reads as a glitch, not as a trend.
 */
function Sparkline(props: { values: readonly number[]; label: string }): JSX.Element {
  const points = createMemo(() => {
    const values = props.values;
    if (values.length < 3) return "";
    const max = Math.max(...values);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    return values
      .map((value, index) => `${(index / (values.length - 1)) * 100},${28 - ((value - min) / span) * 26}`)
      .join(" ");
  });
  return (
    <Show when={points()}>
      <svg class="ws-insight-spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={props.label}>
        <polyline
          points={points()}
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
        />
      </svg>
    </Show>
  );
}

type SectionProps = InsightViewProps & { report: WorkspaceInsight };

const EMPTY_GOAL = (spaceId: string): InsightGoalDraft => ({
  spaceId,
  title: "",
  metric: "",
  target: 0,
  current: 0,
  deadline: null,
  source: "manual",
  product: null,
  agentIds: [],
});

function InsightGoals(props: SectionProps): JSX.Element {
  const { t, format, errorMessage } = useText();
  const calendarDay = useCalendarDay();
  const [editing, setEditing] = createSignal<InsightGoalDraft | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [progress, setProgress] = createSignal<{ id: string; value: string } | null>(null);
  const spaceName = (id: string) => props.spaces.find((space) => space.id === id)?.name ?? id;
  const groups = createMemo(() =>
    props.spaces
      .map((space) => ({ space, goals: props.report.goals.filter((goal) => goal.spaceId === space.id) }))
      .filter((group) => group.goals.length > 0),
  );
  const draftValid = () => {
    const draft = editing();
    return Boolean(draft?.title.trim() && draft.metric.trim() && Number.isFinite(draft.target));
  };
  async function save() {
    const draft = editing();
    if (!draft || !draftValid() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSaveGoal(draft);
      setEditing(null);
    } catch (failure) {
      setError(errorMessage(failure, t("insight.failed")));
    } finally {
      setBusy(false);
    }
  }
  const sourceLabel = (source: InsightGoalSource) => t(SOURCE_KEY[source]);
  return (
    <>
      <div class="ws-insight-actions">
        <PaneHeaderAction
          label={t("insight.goal.add")}
          onClick={() => setEditing(EMPTY_GOAL(props.spaces[0]?.id ?? "general"))}
        />
      </div>
      <Show
        when={groups().length > 0}
        fallback={
          <EmptyState
            icon={<Target />}
            title={t("insight.goal.emptyTitle")}
            description={t("insight.goal.empty")}
            action={
              <PaneHeaderAction
                label={t("insight.goal.add")}
                onClick={() => setEditing(EMPTY_GOAL(props.spaces[0]?.id ?? "general"))}
              />
            }
          />
        }
      >
        <For each={groups()} keyed={(group) => group.space.id}>
          {(group) => (
            <section class="ws-insight-section">
              <h3 class="ws-insight-heading">{group().space.name}</h3>
              <WorkspaceList label={group().space.name}>
                <For each={group().goals} keyed={(goal) => goal.id}>
                  {(goal) => {
                    const pace = () => insightGoalPace(goal(), props.report.at);
                    const share = () =>
                      goal().target === 0 ? 0 : Math.max(0, Math.min(100, (goal().current / goal().target) * 100));
                    return (
                      <WorkspaceListRow
                        class="ws-insight-goal"
                        title={goal().title}
                        titleEnd={
                          <span class="ws-insight-pace" data-pace={pace()}>
                            {t(PACE_KEY[pace()])}
                            {/* "Behind" says why: what the goal still needs, and by when. */}
                            <Show
                              when={
                                pace() === "behind" ? goalGap(goal(), props.report.at, props.report.timeZone) : null
                              }
                            >
                              {(missing) => (
                                <>
                                  {" · "}
                                  {missing().days === null
                                    ? t("workspace.today.goalNeeds", { count: missing().needed })
                                    : t("workspace.today.goalNeedsBy", {
                                        count: missing().needed,
                                        days: missing().days ?? 0,
                                      })}
                                </>
                              )}
                            </Show>
                          </span>
                        }
                        actions={
                          <>
                            <Show when={goal().source === "manual"}>
                              <IconButton
                                variant="ghost"
                                size="icon-xs"
                                label={t("insight.goal.progress")}
                                onClick={() => setProgress({ id: goal().id, value: String(goal().current) })}
                              >
                                <Plus />
                              </IconButton>
                            </Show>
                            <IconButton
                              variant="ghost"
                              size="icon-xs"
                              label={t("insight.goal.edit")}
                              onClick={() =>
                                setEditing({
                                  id: goal().id,
                                  spaceId: goal().spaceId,
                                  title: goal().title,
                                  metric: goal().metric,
                                  target: goal().target,
                                  current: goal().current,
                                  deadline: goal().deadline,
                                  source: goal().source,
                                  product: goal().product,
                                  agentIds: goal().agentIds,
                                })
                              }
                            >
                              <Pencil />
                            </IconButton>
                            <IconButton
                              variant="ghost"
                              size="icon-xs"
                              label={t("insight.goal.remove")}
                              onClick={() => void props.onRemoveGoal(goal().id).catch(() => undefined)}
                            >
                              <Trash2 />
                            </IconButton>
                          </>
                        }
                      >
                        <span class="ws-insight-progress">
                          <Progress
                            value={share()}
                            minValue={0}
                            maxValue={100}
                            aria-label={t("insight.goal.progressLabel", { title: goal().title })}
                          />
                          <Sparkline
                            values={goal().history.map((point) => point.value)}
                            label={t("insight.goal.history")}
                          />
                        </span>
                        <span class="ws-insight-line">
                          {t("insight.goal.line", {
                            current: format.number(goal().current),
                            target: format.number(goal().target),
                            metric: goal().metric,
                          })}
                          {goal().deadline
                            ? ` · ${t("insight.goal.by", { date: calendarDay(goal().deadline ?? "") })}`
                            : ""}
                          {` · ${sourceLabel(goal().source)}`}
                        </span>
                        <Show when={(goal().costUsd ?? 0) > 0}>
                          <span class="ws-muted">
                            {t("insight.goal.cost", {
                              cost: format.currencyUsd(goal().costUsd ?? 0),
                              days: props.days,
                            })}
                          </span>
                        </Show>
                        <Show when={goal().note}>{(note) => <span class="ws-muted">{note()}</span>}</Show>
                        <Show when={progress()?.id === goal().id}>
                          <form
                            class="ws-insight-inline"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const value = Number(progress()?.value);
                              if (!Number.isFinite(value)) return;
                              void props
                                .onSetProgress(goal().id, value)
                                .then(() => setProgress(null))
                                .catch(() => undefined);
                            }}
                          >
                            <Input
                              type="number"
                              inputmode="decimal"
                              value={progress()?.value ?? ""}
                              aria-label={t("insight.goal.current")}
                              onInput={(event) => setProgress({ id: goal().id, value: event.currentTarget.value })}
                            />
                            <Button size="sm" type="submit">
                              {t("insight.save")}
                            </Button>
                          </form>
                        </Show>
                      </WorkspaceListRow>
                    );
                  }}
                </For>
              </WorkspaceList>
            </section>
          )}
        </For>
      </Show>
      <FormDialog
        open={editing() !== null}
        onOpenChange={(open) => {
          if (open) return;
          setEditing(null);
          setError(null);
        }}
        title={editing()?.id ? t("insight.goal.edit") : t("insight.goal.add")}
        description={t("insight.goal.description")}
        size="sm"
        busy={busy()}
        error={error()}
        submitLabel={t("insight.save")}
        submitDisabled={!draftValid()}
        onSubmit={() => void save()}
      >
        <Show when={editing()}>
          {(draft) => {
            const set = (change: Partial<InsightGoalDraft>) => setEditing({ ...draft(), ...change });
            return (
              <>
                <Field label={t("insight.space")}>
                  <WorkspaceSelect
                    value={draft().spaceId}
                    label={t("insight.space")}
                    options={props.spaces.map((space) => ({ value: space.id, label: spaceName(space.id) }))}
                    onChange={(spaceId) => set({ spaceId })}
                  />
                </Field>
                <Field label={t("insight.goal.title")} required>
                  <Input value={draft().title} onInput={(event) => set({ title: event.currentTarget.value })} />
                </Field>
                <div class="ws-insight-pair">
                  <Field label={t("insight.goal.target")} required>
                    <Input
                      type="number"
                      inputmode="decimal"
                      value={String(draft().target)}
                      onInput={(event) => set({ target: Number(event.currentTarget.value) })}
                    />
                  </Field>
                  <Field label={t("insight.goal.metric")} required>
                    <Input
                      value={draft().metric}
                      placeholder={t("insight.goal.metricHint")}
                      onInput={(event) => set({ metric: event.currentTarget.value })}
                    />
                  </Field>
                </div>
                <div class="ws-insight-pair">
                  <Field label={t("insight.goal.deadline")}>
                    <Input
                      type="date"
                      value={draft().deadline ?? ""}
                      onInput={(event) => set({ deadline: event.currentTarget.value || null })}
                    />
                  </Field>
                  <Field label={t("insight.goal.source")}>
                    <WorkspaceSelect
                      value={draft().source}
                      label={t("insight.goal.source")}
                      options={INSIGHT_GOAL_SOURCES.map((source) => ({ value: source, label: sourceLabel(source) }))}
                      onChange={(source) => set({ source })}
                    />
                  </Field>
                </div>
                <Show when={draft().source === "manual"}>
                  <Field label={t("insight.goal.current")}>
                    <Input
                      type="number"
                      inputmode="decimal"
                      value={String(draft().current ?? 0)}
                      onInput={(event) => set({ current: Number(event.currentTarget.value) })}
                    />
                  </Field>
                </Show>
                <Field label={t("insight.goal.product")}>
                  <Input
                    value={draft().product ?? ""}
                    onInput={(event) => set({ product: event.currentTarget.value || null })}
                  />
                </Field>
              </>
            );
          }}
        </Show>
      </FormDialog>
    </>
  );
}

interface MoneyTotals {
  spend: Map<string, number>;
  revenue: Map<string, number>;
  sales: number;
}

function totals(entries: readonly InsightMoneyEntry[]): MoneyTotals {
  const result: MoneyTotals = { spend: new Map(), revenue: new Map(), sales: 0 };
  for (const entry of entries) {
    const target = entry.kind === "spend" ? result.spend : result.revenue;
    target.set(entry.currency, (target.get(entry.currency) ?? 0) + entry.amount);
    if (entry.kind === "revenue") result.sales += entry.sales ?? 0;
  }
  return result;
}

/** A `YYYY-MM-DD` day in the reader's format. Noon UTC names the same day in every zone. */
function useCalendarDay(): (day: string) => string {
  const { format } = useText();
  return (day) => {
    const at = Date.parse(`${day}T12:00:00Z`);
    return Number.isNaN(at) ? day : format.date(at, { dateStyle: "medium", timeZone: "UTC" });
  };
}

function InsightMoney(props: SectionProps): JSX.Element {
  const { t, format, errorMessage } = useText();
  const calendarDay = useCalendarDay();
  const [adding, setAdding] = createSignal<InsightMoneyDraft | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [syncing, setSyncing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const days = createMemo(() => new Set(props.report.costs.days));
  const amounts = (values: ReadonlyMap<string, number>) =>
    values.size === 0
      ? format.number(0)
      : [...values]
          .map(([currency, amount]) => format.currency(amount, currency, { maximumFractionDigits: 2 }))
          .join(" + ");
  const net = (money: MoneyTotals) => {
    const currencies = new Set([...money.spend.keys(), ...money.revenue.keys()]);
    if (currencies.size !== 1) return null;
    const [currency] = currencies;
    const value = (money.revenue.get(currency ?? "") ?? 0) - (money.spend.get(currency ?? "") ?? 0);
    return format.currency(value, currency ?? "", { maximumFractionDigits: 2, signDisplay: "exceptZero" });
  };
  const spaces = createMemo(() =>
    props.spaces
      .map((space) => {
        const entries = props.report.money.filter((entry) => entry.spaceId === space.id && days().has(entry.date));
        const sources = props.report.sources.filter((source) => source.spaceId === space.id);
        const byDay = [...new Set(entries.map((entry) => entry.date))]
          .sort((a, b) => b.localeCompare(a))
          .map((date) => ({ date, money: totals(entries.filter((entry) => entry.date === date)) }));
        return { space, entries, sources, money: totals(entries), byDay };
      })
      .filter((item) => item.entries.length > 0 || item.sources.length > 0),
  );
  async function add() {
    const draft = adding();
    if (!draft || busy() || !(draft.amount >= 0) || !/^[A-Z]{3,8}$/u.test(draft.currency)) return;
    setBusy(true);
    setError(null);
    try {
      await props.onAddMoney(draft);
      setAdding(null);
    } catch (failure) {
      setError(errorMessage(failure, t("insight.failed")));
    } finally {
      setBusy(false);
    }
  }
  const today = () => zoneDay(props.report.at, props.report.timeZone);
  return (
    <>
      <div class="ws-insight-actions">
        <Button
          size="sm"
          variant="outline"
          loading={syncing()}
          onClick={() => {
            setSyncing(true);
            void props
              .onSync()
              .catch(() => undefined)
              .finally(() => setSyncing(false));
          }}
        >
          <RefreshCw aria-hidden="true" />
          {t("insight.money.sync")}
        </Button>
        <PaneHeaderAction
          label={t("insight.money.add")}
          onClick={() =>
            setAdding({
              spaceId: props.spaces[0]?.id ?? "general",
              date: today(),
              kind: "spend",
              amount: 0,
              currency: "USD",
              sales: null,
            })
          }
        />
      </div>
      <Show
        when={spaces().length > 0}
        fallback={
          <EmptyState icon={<Wallet />} title={t("insight.money.emptyTitle")} description={t("insight.money.empty")} />
        }
      >
        <For each={spaces()} keyed={(item) => item.space.id}>
          {(item) => (
            <section class="ws-insight-section">
              <h3 class="ws-insight-heading">{item().space.name}</h3>
              <dl class="ws-insight-stats">
                <div>
                  <dt>{t("insight.money.spend")}</dt>
                  <dd>{amounts(item().money.spend)}</dd>
                </div>
                <div>
                  <dt>{t("insight.money.revenue")}</dt>
                  <dd>{amounts(item().money.revenue)}</dd>
                </div>
                <div>
                  <dt>{t("insight.money.net")}</dt>
                  <dd>{net(item().money) ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t("insight.money.sales")}</dt>
                  <dd>{format.number(item().money.sales)}</dd>
                </div>
              </dl>
              <For each={item().sources} keyed={(source) => source.kind}>
                {(source) => (
                  <p class="ws-insight-source" data-state={source().state}>
                    {t(SOURCE_KEY[source().kind])}: {t(SOURCE_STATE_KEY[source().state])}
                    {source().syncedAt
                      ? ` · ${t("insight.money.synced", {
                          time: format.date(Date.parse(source().syncedAt ?? ""), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }),
                        })}`
                      : ""}
                    {source().detail ? ` · ${source().detail}` : ""}
                  </p>
                )}
              </For>
              <WorkspaceList label={t("insight.money.days")}>
                <For each={item().byDay} keyed={(day) => day.date}>
                  {(day) => (
                    <WorkspaceListRow
                      title={format.date(Date.parse(`${day().date}T12:00:00Z`), {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                        // The row is a calendar day: noon UTC names it in every zone, from -12 to +14.
                        timeZone: "UTC",
                      })}
                      titleEnd={net(day().money) ?? undefined}
                    >
                      <span class="ws-insight-line">
                        {t("insight.money.dayLine", {
                          spend: amounts(day().money.spend),
                          revenue: amounts(day().money.revenue),
                          sales: day().money.sales,
                        })}
                      </span>
                    </WorkspaceListRow>
                  )}
                </For>
              </WorkspaceList>
              <Show when={item().entries.some((entry) => entry.source === "manual")}>
                <WorkspaceList label={t("insight.money.manual")}>
                  <For each={item().entries.filter((entry) => entry.source === "manual")} keyed={(entry) => entry.id}>
                    {(entry) => (
                      <WorkspaceListRow
                        title={`${calendarDay(entry().date)} · ${t(MONEY_KIND_KEY[entry().kind])}`}
                        titleEnd={format.currency(entry().amount, entry().currency, { maximumFractionDigits: 2 })}
                        actions={
                          <IconButton
                            variant="ghost"
                            size="icon-xs"
                            label={t("insight.money.remove")}
                            onClick={() => void props.onRemoveMoney(entry().id).catch(() => undefined)}
                          >
                            <Trash2 />
                          </IconButton>
                        }
                      >
                        <Show when={entry().note}>{(note) => <span class="ws-muted">{note()}</span>}</Show>
                      </WorkspaceListRow>
                    )}
                  </For>
                </WorkspaceList>
              </Show>
            </section>
          )}
        </For>
      </Show>
      <FormDialog
        open={adding() !== null}
        onOpenChange={(open) => {
          if (open) return;
          setAdding(null);
          setError(null);
        }}
        title={t("insight.money.add")}
        description={t("insight.money.addDescription")}
        size="sm"
        busy={busy()}
        error={error()}
        submitLabel={t("insight.save")}
        onSubmit={() => void add()}
      >
        <Show when={adding()}>
          {(draft) => {
            const set = (change: Partial<InsightMoneyDraft>) => setAdding({ ...draft(), ...change });
            return (
              <>
                <Field label={t("insight.space")}>
                  <WorkspaceSelect
                    value={draft().spaceId}
                    label={t("insight.space")}
                    options={props.spaces.map((space) => ({ value: space.id, label: space.name }))}
                    onChange={(spaceId) => set({ spaceId })}
                  />
                </Field>
                <div class="ws-insight-pair">
                  <Field label={t("insight.money.date")}>
                    <Input
                      type="date"
                      value={draft().date}
                      onInput={(event) => set({ date: event.currentTarget.value })}
                    />
                  </Field>
                  <Field label={t("insight.money.kindLabel")}>
                    <WorkspaceSelect
                      value={draft().kind}
                      label={t("insight.money.kindLabel")}
                      options={[
                        { value: "spend", label: t("insight.money.kind.spend") },
                        { value: "revenue", label: t("insight.money.kind.revenue") },
                      ]}
                      onChange={(kind) => set({ kind })}
                    />
                  </Field>
                </div>
                <div class="ws-insight-pair">
                  <Field label={t("insight.money.amount")} required>
                    <Input
                      type="number"
                      inputmode="decimal"
                      value={String(draft().amount)}
                      onInput={(event) => set({ amount: Number(event.currentTarget.value) })}
                    />
                  </Field>
                  <Field label={t("insight.money.currency")}>
                    <Input
                      value={draft().currency}
                      autocapitalize="characters"
                      onInput={(event) =>
                        set({ currency: event.currentTarget.value.toUpperCase().replace(/[^A-Z]/gu, "") })
                      }
                    />
                  </Field>
                </div>
                <Show when={draft().kind === "revenue"}>
                  <Field label={t("insight.money.sales")}>
                    <Input
                      type="number"
                      inputmode="numeric"
                      value={draft().sales === null || draft().sales === undefined ? "" : String(draft().sales)}
                      onInput={(event) =>
                        set({
                          sales:
                            event.currentTarget.value === ""
                              ? null
                              : Math.max(0, Math.round(Number(event.currentTarget.value))),
                        })
                      }
                    />
                  </Field>
                </Show>
                <Field label={t("insight.money.note")}>
                  <Input
                    value={draft().note ?? ""}
                    onInput={(event) => set({ note: event.currentTarget.value || null })}
                  />
                </Field>
              </>
            );
          }}
        </Show>
      </FormDialog>
    </>
  );
}

function InsightCosts(props: SectionProps): JSX.Element {
  const { t, format } = useText();
  const [sort, setSort] = createSignal<InsightCostSort>("cost");
  const [space, setSpace] = createSignal("all");
  const rows = createMemo(() => {
    const list = props.report.costs.agents.filter((agent) => space() === "all" || agent.spaceId === space());
    const key: Record<InsightCostSort, (agent: InsightAgentCost) => number | string> = {
      cost: (agent) => -agent.costUsd,
      idle: (agent) => -agent.idleCostUsd,
      side: (agent) => -agent.sideCostUsd,
      tokens: (agent) => -agent.tokens,
      name: (agent) => props.member(agent.agentId).name.toLocaleLowerCase(),
    };
    const pick = key[sort()];
    return [...list].sort((a, b) => {
      const x = pick(a);
      const y = pick(b);
      return typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    });
  });
  const spaceTotals = createMemo(() =>
    props.spaces
      .map((item) => ({
        ...item,
        cost: props.report.costs.agents
          .filter((agent) => agent.spaceId === item.id)
          .reduce((sum, agent) => sum + agent.costUsd, 0),
      }))
      .filter((item) => item.cost > 0)
      .sort((a, b) => b.cost - a.cost),
  );
  const costs = () => props.report.costs;
  const change = () => {
    const previous = costs().previousWeekUsd;
    return previous > 0 ? (costs().weekUsd - previous) / previous : null;
  };
  return (
    <>
      <dl class="ws-insight-stats">
        <div>
          <dt>{t("insight.costs.total", { days: props.days })}</dt>
          <dd>
            {format.currencyUsd(costs().totalUsd)}
            <Show when={props.days === 7 ? change() : null}>
              {(value) => (
                <span class="ws-muted">
                  {" "}
                  {format.percent(value(), { signDisplay: "exceptZero", maximumFractionDigits: 0 })}
                </span>
              )}
            </Show>
          </dd>
        </div>
        {/* With 7 days chosen the first tile is the week already: one tile, with the change. */}
        <Show when={props.days !== 7}>
          <div>
            <dt>{t("insight.costs.week")}</dt>
            <dd>
              {format.currencyUsd(costs().weekUsd)}
              <Show when={change()}>
                {(value) => (
                  <span class="ws-muted">
                    {" "}
                    {format.percent(value(), { signDisplay: "exceptZero", maximumFractionDigits: 0 })}
                  </span>
                )}
              </Show>
            </dd>
          </div>
        </Show>
        <div>
          <dt>{t("insight.costs.side")}</dt>
          <dd>{format.currencyUsd(costs().sideUsd)}</dd>
        </div>
        <div>
          <dt>{t("insight.costs.idle")}</dt>
          <dd>{format.currencyUsd(costs().idleUsd)}</dd>
        </div>
      </dl>
      <p class="ws-insight-note">{t("insight.costs.note")}</p>
      <Show when={spaceTotals().length > 1}>
        <WorkspaceList label={t("insight.costs.bySpace")}>
          <For each={spaceTotals()} keyed={(item) => item.id}>
            {(item) => <WorkspaceListRow title={item().name} titleEnd={format.currencyUsd(item().cost)} />}
          </For>
        </WorkspaceList>
      </Show>
      <div class="ws-insight-actions">
        <WorkspaceSelect
          value={sort()}
          label={t("insight.costs.sort")}
          prefix={t("insight.costs.sort")}
          options={(["cost", "idle", "side", "tokens", "name"] as const).map((value) => ({
            value,
            label: t(SORT_KEY[value]),
          }))}
          onChange={setSort}
        />
        <WorkspaceSelect
          value={space()}
          label={t("insight.space")}
          options={[
            { value: "all", label: t("insight.allSpaces") },
            ...props.spaces.map((item) => ({ value: item.id, label: item.name })),
          ]}
          onChange={setSpace}
        />
      </div>
      <Show
        when={rows().length > 0}
        fallback={
          <EmptyState icon={<Coins />} title={t("insight.costs.emptyTitle")} description={t("insight.costs.empty")} />
        }
      >
        <WorkspaceList label={t("insight.tab.costs")}>
          <For each={rows()} keyed={(agent) => agent.agentId}>
            {(agent) => {
              const member = () => props.member(agent().agentId);
              const idleShare = () => (agent().costUsd > 0 ? agent().idleCostUsd / agent().costUsd : 0);
              return (
                <WorkspaceListRow
                  class="ws-insight-cost"
                  leading={<MemberAvatar member={member()} size="lg" />}
                  title={member().name}
                  titleEnd={format.currencyUsd(agent().costUsd)}
                  trailing={<Sparkline values={agent().daily} label={t("insight.costs.daily")} />}
                >
                  <span class="ws-insight-line">
                    {t("insight.costs.line", {
                      turns: agent().turns,
                      tokens: format.compact(agent().tokens),
                      side: format.currencyUsd(agent().sideCostUsd),
                    })}
                  </span>
                  <Show when={agent().idleTurns > 0}>
                    <span class="ws-insight-idle" data-high={idleShare() >= 0.3 ? "" : undefined}>
                      {t("insight.costs.idleLine", {
                        count: agent().idleTurns,
                        cost: format.currencyUsd(agent().idleCostUsd),
                      })}
                    </span>
                  </Show>
                </WorkspaceListRow>
              );
            }}
          </For>
        </WorkspaceList>
      </Show>
    </>
  );
}

function InsightBriefing(props: SectionProps): JSX.Element {
  const { t, format, errorMessage } = useText();
  // A briefing that never went out starts from the reader: their time zone, and English unless the
  // app speaks Spanish (the host's default is Spanish, which an English reader did not choose).
  const fresh = () => props.report.briefing.lastSentAt === null;
  const [draft, setDraft] = createSignal<InsightBriefingSettings>({
    ...props.report.briefing.settings,
    timeZone: props.report.briefing.settings.timeZone || props.report.timeZone,
    ...(fresh() && !format.locale.toLowerCase().startsWith("es") ? { language: "en" as const } : {}),
  });
  /** Every zone the browser knows, with the one saved first when it is not among them. */
  const zones = (() => {
    let all: string[] = [];
    try {
      all = Intl.supportedValuesOf("timeZone");
    } catch {
      all = [];
    }
    const chosen = draft().timeZone;
    return chosen && !all.includes(chosen) ? [chosen, ...all] : all;
  })();
  const [busy, setBusy] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const set = (change: Partial<InsightBriefingSettings>) => setDraft({ ...draft(), ...change });
  const toggle = (list: readonly string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((item) => item !== id);
  const briefing = () => props.report.briefing;
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await props.onSaveBriefing(draft());
    } catch (failure) {
      setError(errorMessage(failure, t("insight.failed")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section class="ws-insight-section ws-insight-form">
        <SwitchField
          checked={draft().enabled}
          onChange={(enabled: boolean) => set({ enabled })}
          label={t("insight.briefing.enabled")}
          description={t("insight.briefing.enabledHint")}
        />
        <div class="ws-insight-pair">
          <Field label={t("insight.briefing.time")}>
            <Input
              type="time"
              value={draft().time}
              onInput={(event) => set({ time: event.currentTarget.value || "08:00" })}
            />
          </Field>
          <Field label={t("insight.briefing.language")}>
            <WorkspaceSelect
              value={draft().language}
              label={t("insight.briefing.language")}
              options={[
                { value: "es", label: "Español" },
                { value: "en", label: "English" },
              ]}
              onChange={(language) => set({ language })}
            />
          </Field>
        </div>
        <Field label={t("insight.briefing.timeZone")}>
          <Show
            when={zones.length > 0}
            fallback={
              <Input
                value={draft().timeZone}
                placeholder={props.report.timeZone}
                onInput={(event) => set({ timeZone: event.currentTarget.value.trim() })}
              />
            }
          >
            <WorkspaceSelect
              value={draft().timeZone}
              label={t("insight.briefing.timeZone")}
              options={zones.map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }))}
              onChange={(timeZone) => set({ timeZone })}
            />
          </Show>
        </Field>
        <SwitchField
          checked={draft().allSpaces}
          onChange={(allSpaces: boolean) => set({ allSpaces })}
          label={t("insight.briefing.allSpaces")}
        />
        <fieldset class="ws-insight-checks">
          <legend>{t("insight.briefing.perSpace")}</legend>
          <For each={props.spaces} keyed={(space) => space.id}>
            {(space) => (
              <span class="ws-insight-check">
                <Checkbox
                  aria-label={space().name}
                  checked={draft().spaceIds.includes(space().id)}
                  onChange={(event) =>
                    set({ spaceIds: toggle(draft().spaceIds, space().id, event.currentTarget.checked) })
                  }
                />
                <span aria-hidden="true">{space().name}</span>
              </span>
            )}
          </For>
        </fieldset>
        <p class="ws-insight-heading">{t("insight.briefing.alertRule")}</p>
        <div class="ws-insight-pair">
          <Field label={t("insight.briefing.alertMinSpend")}>
            <Input
              type="number"
              inputmode="decimal"
              value={String(draft().alertMinSpend)}
              onInput={(event) => set({ alertMinSpend: Math.max(0, Number(event.currentTarget.value) || 0) })}
            />
          </Field>
          <Field label={t("insight.briefing.alertDays")}>
            <Input
              type="number"
              inputmode="numeric"
              min="1"
              max="14"
              value={String(draft().alertDays)}
              onInput={(event) =>
                set({ alertDays: Math.min(14, Math.max(1, Math.round(Number(event.currentTarget.value) || 1))) })
              }
            />
          </Field>
        </div>
        <fieldset class="ws-insight-checks">
          <legend>{t("insight.briefing.replace")}</legend>
          <p class="ws-insight-note">{t("insight.briefing.replaceHint")}</p>
          <Show
            when={briefing().routines.length > 0}
            fallback={<p class="ws-muted">{t("insight.briefing.noRoutines")}</p>}
          >
            <For each={briefing().routines} keyed={(routine) => routine.routineId}>
              {(routine) => (
                <span class="ws-insight-check">
                  <Checkbox
                    aria-label={routine().name}
                    checked={draft().replaceRoutineIds.includes(routine().routineId)}
                    onChange={(event) =>
                      set({
                        replaceRoutineIds: toggle(
                          draft().replaceRoutineIds,
                          routine().routineId,
                          event.currentTarget.checked,
                        ),
                      })
                    }
                  />
                  <span>
                    {routine().name}
                    <span class="ws-muted">
                      {" · "}
                      {props.member(routine().agentId).name}
                      {" · "}
                      {routine().active ? t("insight.briefing.routineOn") : t("insight.briefing.routineOff")}
                    </span>
                  </span>
                </span>
              )}
            </For>
          </Show>
        </fieldset>
        <Show when={error()}>
          {(message) => (
            <p class="ws-insight-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <div class="ws-insight-actions">
          <Button size="sm" loading={busy()} onClick={() => void save()}>
            {t("insight.save")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            loading={sending()}
            onClick={() => {
              setSending(true);
              void props
                .onSendBriefing()
                .catch(() => undefined)
                .finally(() => setSending(false));
            }}
          >
            <Send aria-hidden="true" />
            {t("insight.briefing.sendNow")}
          </Button>
          <Show when={briefing().channelId}>
            {(channelId) => (
              <Button size="sm" variant="ghost" onClick={() => props.onOpenChannel(channelId())}>
                {t("insight.briefing.open")}
              </Button>
            )}
          </Show>
        </div>
      </section>
      <Show when={briefing().lastText}>
        {(text) => (
          <section class="ws-insight-section">
            <h3 class="ws-insight-heading">
              <Sunrise aria-hidden="true" />
              {t("insight.briefing.last", {
                time: format.date(Date.parse(briefing().lastSentAt ?? ""), { dateStyle: "medium", timeStyle: "short" }),
              })}
            </h3>
            <p class="ws-insight-briefing">{text()}</p>
          </section>
        )}
      </Show>
    </>
  );
}
