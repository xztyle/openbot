import {
  FAILOVER_STEPS,
  type FailoverStep,
  GUARDRAIL_LIMIT_KEYS,
  type GuardrailEventKind,
  type GuardrailFullLimits,
  type GuardrailLimitKey,
  type GuardrailPolicy,
  type GuardrailRunKey,
  type GuardrailRunLimits,
  type GuardrailsView,
  type SubscriptionWindowMeter,
} from "@openbot/contracts/guardrails";
import type { AppTextKey } from "@openbot/i18n";
import {
  Badge,
  Button,
  Input,
  SettingsGroup,
  SettingsHelp,
  SettingsRow,
  SettingsSection,
  SwitchField,
  toast,
} from "@openbot/ui";
import { SaveBarDock, SettingsSaveBar } from "@openbot/ui/features/settings/SettingsDialogShell";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import type { GuardrailCalls } from "./trust-port";

const LIMIT_LABEL = {
  turnsPerDay: "trust.guardrails.limit.turns",
  tokensPerDay: "trust.guardrails.limit.tokens",
  costUsdPerDay: "trust.guardrails.limit.cost",
  windowSharePercent: "trust.guardrails.limit.share",
} as const satisfies Record<GuardrailLimitKey, AppTextKey>;

const RUN_KEYS: readonly GuardrailRunKey[] = ["maxSteps", "maxTokens", "maxMinutes"];
const RUN_LABEL = {
  maxSteps: "trust.guardrails.run.steps",
  maxTokens: "trust.guardrails.limit.tokens",
  maxMinutes: "trust.guardrails.run.minutes",
} as const satisfies Record<GuardrailRunKey, AppTextKey>;

const STEP_LABEL = {
  claude: "trust.guardrails.step.claude",
  "codex-plan": "trust.guardrails.step.codexPlan",
  "codex-credits": "trust.guardrails.step.codexCredits",
  none: "trust.guardrails.step.none",
} as const satisfies Record<FailoverStep, AppTextKey>;

/** Token limits show in millions: a day of one agent is hundreds of millions. */
const MILLION = 1_000_000;

function shown(key: GuardrailLimitKey | GuardrailRunKey, value: number | null): string {
  if (value === null) return "";
  return key === "tokensPerDay" || key === "maxTokens" ? String(value / MILLION) : String(value);
}

function parsed(key: GuardrailLimitKey | GuardrailRunKey, text: string): number | null {
  const value = Number(text.trim().replace(",", "."));
  if (!text.trim() || !Number.isFinite(value) || value < 0) return null;
  return key === "tokensPerDay" || key === "maxTokens" ? Math.round(value * MILLION) : value;
}

/**
 * The Guardrails tab of the Trust view: the counts of the last week, what is paused now with Resume,
 * the subscription meter with its forecast, the agents that the failover moved, today's use against
 * the limits, the limits themselves and the newest events. The host enforces them; this view edits.
 */
