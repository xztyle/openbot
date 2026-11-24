import type { AgentApprovalsView, ApprovalWeek } from "@openbot/contracts/agent-approvals";
import {
  OWNER_ONLY_TRUST_ACTIONS,
  TRUST_ACTIONS,
  TRUST_AUDIT_CATEGORIES,
  TRUST_AUDIT_OUTCOMES,
  TRUST_BUDGET_SCOPES,
  TRUST_ROLES,
  TRUST_RULES,
  type TrustAction,
  type TrustAuditCategory,
  type TrustAuditEntry,
  type TrustAuditOutcome,
  type TrustBudget,
  type TrustBudgetScope,
  type TrustPolicy,
  type TrustPolicyView,
  type TrustRule,
  trustAuditCsv,
} from "@openbot/contracts/trust-control";
import { Badge, Button, Input, NativeSelect, ShieldCheck, SwitchField, Text, Trash2, toast } from "@openbot/ui";
import { WorkspacePaneHeader } from "@openbot/ui/features/workspace/WorkspacePaneHeader";
import { zoneDay } from "@openbot/ui/features/workspace/workspace-format";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, flush, onSettled, Show } from "solid-js";
import { useWorkspace } from "../workspace/workspace-context";
import { TrustGuardrailsPanel } from "./TrustGuardrailsPanel";
import {
  downloadText,
  effectiveTrustRules,
  newBudget,
  samePolicy,
  TRUST_ACTION_LABEL,
  TRUST_RULE_LABEL,
  TRUST_SOURCE_LABEL,
  type TrustOverrideLevel,
  trustPlacement,
  withOverride,
  withoutOverride,
} from "./trust-draft";
import type { TrustCalls } from "./trust-port";

/** The agent whose rules the view opens with, such as from the org chart. */
const [focusAgent, setFocusAgent] = createSignal<string | null>(null);
export const openTrustForAgent = (agentId: string | null) => setFocusAgent(agentId);

const PASS_MINUTES = [0, 10, 30, 60, 120, 240];
const AUDIT_PAGE = 200;

type Tab = "rules" | "audit" | "guardrails";

/**
 * The Trust view of the workspace, for the owner and the admins: what each agent may do (rules by
 * role, space, team and agent), the budgets with today's spend, sandbox first, and the audit trail
 * with filters and a CSV export. The host enforces the rules; this view only edits them.
 */
