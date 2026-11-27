import { AGENT_ROLE_LIMIT, type AgentModelPolicy, type PerformanceReview } from "@openbot/contracts/agent-efficiency";
import type { UpdateAgentInput } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  Switch,
  saveOnEnter,
  useSettingsDraft,
} from "@openbot/ui";
import type { AgentProfile } from "@openbot/ui/data";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, createStore, onCleanup, Show, untrack } from "solid-js";
import type { EfficiencyCalls } from "./efficiency-port";
import { ReviewCard } from "./ReviewCard";

type UpdateAgent = (agentId: string, updates: Omit<UpdateAgentInput, "agentId">) => Promise<void>;

/** The role in an agent name such as "PUO Abogados – Creativo de Anuncios", which the playbooks match. */
export function nameRole(name: string): string | null {
  const parts = name.split(/\s[–—-]\s/u);
  return parts.length > 1 ? (parts.at(-1)?.trim() ?? null) : null;
}

/** A failure under the row it belongs to. */
function RowError(props: { message: string | null }) {
  return (
    <Show when={props.message}>
      {(message) => (
        <span class="agent-settings-save-error" role="alert">
          {message()}
        </span>
      )}
    </Show>
  );
}

/**
 * The role for the playbooks, in the agent's Identity group. It is a text field: it saves with the
 * panel's save bar, and a role the host changes (a Roll back, another client) replaces it while the
 * person has not typed in it.
 */
export function AgentRoleRow(props: { agent: AgentProfile; onUpdateAgent: UpdateAgent }) {
  const { t } = useText();
  const [state, setState] = createStore({ role: "", dirty: false });
  const stored = () => props.agent.playbookRole ?? "";

  createEffect(
    () => [props.agent.id, stored()] as const,
    ([, role]) => {
      if (untrack(() => state.dirty)) return;
      setState((draft) => {
        draft.role = role;
      });
    },
  );
  // Another agent's settings never take this agent's unsaved role.
  createEffect(
    () => props.agent.id,
    () =>
      setState((draft) => {
        draft.role = untrack(stored);
        draft.dirty = false;
      }),
  );

  const drafts = useSettingsDraft({
    dirty: () => state.dirty && state.role.trim() !== stored(),
    async save() {
      const agentId = props.agent.id;
      const next = state.role.trim();
      await props.onUpdateAgent(agentId, { playbookRole: next ? next : null });
      if (props.agent.id === agentId && state.role.trim() === next)
        setState((draft) => {
          draft.dirty = false;
          draft.role = next;
        });
    },
    reset: () =>
      setState((draft) => {
        draft.role = stored();
        draft.dirty = false;
      }),
  });

  const suggestedRole = () => nameRole(props.agent.name);
  return (
    <SettingsRow
      layout="stack"
      controlId="agent-settings-role"
      label={t("efficiency.role.label")}
      description={t("efficiency.role.hint")}
    >
      <Input
        id="agent-settings-role"
        value={state.role}
        maxlength={AGENT_ROLE_LIMIT}
        placeholder={
          suggestedRole()
            ? t("efficiency.role.placeholder", { role: suggestedRole() ?? "" })
            : t("efficiency.role.placeholderNone")
        }
        onValueChange={(value) =>
          setState((draft) => {
            draft.role = value;
            draft.dirty = true;
          })
        }
        onKeyDown={saveOnEnter(drafts)}
      />
    </SettingsRow>
  );
}