export function TrustGuardrailsPanel(props: {
  calls: () => GuardrailCalls | undefined;
  name: (scope: "agent" | "space", id: string) => string;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t, format, errorMessage } = useText();
  const [view, setView] = createSignal<GuardrailsView | null>(null);
  const [draft, setDraft] = createSignal<GuardrailPolicy | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const dirty = () => JSON.stringify(view()?.policy ?? null) !== JSON.stringify(draft());

  const accept = (next: GuardrailsView) => {
    setView(next);
    setDraft(next.policy);
  };

  async function load() {
    const calls = props.calls();
    if (!calls) return;
    try {
      accept(await calls.view());
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, t("trust.guardrails.loadFailed")));
    }
  }
  onSettled(() => void load());

  async function save() {
    const calls = props.calls();
    const policy = draft();
    if (!calls || !policy) return;
    setSaving(true);
    try {
      accept(await calls.save(policy));
      toast.success(t("trust.guardrails.saved"));
    } catch (error) {
      toast.error(t("trust.guardrails.saveFailed"), { error, fallback: t("trust.guardrails.saveFailed") });
    } finally {
      setSaving(false);
    }
  }

  async function resume(scope: "agent" | "space", id: string) {
    const calls = props.calls();
    if (!calls) return;
    try {
      accept(await calls.resume(scope, id));
      toast.success(t("trust.guardrails.resumed"));
    } catch (error) {
      toast.error(t("trust.guardrails.saveFailed"), { error, fallback: t("trust.guardrails.saveFailed") });
    }
  }

  const change = (update: (policy: GuardrailPolicy) => GuardrailPolicy) => {
    const current = draft();
    if (current) setDraft(update(current));
  };
  /**
   * A meter's time is in epoch seconds; a pause's and an event's is an ISO time. Empty for a time that
   * does not parse: a date format throws on it, and the panel would not render. The clock is written
   * as in Money: "Mon 3:05 PM", not "Mon 03:05 PM".
   */
  const time = (iso: string | number) => {
    const ms = typeof iso === "number" ? iso * 1000 : Date.parse(iso);
    return Number.isFinite(ms) ? format.date(ms, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
  };
  const kpi = (kinds: GuardrailEventKind[]) => kinds.reduce((sum, kind) => sum + (view()?.kpis[kind] ?? 0), 0);
  const busiest = createMemo(() =>
    (view()?.usage ?? [])
      .filter((row) => row.turns > 0)
      .map((row) => {
        const ratios = GUARDRAIL_LIMIT_KEYS.map((key) => {
          const limit = row.limits[key];
          const used =
            key === "turnsPerDay"
              ? row.turns
              : key === "tokensPerDay"
                ? row.tokens
                : key === "costUsdPerDay"
                  ? row.costUsd
                  : row.windowSharePercent;
          return limit && used !== null ? used / limit : 0;
        });
        return { row, ratio: Math.max(...ratios) };
      })
      .sort((left, right) => right.ratio - left.ratio)
      .slice(0, 20),
  );
  const windowLabel = (window: SubscriptionWindowMeter) =>
    window.windowDurationMins === null
      ? ""
      : window.windowDurationMins < 24 * 60
        ? t("trust.guardrails.window.hours", { count: Math.round(window.windowDurationMins / 60) })
        : t("trust.guardrails.window.days", { count: Math.round(window.windowDurationMins / (24 * 60)) });

  return (
    <>
      <Show when={loadError()}>
        {(message) => (
          <p class="trust-alert" role="alert">
            {message()}{" "}
            <Button type="button" size="sm" variant="ghost" onClick={() => void load()}>
              {t("common.retry")}
            </Button>
          </p>
        )}
      </Show>
      <Show when={view() && draft()}>
        <SettingsSection title={t("trust.guardrails.week")}>
          <div class="guardrails-kpis">
            <span class="guardrails-kpi">
              <strong>{kpi(["injection-blocked"])}</strong> {t("trust.guardrails.kpi.injections")}
            </span>
            <span class="guardrails-kpi">
              <strong>{kpi(["stuck-stop", "loop-stop"])}</strong> {t("trust.guardrails.kpi.stuck")}
            </span>
            <span class="guardrails-kpi">
              <strong>{kpi(["breaker"])}</strong> {t("trust.guardrails.kpi.breakers")}
            </span>
            <span class="guardrails-kpi">
              <strong>{kpi(["budget-pause"])}</strong> {t("trust.guardrails.kpi.pauses")}
            </span>
          </div>
        </SettingsSection>
        <SettingsSection title={t("trust.guardrails.paused")}>
          <SettingsGroup label={t("trust.guardrails.paused")}>
            <For
              each={view()?.pauses ?? []}
              fallback={<SettingsHelp>{t("trust.guardrails.pausedEmpty")}</SettingsHelp>}
            >
              {(pause) => (
                <SettingsRow
                  label={props.name(pause.scope, pause.id)}
                  description={`${pause.detail} · ${
                    pause.until
                      ? t("trust.guardrails.until", { time: time(pause.until) })
                      : t("trust.guardrails.untilOwner")
                  }`}
                >
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void resume(pause.scope, pause.id)}
                  >
                    {t("trust.guardrails.resume")}
                  </Button>
                </SettingsRow>
              )}
            </For>
          </SettingsGroup>
        </SettingsSection>
        <SettingsSection title={t("trust.guardrails.meter")}>
          <For each={view()?.meter ?? []} fallback={<SettingsHelp>{t("trust.guardrails.meterEmpty")}</SettingsHelp>}>
            {(account) => (
              <SettingsGroup
                title={account.label ? `${account.provider} · ${account.label}` : account.provider}
                description={
                  <span class="guardrails-badges">
                    <Show when={account.nearlyExhausted}>
                      <Badge variant="destructive">{t("trust.guardrails.nearlyOut")}</Badge>
                    </Show>
                    <Show when={account.onCredits}>
                      <Badge variant="secondary">{t("trust.guardrails.onCredits")}</Badge>
                    </Show>
                    <Show when={account.inUse}>
                      <Badge variant="secondary">{t("trust.guardrails.inUse")}</Badge>
                    </Show>
                    <span>{t("trust.guardrails.agents", { count: account.agents })}</span>
                  </span>
                }
              >
                <Show when={account.creditBalance !== undefined}>
                  <SettingsHelp>
                    {t("trust.guardrails.creditBalance", { balance: format.number(account.creditBalance ?? 0) })}
                  </SettingsHelp>
                </Show>
                <Show when={(account.resetCredits ?? 0) > 0}>
                  <SettingsHelp>
                    {t("trust.guardrails.resetCredits", { count: account.resetCredits ?? 0 })}
                  </SettingsHelp>
                </Show>
                <For each={account.windows}>
                  {(window) => (
                    <div class="guardrails-window">
                      <span class="guardrails-window-label">{windowLabel(window)}</span>
                      <span class="guardrails-bar" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, window.usedPercent)}%` }} />
                      </span>
                      <span class="trust-muted">
                        {t("trust.guardrails.window.used", { percent: Math.round(window.usedPercent) })}
                        {window.resetsAt
                          ? ` · ${t("trust.guardrails.window.resets", { time: time(window.resetsAt) })}`
                          : ""}
                        {window.exhaustsAt
                          ? ` · ${t("trust.guardrails.window.runsOut", { time: time(window.exhaustsAt) })}`
                          : ""}
                      </span>
                    </div>
                  )}
                </For>
              </SettingsGroup>
            )}
          </For>
          <Show when={view()?.steps}>
            {(steps) => (
              <SettingsGroup title={t("trust.guardrails.order")} description={t("trust.guardrails.orderDescription")}>
                <For each={FAILOVER_STEPS}>
                  {(step, index) => {
                    const agents = () => steps().filter((row) => row.step === step);
                    return (
                      <SettingsRow
                        label={step === "none" ? t(STEP_LABEL[step]) : `${index() + 1}. ${t(STEP_LABEL[step])}`}
                        description={
                          agents().length > 0
                            ? agents()
                                .map((row) => props.name("agent", row.agentId))
                                .join(", ")
                            : t("trust.guardrails.stepEmpty")
                        }
                      />
                    );
                  }}
                </For>
              </SettingsGroup>
            )}
          </Show>
          <Show when={(view()?.failovers ?? []).length > 0}>
            <SettingsGroup title={t("trust.guardrails.failovers")}>
              <For each={view()?.failovers ?? []}>
                {(row) => (
                  <SettingsRow
                    label={props.name("agent", row.agentId)}
                    description={t("trust.guardrails.failoverRow", {
                      from: `${row.from.provider}/${row.from.model}`,
                      to: `${row.to.provider}/${row.to.model}`,
                    })}
                  >
                    <Button type="button" size="sm" variant="ghost" onClick={() => props.onOpenAgent(row.agentId)}>
                      {t("common.open")}
                    </Button>
                  </SettingsRow>
                )}
              </For>
            </SettingsGroup>
          </Show>
        </SettingsSection>
        <SettingsSection title={t("trust.guardrails.today")}>
          <SettingsGroup label={t("trust.guardrails.today")}>
            <For each={busiest()} fallback={<SettingsHelp>{t("trust.guardrails.todayEmpty")}</SettingsHelp>}>
              {({ row }) => (
                <SettingsRow
                  layout="inline"
                  label={props.name(row.scope, row.id)}
                  description={`${t("trust.guardrails.usage", {
                    turns: format.number(row.turns),
                    cost: format.currencyUsd(row.costUsd),
                    tokens: format.compact(row.tokens),
                  })}${
                    row.windowSharePercent === null
                      ? ""
                      : ` · ${t("trust.guardrails.window.used", { percent: Math.round(row.windowSharePercent) })}`
                  }`}
                >
                  <Show when={row.state !== "ok"}>
                    <Badge variant={row.state === "paused" ? "destructive" : "secondary"}>
                      {row.state === "paused" ? t("trust.guardrails.state.paused") : t("trust.guardrails.state.warn")}
                    </Badge>
                  </Show>
                </SettingsRow>
              )}
            </For>
          </SettingsGroup>
        </SettingsSection>
        <Show when={draft()}>
          {(policy) => (
            <SettingsSection title={t("trust.guardrails.limits")} description={t("trust.guardrails.limitsDescription")}>
              <SettingsGroup label={t("trust.guardrails.enabled")}>
                <SwitchField
                  size="default"
                  checked={policy().enabled}
                  onChange={(enabled) => change((current) => ({ ...current, enabled }))}
                  label={t("trust.guardrails.enabled")}
                  description={t("trust.guardrails.enabledDescription")}
                />
              </SettingsGroup>
              <LimitFields
                title={t("trust.guardrails.agentDefaults")}
                limits={policy().agentDefaults}
                onChange={(agentDefaults) => change((current) => ({ ...current, agentDefaults }))}
              />
              <LimitFields
                title={t("trust.guardrails.spaceDefaults")}
                limits={policy().spaceDefaults}
                onChange={(spaceDefaults) => change((current) => ({ ...current, spaceDefaults }))}
              />
              <RunFields
                title={t("trust.guardrails.turnBreaker")}
                limits={policy().turn}
                onChange={(turn) => change((current) => ({ ...current, turn }))}
              />
              <RunFields
                title={t("trust.guardrails.routineBreaker")}
                limits={policy().routine}
                onChange={(routine) => change((current) => ({ ...current, routine }))}
              />
              <SettingsGroup title={t("trust.guardrails.group.alerts")}>
                <NumberRow
                  label={t("trust.guardrails.warnPercent")}
                  value={policy().warnPercent}
                  onChange={(value) => value !== null && change((current) => ({ ...current, warnPercent: value }))}
                />
                <NumberRow
                  label={t("trust.guardrails.moneyHours")}
                  value={policy().moneyApprovalHours}
                  onChange={(value) =>
                    value !== null && change((current) => ({ ...current, moneyApprovalHours: value }))
                  }
                />
                <SwitchField
                  checked={policy().injection.enabled}
                  onChange={(enabled) => change((current) => ({ ...current, injection: { enabled } }))}
                  label={t("trust.guardrails.injection")}
                />
              </SettingsGroup>
              <SettingsGroup title={t("trust.guardrails.group.stuck")}>
                <SwitchField
                  checked={policy().stuck.enabled}
                  onChange={(enabled) => change((current) => ({ ...current, stuck: { ...current.stuck, enabled } }))}
                  label={t("trust.guardrails.stuck")}
                />
                <NumberRow
                  label={t("trust.guardrails.stuckRepeats")}
                  value={policy().stuck.repeats}
                  onChange={(value) =>
                    value !== null && change((current) => ({ ...current, stuck: { ...current.stuck, repeats: value } }))
                  }
                />
                <NumberRow
                  label={t("trust.guardrails.pingPong")}
                  value={policy().stuck.pingPong}
                  onChange={(value) =>
                    value !== null &&
                    change((current) => ({ ...current, stuck: { ...current.stuck, pingPong: value } }))
                  }
                />
              </SettingsGroup>
              <SettingsGroup title={t("trust.guardrails.group.failover")}>
                <SwitchField
                  checked={policy().failover.enabled}
                  onChange={(enabled) =>
                    change((current) => ({ ...current, failover: { ...current.failover, enabled } }))
                  }
                  label={t("trust.guardrails.failover")}
                />
                <SwitchField
                  checked={policy().failover.allowApiKey}
                  onChange={(allowApiKey) =>
                    change((current) => ({ ...current, failover: { ...current.failover, allowApiKey } }))
                  }
                  label={t("trust.guardrails.allowApiKey")}
                />
                <NumberRow
                  label={t("trust.guardrails.failoverThreshold")}
                  value={policy().failover.thresholdPercent}
                  onChange={(value) =>
                    value !== null &&
                    change((current) => ({ ...current, failover: { ...current.failover, thresholdPercent: value } }))
                  }
                />
              </SettingsGroup>
            </SettingsSection>
          )}
        </Show>
        <SettingsSection title={t("trust.guardrails.events")}>
          <SettingsGroup label={t("trust.guardrails.events")}>
            <For
              each={view()?.events ?? []}
              fallback={<SettingsHelp>{t("trust.guardrails.eventsEmpty")}</SettingsHelp>}
            >
              {(event) => (
                <div class="guardrails-event">
                  <span class="trust-muted">{time(event.at)}</span>
                  <span>{event.summary}</span>
                </div>
              )}
            </For>
          </SettingsGroup>
        </SettingsSection>
      </Show>
      <SaveBarDock value={dirty() ? true : null}>
        {() => (
          <SettingsSaveBar
            label={t("trust.unsaved")}
            message={t("trust.unsaved")}
            saving={saving()}
            resetDisabled={saving()}
            onReset={() => setDraft(view()?.policy ?? null)}
            onSave={() => void save()}
          />
        )}
      </SaveBarDock>
    </>
  );
}

/** One number of the policy: its name on the left, a short field on the right. Empty means "no limit". */
function NumberRow(props: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  const id = `guardrails-number-${createUniqueId()}`;
  return (
    <SettingsRow label={props.label} controlId={id}>
      <Input
        id={id}
        class="trust-number"
        size="sm"
        inputmode="decimal"
        value={props.value === null ? "" : String(props.value)}
        onValueChange={(text) => {
          const value = Number(text.trim().replace(",", "."));
          props.onChange(text.trim() && Number.isFinite(value) && value >= 0 ? value : null);
        }}
      />
    </SettingsRow>
  );
}

function LimitFields(props: {
  title: string;
  limits: GuardrailFullLimits;
  onChange: (limits: GuardrailFullLimits) => void;
}) {
  const { t } = useText();
  const ids = `guardrails-limit-${createUniqueId()}`;
  return (
    <SettingsGroup title={props.title}>
      <For each={GUARDRAIL_LIMIT_KEYS}>
        {(key) => (
          <SettingsRow label={t(LIMIT_LABEL[key])} controlId={`${ids}-${key}`}>
            <Input
              id={`${ids}-${key}`}
              class="trust-number"
              size="sm"
              inputmode="decimal"
              value={shown(key, props.limits[key])}
              onValueChange={(text) => props.onChange({ ...props.limits, [key]: parsed(key, text) })}
            />
          </SettingsRow>
        )}
      </For>
    </SettingsGroup>
  );
}

function RunFields(props: {
  title: string;
  limits: GuardrailRunLimits;
  onChange: (limits: GuardrailRunLimits) => void;
}) {
  const { t } = useText();
  const ids = `guardrails-run-${createUniqueId()}`;
  return (
    <SettingsGroup title={props.title}>
      <For each={RUN_KEYS}>
        {(key) => (
          <SettingsRow label={t(RUN_LABEL[key])} controlId={`${ids}-${key}`}>
            <Input
              id={`${ids}-${key}`}
              class="trust-number"
              size="sm"
              inputmode="decimal"
              value={shown(key, props.limits[key])}
              onValueChange={(text) => props.onChange({ ...props.limits, [key]: parsed(key, text) })}
            />
          </SettingsRow>
        )}
      </For>
    </SettingsGroup>
  );
}