export function WorkspaceTrustView() {
  const ws = useWorkspace();
  const { t, errorMessage } = useText();
  const calls = (): TrustCalls | undefined => ws.env.trust?.();
  const [tab, setTab] = createSignal<Tab>("rules");
  const [view, setView] = createSignal<TrustPolicyView | null>(null);
  const [draft, setDraft] = createSignal<TrustPolicy | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const dirty = () => !samePolicy(view()?.policy ?? null, draft());

  async function load() {
    const trust = calls();
    if (!trust) return;
    try {
      const next = await trust.policy();
      setView(next);
      setDraft(next.policy);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, t("trust.loadFailed")));
    }
  }
  onSettled(() => void load());
  const [weeks, setWeeks] = createSignal<Pick<AgentApprovalsView, "week" | "previousWeek"> | null>(null);
  onSettled(() => {
    void calls()
      ?.approvals()
      .then((view) => setWeeks({ week: view.week, previousWeek: view.previousWeek }))
      .catch(() => undefined);
  });

  async function save() {
    const trust = calls();
    const policy = draft();
    if (!trust || !policy) return;
    setSaving(true);
    try {
      const next = await trust.save(policy);
      setView(next);
      setDraft(next.policy);
      toast.success(t("trust.saved"));
    } catch (error) {
      toast.error(t("trust.saveFailed"), { error, fallback: t("trust.saveFailed") });
    } finally {
      setSaving(false);
    }
  }

  const change = (update: (policy: TrustPolicy) => TrustPolicy) => {
    const current = draft();
    if (current) setDraft(update(current));
  };

  const agents = createMemo(() => [...ws.env.agents()].sort((left, right) => left.name.localeCompare(right.name)));
  const agentName = (id: string) => agents().find((agent) => agent.id === id)?.name ?? id;
  const spaces = () => (ws.spaces.available() ? ws.spaces.list() : []);
  const spaceName = (id: string) => ws.spaces.space(id)?.name ?? id;
  const spaceOf = (agentId: string) => ws.spaces.agentSpace(agentId);
  const managers = createMemo(() => {
    const ids = new Set(agents().flatMap((agent) => (agent.reportsToAgentId ? [agent.reportsToAgentId] : [])));
    return agents().filter((agent) => ids.has(agent.id));
  });

  return (
    <section class="ws-view trust-view" aria-label={t("trust.title")}>
      <WorkspacePaneHeader
        icon={<ShieldCheck aria-hidden="true" />}
        title={t("trust.title")}
        subtitle={t("trust.subtitle")}
        onBack={() => ws.back()}
      />
      <div class="trust-tabs">
        <For each={["rules", "guardrails", "audit"] as const}>
          {(value) => (
            <Button
              type="button"
              size="sm"
              variant={tab() === value ? "secondary" : "ghost"}
              aria-pressed={tab() === value ? "true" : "false"}
              onClick={() => setTab(value)}
            >
              {value === "rules"
                ? t("trust.tab.rules")
                : value === "guardrails"
                  ? t("trust.tab.guardrails")
                  : t("trust.tab.audit")}
            </Button>
          )}
        </For>
      </div>
      <div class="ws-view-scroll trust-scroll">
        <Show when={!calls()}>
          <p class="ws-view-empty">{t("trust.unsupported")}</p>
        </Show>
        <Show when={calls() && tab() === "audit"}>
          <TrustAuditPanel
            calls={calls}
            agents={agents()}
            agentName={agentName}
            onOpenAgent={(agentId) => ws.openAgent(agentId)}
          />
        </Show>
        <Show when={calls() && tab() === "guardrails"}>
          <TrustGuardrailsPanel
            calls={() => calls()?.guardrails}
            name={(scope, id) => (scope === "agent" ? agentName(id) : spaceName(id))}
            onOpenAgent={(agentId) => ws.openAgent(agentId)}
          />
        </Show>
        <Show when={calls() && tab() === "rules"}>
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
          <Show when={draft()}>
            {(policy) => (
              <>
                <Show when={focusAgent()}>
                  {(agentId) => (
                    <TrustAgentCard
                      policy={policy()}
                      agentId={agentId()}
                      name={agentName(agentId())}
                      placement={trustPlacement(agents(), spaceOf, agentId())}
                      managerName={agentName}
                      onSet={(action, rule) =>
                        change((current) => withOverride(current, "agents", agentId(), action, rule))
                      }
                      onClose={() => setFocusAgent(null)}
                    />
                  )}
                </Show>
                <Show when={weeks()}>
                  {(value) => <TrustInterventions week={value().week} previousWeek={value().previousWeek} />}
                </Show>
                <section class="trust-section">
                  <SwitchField
                    size="default"
                    checked={policy().enabled}
                    onChange={(enabled) => change((current) => ({ ...current, enabled }))}
                    label={t("trust.enabled")}
                    description={t("trust.enabledDescription")}
                  />
                </section>
                <section class="trust-section" aria-labelledby="trust-roles-heading">
                  <h3 id="trust-roles-heading" class="trust-heading">
                    {t("trust.roles")}
                  </h3>
                  <p class="trust-muted">{t("trust.rolesDescription")}</p>
                  <div class="trust-grid">
                    <div class="trust-grid-row trust-grid-head">
                      <span>{t("trust.actionColumn")}</span>
                      <For each={TRUST_ROLES}>
                        {(role) => <span>{role === "lead" ? t("trust.role.lead") : t("trust.role.member")}</span>}
                      </For>
                      <span>{t("trust.approverColumn")}</span>
                    </div>
                    <For each={TRUST_ACTIONS}>
                      {(action) => (
                        <div class="trust-grid-row">
                          <span>{t(TRUST_ACTION_LABEL[action])}</span>
                          <For each={TRUST_ROLES}>
                            {(role) => (
                              <span>
                                <RuleSelect
                                  label={`${t(TRUST_ACTION_LABEL[action])} · ${role === "lead" ? t("trust.role.lead") : t("trust.role.member")}`}
                                  value={policy().roles[role][action]}
                                  onChange={(rule) =>
                                    rule &&
                                    change((current) => ({
                                      ...current,
                                      roles: { ...current.roles, [role]: { ...current.roles[role], [action]: rule } },
                                    }))
                                  }
                                />
                              </span>
                            )}
                          </For>
                          <span>
                            <NativeSelect
                              size="sm"
                              aria-label={`${t(TRUST_ACTION_LABEL[action])} · ${t("trust.approverColumn")}`}
                              value={policy().approvers[action]}
                              disabled={OWNER_ONLY_TRUST_ACTIONS.includes(action)}
                              onChange={(event) => {
                                const approver = event.currentTarget.value === "manager" ? "manager" : "owner";
                                change((current) => ({
                                  ...current,
                                  approvers: { ...current.approvers, [action]: approver },
                                }));
                              }}
                            >
                              <option value="owner">{t("trust.approver.owner")}</option>
                              <option value="manager">{t("trust.approver.manager")}</option>
                            </NativeSelect>
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                  <p class="trust-muted">{t("trust.approversDescription")}</p>
                </section>
                <section class="trust-section" aria-labelledby="trust-sandbox-heading">
                  <h3 id="trust-sandbox-heading" class="trust-heading">
                    {t("trust.sandbox")}
                  </h3>
                  <p class="trust-muted">{t("trust.sandboxDescription")}</p>
                  <SwitchField
                    checked={policy().sandbox.landings}
                    onChange={(value) =>
                      change((current) => ({ ...current, sandbox: { ...current.sandbox, landings: value } }))
                    }
                    label={t("trust.sandbox.landings")}
                  />
                  <SwitchField
                    checked={policy().sandbox.ads}
                    onChange={(value) =>
                      change((current) => ({ ...current, sandbox: { ...current.sandbox, ads: value } }))
                    }
                    label={t("trust.sandbox.ads")}
                  />
                  <SwitchField
                    checked={policy().sandbox.emails}
                    onChange={(value) =>
                      change((current) => ({ ...current, sandbox: { ...current.sandbox, emails: value } }))
                    }
                    label={t("trust.sandbox.emails")}
                  />
                  <label class="trust-inline">
                    <span>{t("trust.pass")}</span>
                    <NativeSelect
                      size="sm"
                      value={String(policy().approvalPassMinutes)}
                      onChange={(event) => {
                        const minutes = Number(event.currentTarget.value);
                        change((current) => ({ ...current, approvalPassMinutes: minutes }));
                      }}
                    >
                      <For each={PASS_MINUTES}>
                        {(minutes) => (
                          <option value={String(minutes)}>
                            {minutes === 0 ? t("trust.pass.none") : t("trust.pass.minutes", { count: minutes })}
                          </option>
                        )}
                      </For>
                    </NativeSelect>
                  </label>
                </section>
                <section class="trust-section" aria-labelledby="trust-budgets-heading">
                  <h3 id="trust-budgets-heading" class="trust-heading">
                    {t("trust.budgets")}
                  </h3>
                  <p class="trust-muted">{t("trust.budgetsDescription")}</p>
                  {/* Keyed by id: an edit replaces the budget, and its fields must keep focus while typing. */}
                  <For
                    each={policy().budgets}
                    keyed={(budget) => budget.id}
                    fallback={<p class="trust-muted">{t("trust.budgets.empty")}</p>}
                  >
                    {(budget, index) => (
                      <BudgetRow
                        budget={budget()}
                        spend={view()?.spend ?? []}
                        spaces={spaces()}
                        agents={agents()}
                        managers={managers()}
                        onChange={(next) =>
                          change((current) => ({
                            ...current,
                            budgets: current.budgets.map((entry, position) => (position === index() ? next : entry)),
                          }))
                        }
                        onRemove={() =>
                          change((current) => ({
                            ...current,
                            budgets: current.budgets.filter((_, position) => position !== index()),
                          }))
                        }
                      />
                    )}
                  </For>
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => change((current) => ({ ...current, budgets: [...current.budgets, newBudget()] }))}
                    >
                      {t("trust.budgets.add")}
                    </Button>
                  </div>
                </section>
                <OverridesSection
                  policy={policy()}
                  agents={agents()}
                  managers={managers()}
                  spaces={spaces()}
                  agentName={agentName}
                  spaceName={spaceName}
                  onChange={change}
                />
              </>
            )}
          </Show>
        </Show>
      </div>
      <Show when={tab() === "rules" && dirty()}>
        <section class="trust-save-bar" aria-label={t("trust.unsaved")}>
          <Text variant="caption" tone="muted">
            {t("trust.unsaved")}
          </Text>
          <div class="trust-save-actions">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving()}
              onClick={() => setDraft(view()?.policy ?? null)}
            >
              {t("server.settings.reset")}
            </Button>
            <Button
              type="button"
              size="sm"
              loading={saving()}
              loadingLabel={t("common.saving")}
              onClick={() => void save()}
            >
              {t("common.save")}
            </Button>
          </div>
        </section>
      </Show>
    </section>
  );
}