/** Fixed or automatic model, in the agent's Model and cost group. It saves at once. */
export function AgentModelPolicyRow(props: { agent: AgentProfile; onUpdateAgent: UpdateAgent }) {
  const { t, errorMessage } = useText();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const policy = (): AgentModelPolicy => (props.agent.modelPolicy === "auto" ? "auto" : "fixed");
  const policyLabel = (value: AgentModelPolicy) =>
    value === "auto" ? t("efficiency.policy.auto") : t("efficiency.policy.fixed");

  async function change(next: AgentModelPolicy): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await props.onUpdateAgent(props.agent.id, { modelPolicy: next });
    } catch (failure) {
      setError(errorMessage(failure, t("agentSettings.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsRow
      label={t("efficiency.policy.label")}
      description={t("efficiency.policy.hint")}
      help={<RowError message={error()} />}
    >
      <Select<AgentModelPolicy>
        options={["fixed", "auto"]}
        value={policy()}
        disabled={busy()}
        onChange={(next) => {
          if (next === null || next === policy()) return;
          void change(next);
        }}
        itemComponent={(item) => <SelectItem item={item.item}>{policyLabel(item.item.rawValue)}</SelectItem>}
      >
        <SelectTrigger aria-label={t("efficiency.policy.label")}>
          <SelectValue<AgentModelPolicy>>
            {(selected) => policyLabel(selected.selectedOption() ?? policy())}
          </SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>
    </SettingsRow>
  );
}

/** The sleep switch, in the agent's Status group. It uses the host's efficiency route. */
export function AgentSleepRow(props: { agent: AgentProfile; calls: EfficiencyCalls }) {
  const { t, errorMessage } = useText();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function change(sleeping: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await props.calls.sleep({ kind: "agent", id: props.agent.id }, sleeping);
    } catch (failure) {
      setError(errorMessage(failure, t("efficiency.sleep.failed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsRow
      layout="inline"
      controlId="agent-settings-sleep"
      label={t("efficiency.sleep.label")}
      description={t("efficiency.sleep.hint")}
      help={<RowError message={error()} />}
    >
      <Switch
        id="agent-settings-sleep"
        aria-label={t("efficiency.sleep.label")}
        checked={props.agent.sleepingSince !== undefined}
        disabled={busy()}
        onChange={(sleeping) => void change(sleeping)}
      />
    </SettingsRow>
  );
}

const GRADE_TEXT = {
  great: "efficiency.review.grade.great",
  good: "efficiency.review.grade.good",
  watch: "efficiency.review.grade.watch",
  poor: "efficiency.review.grade.poor",
} as const satisfies Record<PerformanceReview["grade"], AppTextKey>;

interface ReviewState {
  review: PerformanceReview | null;
  loaded: boolean;
  running: boolean;
  note: string | null;
  error: string | null;
}

/**
 * The Performance section: the newest weekly review with its proposal, and Review now. It needs the
 * host's efficiency routes, which an owner or admin has.
 */
export function AgentReviewSection(props: { agentId: string; calls: EfficiencyCalls }) {
  const { t, format, errorMessage } = useText();
  const [state, setState] = createStore<ReviewState>({
    review: null,
    loaded: false,
    running: false,
    note: null,
    error: null,
  });
  let generation = 0;
  onCleanup(() => {
    generation += 1;
  });

  createEffect(
    () => [props.agentId, props.calls] as const,
    ([agentId, calls]) => {
      const current = ++generation;
      setState((draft) => {
        draft.review = null;
        draft.loaded = false;
        draft.note = null;
        draft.error = null;
      });
      calls.reviews({ agentId }).then(
        (page) => {
          if (generation !== current) return;
          setState((draft) => {
            draft.review = page.reviews[0] ?? null;
            draft.loaded = true;
          });
        },
        () => {
          if (generation === current)
            setState((draft) => {
              draft.loaded = true;
            });
        },
      );
    },
  );

  async function reviewNow(): Promise<void> {
    const agentId = props.agentId;
    setState((draft) => {
      draft.running = true;
      draft.note = null;
      draft.error = null;
    });
    try {
      const review = await props.calls.runReview(agentId);
      if (props.agentId !== agentId) return;
      setState((draft) => {
        if (review) draft.review = review;
        else draft.note = t("efficiency.review.nothing");
      });
    } catch (failure) {
      if (props.agentId !== agentId) return;
      setState((draft) => {
        draft.error = errorMessage(failure, t("efficiency.review.failed"));
      });
    } finally {
      setState((draft) => {
        draft.running = false;
      });
    }
  }

  const summary = () => {
    const review = state.review;
    if (review)
      return t("agentSettings.review.latest", {
        grade: t(GRADE_TEXT[review.grade]),
        date: format.date(Date.parse(review.createdAt), { dateStyle: "medium" }),
      });
    return state.loaded ? (state.note ?? t("efficiency.review.none")) : "";
  };

  return (
    <SettingsSection
      title={t("agentSettings.group.performance")}
      description={t("agentSettings.group.performanceDescription")}
    >
      <SettingsGroup label={t("agentSettings.group.performance")}>
        <SettingsRow
          label={t("efficiency.review.title")}
          description={summary()}
          help={<RowError message={state.error} />}
        >
          <Button variant="outline" size="sm" loading={state.running} onClick={() => void reviewNow()}>
            {state.running ? t("efficiency.review.running") : t("efficiency.review.run")}
          </Button>
        </SettingsRow>
        <Show when={state.review}>
          {(review) => (
            <div class="agent-settings-review">
              <ReviewCard
                review={review()}
                calls={props.calls}
                onDecided={(next) =>
                  setState((draft) => {
                    draft.review = next;
                  })
                }
              />
            </div>
          )}
        </Show>
      </SettingsGroup>
    </SettingsSection>
  );
}