/** The owner's interventions this week and the share of decisions the agents took (docs/approvals.md). */
function TrustInterventions(props: { week: ApprovalWeek; previousWeek: ApprovalWeek }) {
  const { t } = useText();
  const total = () => props.week.owner + props.week.agents;
  return (
    <section class="trust-section" aria-labelledby="trust-interventions-heading">
      <h3 id="trust-interventions-heading" class="trust-heading">
        {t("trust.interventions.title")}
      </h3>
      <Show when={total() > 0} fallback={<p class="trust-muted">{t("trust.interventions.none")}</p>}>
        <p>{t("trust.interventions.week", { owner: String(props.week.owner), agents: String(props.week.agents) })}</p>
        <p class="trust-muted">
          {t("trust.interventions.share", { share: String(Math.round((props.week.agents / total()) * 100)) })}
        </p>
      </Show>
      <p class="trust-muted">
        {t("trust.interventions.previous", {
          owner: String(props.previousWeek.owner),
          agents: String(props.previousWeek.agents),
        })}
      </p>
    </section>
  );
}

function RuleSelect(props: {
  label: string;
  value: TrustRule | null;
  /** Shows an empty choice that clears an override, labeled with what applies without it. */
  inherit?: string | undefined;
  onChange: (rule: TrustRule | null) => void;
}) {
  const { t } = useText();
  return (
    <NativeSelect
      size="sm"
      aria-label={props.label}
      value={props.value ?? ""}
      data-rule={props.value ?? "inherit"}
      onChange={(event) => {
        const value = event.currentTarget.value;
        props.onChange(TRUST_RULES.find((rule) => rule === value) ?? null);
      }}
    >
      <Show when={props.inherit !== undefined}>
        <option value="">{props.inherit}</option>
      </Show>
      <For each={TRUST_RULES}>{(rule) => <option value={rule}>{t(TRUST_RULE_LABEL[rule])}</option>}</For>
    </NativeSelect>
  );
}

function TrustAgentCard(props: {
  policy: TrustPolicy;
  agentId: string;
  name: string;
  placement: ReturnType<typeof trustPlacement>;
  managerName: (id: string) => string;
  onSet: (action: TrustAction, rule: TrustRule | null) => void;
  onClose: () => void;
}) {
  const { t } = useText();
  const effective = () => effectiveTrustRules(props.policy, props.placement);
  return (
    <section class="trust-section trust-agent" aria-label={t("trust.agent.title", { name: props.name })}>
      <div class="trust-agent-header">
        <h3 class="trust-heading">{t("trust.agent.title", { name: props.name })}</h3>
        <Button type="button" size="sm" variant="ghost" onClick={() => props.onClose()}>
          {t("common.close")}
        </Button>
      </div>
      <p class="trust-muted">
        {props.placement.role === "lead" ? t("trust.role.lead") : t("trust.role.member")}
        <Show when={props.placement.managers[0]}>
          {(manager) => ` · ${t("trust.agent.reportsTo", { name: props.managerName(manager()) })}`}
        </Show>
      </p>
      <For each={TRUST_ACTIONS}>
        {(action) => (
          <div class="trust-grid-row">
            <span>{t(TRUST_ACTION_LABEL[action])}</span>
            <RuleSelect
              label={t(TRUST_ACTION_LABEL[action])}
              value={props.policy.agents[props.agentId]?.[action] ?? null}
              inherit={t("trust.inherit", {
                rule: t(TRUST_RULE_LABEL[effective()[action].rule]),
                source: t(TRUST_SOURCE_LABEL[effective()[action].source]),
              })}
              onChange={(rule) => props.onSet(action, rule)}
            />
          </div>
        )}
      </For>
    </section>
  );
}

/**
 * A field whose text is normalized into the draft: it shows what the person typed while that still
 * means the draft's value ("0." for 0, an empty platform for `*`), and the draft's value otherwise,
 * such as after Reset.
 */
function typedField(saved: () => string, normalize: (text: string) => string) {
  const [typed, setTyped] = createSignal<string | null>(null);
  return {
    value: () => {
      const text = typed();
      return text !== null && normalize(text) === saved() ? text : saved();
    },
    type: setTyped,
  };
}

function BudgetRow(props: {
  budget: TrustBudget;
  spend: TrustPolicyView["spend"];
  spaces: readonly { id: string; name: string }[];
  agents: readonly { id: string; name: string }[];
  managers: readonly { id: string; name: string }[];
  onChange: (budget: TrustBudget) => void;
  onRemove: () => void;
}) {
  const { t, format } = useText();
  const targets = () =>
    props.budget.scope === "space" ? props.spaces : props.budget.scope === "team" ? props.managers : props.agents;
  const spent = () => {
    const rows = props.spend.filter(
      (row) =>
        (props.budget.platform === "*" || row.platform === props.budget.platform) &&
        row.currency === props.budget.currency &&
        (props.budget.scope === "agent" ? row.agentId === props.budget.scopeId : row.agentId === undefined),
    );
    return {
      today: rows.reduce((sum, row) => sum + row.today, 0),
      total: rows.reduce((sum, row) => sum + row.total, 0),
    };
  };
  const amount = (value: string): number | undefined => {
    const number = Number(value.replace(",", "."));
    return value.trim() === "" || !Number.isFinite(number) || number < 0 ? undefined : number;
  };
  const amountText = (value: number | undefined) => (value === undefined ? "" : String(value));
  const platform = typedField(
    () => props.budget.platform,
    (value) => value.trim().toLowerCase() || "*",
  );
  const perDay = typedField(
    () => amountText(props.budget.perDay),
    (value) => amountText(amount(value)),
  );
  const total = typedField(
    () => amountText(props.budget.total),
    (value) => amountText(amount(value)),
  );
  const currency = typedField(
    () => props.budget.currency,
    (value) => value.trim().toUpperCase() || "USD",
  );
  const set = (patch: Partial<TrustBudget>) => {
    const next: TrustBudget = { ...props.budget, ...patch };
    if (next.perDay === undefined) delete next.perDay;
    if (next.total === undefined) delete next.total;
    if (next.scope === "all") delete next.scopeId;
    props.onChange(next);
  };
  const scopeLabel = (scope: TrustBudgetScope) =>
    scope === "all"
      ? t("trust.scope.all")
      : scope === "space"
        ? t("trust.scope.space")
        : scope === "team"
          ? t("trust.scope.team")
          : t("trust.scope.agent");
  return (
    <div class="trust-budget">
      <label class="trust-field">
        <span>{t("trust.budget.platform")}</span>
        <Input
          size="sm"
          value={platform.value()}
          placeholder={t("trust.budget.platformHint")}
          onValueChange={(value) => {
            platform.type(value);
            set({ platform: value.trim().toLowerCase() || "*" });
          }}
        />
      </label>
      <label class="trust-field">
        <span>{t("trust.budget.scope")}</span>
        <NativeSelect
          size="sm"
          value={props.budget.scope}
          onChange={(event) => {
            const scope = TRUST_BUDGET_SCOPES.find((value) => value === event.currentTarget.value) ?? "all";
            set({ scope, ...(scope === "all" ? {} : { scopeId: undefined }) });
          }}
        >
          <For each={TRUST_BUDGET_SCOPES}>{(scope) => <option value={scope}>{scopeLabel(scope)}</option>}</For>
        </NativeSelect>
      </label>
      <Show when={props.budget.scope !== "all"}>
        <label class="trust-field">
          <span>{scopeLabel(props.budget.scope)}</span>
          <NativeSelect
            size="sm"
            value={props.budget.scopeId ?? ""}
            onChange={(event) => set({ scopeId: event.currentTarget.value || undefined })}
          >
            <option value="">{t("trust.budget.pick")}</option>
            <For each={targets()}>{(target) => <option value={target.id}>{target.name}</option>}</For>
          </NativeSelect>
        </label>
      </Show>
      <label class="trust-field">
        <span>{t("trust.budget.perDay")}</span>
        <Input
          size="sm"
          inputmode="decimal"
          value={perDay.value()}
          onValueChange={(value) => {
            perDay.type(value);
            set({ perDay: amount(value) });
          }}
        />
      </label>
      <label class="trust-field">
        <span>{t("trust.budget.total")}</span>
        <Input
          size="sm"
          inputmode="decimal"
          value={total.value()}
          onValueChange={(value) => {
            total.type(value);
            set({ total: amount(value) });
          }}
        />
      </label>
      <label class="trust-field trust-field-short">
        <span>{t("trust.budget.currency")}</span>
        <Input
          size="sm"
          maxlength={3}
          value={currency.value()}
          onValueChange={(value) => {
            currency.type(value);
            set({ currency: value.trim().toUpperCase() || "USD" });
          }}
        />
      </label>
      <span class="trust-spent">
        {t("trust.budget.spent", {
          today: format.number(spent().today),
          total: format.number(spent().total),
          currency: props.budget.currency,
        })}
      </span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={t("trust.budget.remove")}
        onClick={() => props.onRemove()}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

function OverridesSection(props: {
  policy: TrustPolicy;
  agents: readonly { id: string; name: string }[];
  managers: readonly { id: string; name: string }[];
  spaces: readonly { id: string; name: string }[];
  agentName: (id: string) => string;
  spaceName: (id: string) => string;
  onChange: (update: (policy: TrustPolicy) => TrustPolicy) => void;
}) {
  const { t } = useText();
  const [level, setLevel] = createSignal<TrustOverrideLevel>("agents");
  const [target, setTarget] = createSignal("");
  const rows = createMemo(() =>
    (["agents", "teams", "spaces"] as const).flatMap((kind) =>
      Object.keys(props.policy[kind]).map((id) => ({ kind, id })),
    ),
  );
  const label = (kind: TrustOverrideLevel, id: string) =>
    kind === "agents"
      ? t("trust.override.agent", { name: props.agentName(id) })
      : kind === "teams"
        ? t("trust.override.team", { name: props.agentName(id) })
        : t("trust.override.space", { name: props.spaceName(id) });
  const targets = () => (level() === "agents" ? props.agents : level() === "teams" ? props.managers : props.spaces);
  return (
    <section class="trust-section" aria-labelledby="trust-overrides-heading">
      <h3 id="trust-overrides-heading" class="trust-heading">
        {t("trust.overrides")}
      </h3>
      <p class="trust-muted">{t("trust.overridesDescription")}</p>
      <For
        each={rows()}
        keyed={(row) => `${row.kind}:${row.id}`}
        fallback={<p class="trust-muted">{t("trust.overrides.empty")}</p>}
      >
        {(item) => {
          const row = item();
          return (
            <div class="trust-override">
              <div class="trust-agent-header">
                <strong>{label(row.kind, row.id)}</strong>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t("trust.override.remove")}
                  onClick={() => props.onChange((policy) => withoutOverride(policy, row.kind, row.id))}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              <div class="trust-override-rules">
                <For each={TRUST_ACTIONS}>
                  {(action) => (
                    <div class="trust-field">
                      <span>{t(TRUST_ACTION_LABEL[action])}</span>
                      <RuleSelect
                        label={t(TRUST_ACTION_LABEL[action])}
                        value={props.policy[row.kind][row.id]?.[action] ?? null}
                        inherit={t("trust.inheritShort")}
                        onChange={(rule) =>
                          props.onChange((policy) => withOverride(policy, row.kind, row.id, action, rule))
                        }
                      />
                    </div>
                  )}
                </For>
              </div>
            </div>
          );
        }}
      </For>
      <div class="trust-add">
        <NativeSelect
          size="sm"
          aria-label={t("trust.override.level")}
          value={level()}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setLevel(value === "teams" ? "teams" : value === "spaces" ? "spaces" : "agents");
            setTarget("");
          }}
        >
          <option value="agents">{t("trust.scope.agent")}</option>
          <option value="teams">{t("trust.scope.team")}</option>
          <option value="spaces">{t("trust.scope.space")}</option>
        </NativeSelect>
        <NativeSelect
          size="sm"
          aria-label={t("trust.budget.pick")}
          value={target()}
          onChange={(event) => setTarget(event.currentTarget.value)}
        >
          <option value="">{t("trust.budget.pick")}</option>
          <For each={targets()}>{(entry) => <option value={entry.id}>{entry.name}</option>}</For>
        </NativeSelect>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!target()}
          onClick={() => {
            const id = target();
            const kind = level();
            // A new override starts as the stricter "ask" for spending; the person adjusts it.
            props.onChange((policy) => withOverride(policy, kind, id, "pay", "ask"));
            setTarget("");
          }}
        >
          {t("trust.override.add")}
        </Button>
      </div>
    </section>
  );
}

const CATEGORY_LABEL = {
  spend: "trust.category.spend",
  publish: "trust.category.publish",
  send: "trust.category.send",
  delete: "trust.category.delete",
  create_agent: "trust.category.createAgent",
  policy: "trust.category.policy",
  approval: "trust.category.approval",
  decision: "trust.category.decision",
  secret: "trust.category.secret",
  sign_in: "trust.category.signIn",
} as const satisfies Record<TrustAuditCategory, string>;

const OUTCOME_LABEL = {
  allowed: "trust.outcome.allowed",
  approved: "trust.outcome.approved",
  declined: "trust.outcome.declined",
  refused: "trust.outcome.refused",
  answered: "trust.outcome.answered",
  timed_out: "trust.outcome.timedOut",
  changed: "trust.outcome.changed",
} as const satisfies Record<TrustAuditOutcome, string>;

const OUTCOME_TONE: Record<TrustAuditOutcome, "success-light" | "warning-light" | "destructive-light" | "secondary"> = {
  allowed: "secondary",
  approved: "success-light",
  declined: "destructive-light",
  refused: "destructive-light",
  answered: "secondary",
  timed_out: "warning-light",
  changed: "warning-light",
};

export function TrustAuditPanel(props: {
  calls: () => Pick<TrustCalls, "audit"> | undefined;
  agents: readonly { id: string; name: string }[];
  agentName: (id: string) => string;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t, format, errorMessage } = useText();
  const [category, setCategory] = createSignal<TrustAuditCategory | "">("");
  const [outcome, setOutcome] = createSignal<TrustAuditOutcome | "">("");
  const [agentId, setAgentId] = createSignal("");
  const [text, setText] = createSignal("");
  const [since, setSince] = createSignal("");
  const [entries, setEntries] = createSignal<TrustAuditEntry[] | null>(null);
  const [more, setMore] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const query = (before?: string) => ({
    limit: AUDIT_PAGE,
    ...(before ? { before } : {}),
    ...(category() ? { category: category() || undefined } : {}),
    ...(outcome() ? { outcome: outcome() || undefined } : {}),
    ...(agentId() ? { agentId: agentId() } : {}),
    ...(text().trim() ? { text: text().trim() } : {}),
    ...(since() ? { since: new Date(`${since()}T00:00:00`).toISOString() } : {}),
  });

  /*
   * Each new list counts one, and only its own answers show: a slow answer of the filter before, or
   * a "More" page of it, no longer replaces or joins the list of the filter that shows.
   */
  let run = 0;
  async function load(append = false) {
    const trust = props.calls();
    if (!trust) return;
    const mine = append ? run : ++run;
    setLoading(true);
    try {
      const before = append ? entries()?.at(-1)?.at : undefined;
      const page = await trust.audit(query(before));
      if (mine !== run) return;
      setEntries(append ? [...(entries() ?? []), ...page] : page);
      setMore(page.length === AUDIT_PAGE);
      setError(null);
    } catch (failure) {
      if (mine === run) setError(errorMessage(failure, t("trust.audit.loadFailed")));
    } finally {
      if (mine === run) setLoading(false);
    }
  }
  /** Shows a new filter and reads its list. The read sees it at once: a signal shows a write after its flush. */
  const filterBy = (change: () => void) => {
    flush(change);
    void load();
  };
  onSettled(() => void load());

  async function exportCsv() {
    const trust = props.calls();
    if (!trust) return;
    try {
      const rows = await trust.audit({ ...query(), limit: 2_000 });
      downloadText(`atelier-audit-${zoneDay(Date.now())}.csv`, trustAuditCsv(rows), "text/csv");
    } catch (failure) {
      toast.error(t("trust.audit.loadFailed"), { error: failure, fallback: t("trust.audit.loadFailed") });
    }
  }

  return (
    <section class="trust-section" aria-label={t("trust.tab.audit")}>
      <div class="trust-filters">
        <NativeSelect
          size="sm"
          aria-label={t("trust.audit.category")}
          value={category()}
          onChange={(event) => {
            const value = event.currentTarget.value;
            filterBy(() => setCategory(TRUST_AUDIT_CATEGORIES.find((item) => item === value) ?? ""));
          }}
        >
          <option value="">{t("trust.audit.allCategories")}</option>
          <For each={TRUST_AUDIT_CATEGORIES}>
            {(value) => <option value={value}>{t(CATEGORY_LABEL[value])}</option>}
          </For>
        </NativeSelect>
        <NativeSelect
          size="sm"
          aria-label={t("trust.audit.outcome")}
          value={outcome()}
          onChange={(event) => {
            const value = event.currentTarget.value;
            filterBy(() => setOutcome(TRUST_AUDIT_OUTCOMES.find((item) => item === value) ?? ""));
          }}
        >
          <option value="">{t("trust.audit.allOutcomes")}</option>
          <For each={TRUST_AUDIT_OUTCOMES}>{(value) => <option value={value}>{t(OUTCOME_LABEL[value])}</option>}</For>
        </NativeSelect>
        <NativeSelect
          size="sm"
          aria-label={t("trust.audit.agent")}
          value={agentId()}
          onChange={(event) => {
            const value = event.currentTarget.value;
            filterBy(() => setAgentId(value));
          }}
        >
          <option value="">{t("trust.audit.allAgents")}</option>
          <For each={props.agents}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
        </NativeSelect>
        <Input
          size="sm"
          type="date"
          aria-label={t("trust.audit.since")}
          value={since()}
          onValueChange={(value) => {
            filterBy(() => setSince(value));
          }}
        />
        <form
          class="trust-search"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <Input
            size="sm"
            type="search"
            aria-label={t("trust.audit.search")}
            placeholder={t("trust.audit.search")}
            value={text()}
            onValueChange={setText}
          />
        </form>
        <Button type="button" size="sm" variant="secondary" onClick={() => void exportCsv()}>
          {t("trust.audit.export")}
        </Button>
      </div>
      <Show when={error()}>
        {(message) => (
          <p class="trust-alert" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={entries()} fallback={<p class="trust-muted">{t("trust.audit.loading")}</p>}>
        {(list) => (
          <ul class="trust-audit">
            <For each={list()} fallback={<li class="trust-muted">{t("trust.audit.empty")}</li>}>
              {(entry) => (
                <li class="trust-audit-row">
                  <div class="trust-audit-meta">
                    <time datetime={entry.at}>
                      {format.date(new Date(entry.at), { dateStyle: "medium", timeStyle: "short" })}
                    </time>
                    <Badge variant="secondary">{t(CATEGORY_LABEL[entry.category])}</Badge>
                    <Badge variant={OUTCOME_TONE[entry.outcome]}>{t(OUTCOME_LABEL[entry.outcome])}</Badge>
                    <Show when={entry.amount !== undefined}>
                      <strong>
                        {entry.currency
                          ? format.currency(entry.amount ?? 0, entry.currency)
                          : format.number(entry.amount ?? 0)}
                      </strong>
                    </Show>
                    <Show when={entry.platform}>{(platform) => <span class="trust-muted">{platform()}</span>}</Show>
                  </div>
                  <div class="trust-audit-what">
                    <span class="trust-audit-who">
                      {entry.actor.kind === "agent"
                        ? (entry.actor.name ?? props.agentName(entry.actor.id ?? ""))
                        : (entry.actor.name ?? t("trust.audit.person"))}
                    </span>
                    <code class="trust-audit-action">{entry.action}</code>
                  </div>
                  <p class="trust-audit-summary">{entry.summary}</p>
                  <div class="trust-audit-links">
                    <Show when={entry.answeredBy}>
                      {(who) => <span class="trust-muted">{t("trust.audit.answeredBy", { name: who() })}</span>}
                    </Show>
                    <Show when={entry.ticket}>{(ticket) => <span class="trust-muted">#{ticket()}</span>}</Show>
                    <Show when={entry.agentId}>
                      {(id) => (
                        <Button type="button" size="sm" variant="ghost" onClick={() => props.onOpenAgent(id())}>
                          {t("trust.audit.openChat")}
                        </Button>
                      )}
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
      <Show when={more()}>
        <div>
          <Button type="button" size="sm" variant="secondary" loading={loading()} onClick={() => void load(true)}>
            {t("trust.audit.more")}
          </Button>
        </div>
      </Show>
    </section>
  );
}
