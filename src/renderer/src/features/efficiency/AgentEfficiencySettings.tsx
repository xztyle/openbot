import { AGENT_ROLE_LIMIT, type AgentModelPolicy, type PerformanceReview } from "@openbot/contracts/agent-efficiency";
import type { UpdateAgentInput } from "@openbot/contracts/ipc";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SwitchField,
  Text,
} from "@openbot/ui";
import { SettingsField, SettingsLinkGroup } from "@openbot/ui/components/SettingsPanel";
import type { AgentProfile } from "@openbot/ui/data";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore, onCleanup, Show } from "solid-js";
import { AgentLearningSettings } from "./AgentLearningSettings";
import type { EfficiencyCalls } from "./efficiency-port";
import { ReviewCard } from "./ReviewCard";

interface State {
  role: string;
  busy: boolean;
  error: string | null;
  review: PerformanceReview | null;
  reviewLoaded: boolean;
  reviewing: boolean;
  note: string | null;
}

/** The role in an agent name such as "PUO Abogados – Creativo de Anuncios", which the playbooks match. */
export function nameRole(name: string): string | null {
  const parts = name.split(/\s[–—-]\s/u);
  return parts.length > 1 ? (parts.at(-1)?.trim() ?? null) : null;
}

/**
 * The cost and performance settings of one agent: the model policy, the role for the playbooks, the
 * sleep switch and the newest weekly review with its proposal. The policy and the role save with the
 * agent; the sleep and the review use the host's efficiency routes, which an owner or admin has.
 */
export function AgentEfficiencySettings(props: {
  agent: AgentProfile;
  onUpdateAgent: (agentId: string, updates: Omit<UpdateAgentInput, "agentId">) => Promise<void>;
  calls?: EfficiencyCalls | undefined;
  /** The name of another agent, for the author of a settings change. */
  agentName?: ((agentId: string) => string) | undefined;
}) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<State>({
    role: "",
    busy: false,
    error: null,
    review: null,
    reviewLoaded: false,
    reviewing: false,
    note: null,
  });
  let generation = 0;
  onCleanup(() => {
    generation += 1;
  });

  createEffect(
    () => [props.agent.id, props.calls] as const,
    ([agentId, calls]) => {
      const current = ++generation;
      setState((draft) => {
        draft.role = props.agent.playbookRole ?? "";
        draft.review = null;
        draft.reviewLoaded = false;
        draft.error = null;
        draft.note = null;
      });
      if (!calls) return;
      calls.reviews({ agentId }).then(
        (page) => {
          if (generation !== current) return;
          setState((draft) => {
            draft.review = page.reviews[0] ?? null;
            draft.reviewLoaded = true;
          });
        },
        () => {
          if (generation === current)
            setState((draft) => {
              draft.reviewLoaded = true;
            });
        },
      );
    },
  );

  async function run(work: () => Promise<void>, fallback: string): Promise<void> {
    const agentId = props.agent.id;
    setState((draft) => {
      draft.busy = true;
      draft.error = null;
    });
    try {
      await work();
    } catch (error) {
      if (props.agent.id === agentId)
        setState((draft) => {
          draft.error = errorMessage(error, fallback);
        });
    } finally {
      setState((draft) => {
        draft.busy = false;
      });
    }
  }

  const policy = (): AgentModelPolicy => (props.agent.modelPolicy === "auto" ? "auto" : "fixed");
  const policyLabel = (value: AgentModelPolicy) =>
    value === "auto" ? t("efficiency.policy.auto") : t("efficiency.policy.fixed");

  function commitRole(): void {
    const next = state.role.trim();
    if (next === (props.agent.playbookRole ?? "")) return;
    void run(
      () => props.onUpdateAgent(props.agent.id, { playbookRole: next ? next : null }),
      t("agentSettings.saveFailed"),
    );
  }

  async function reviewNow(calls: EfficiencyCalls): Promise<void> {
    const agentId = props.agent.id;
    setState((draft) => {
      draft.reviewing = true;
      draft.note = null;
      draft.error = null;
    });
    try {
      const review = await calls.runReview(agentId);
      if (props.agent.id !== agentId) return;
      setState((draft) => {
        if (review) draft.review = review;
        else draft.note = t("efficiency.review.nothing");
      });
    } catch (error) {
      setState((draft) => {
        draft.error = errorMessage(error, t("efficiency.review.failed"));
      });
    } finally {
      setState((draft) => {
        draft.reviewing = false;
      });
    }
  }

  const suggestedRole = () => nameRole(props.agent.name);

  return (
    <SettingsLinkGroup class="efficiency-settings" title={t("efficiency.settings.title")}>
      <Show when={state.error}>{(message) => <Text role="alert">{message()}</Text>}</Show>
      <SettingsField label={t("efficiency.policy.label")}>
        <Select<AgentModelPolicy>
          options={["fixed", "auto"]}
          value={policy()}
          disabled={state.busy}
          onChange={(next) => {
            if (next === null || next === policy()) return;
            void run(() => props.onUpdateAgent(props.agent.id, { modelPolicy: next }), t("agentSettings.saveFailed"));
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
      </SettingsField>
      <Text tone="muted">{t("efficiency.policy.hint")}</Text>
      <SettingsField label={t("efficiency.role.label")}>
        <Input
          value={state.role}
          maxlength={AGENT_ROLE_LIMIT}
          placeholder={
            suggestedRole()
              ? t("efficiency.role.placeholder", { role: suggestedRole() ?? "" })
              : t("efficiency.role.placeholderNone")
          }
          disabled={state.busy}
          onValueChange={(value) =>
            setState((draft) => {
              draft.role = value;
            })
          }
          onBlur={() => commitRole()}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.isComposing) return;
            event.preventDefault();
            commitRole();
          }}
        />
      </SettingsField>
      <Text tone="muted">{t("efficiency.role.hint")}</Text>
      <Show when={props.calls}>
        {(calls) => (
          <>
            <SwitchField
              label={t("efficiency.sleep.label")}
              description={t("efficiency.sleep.hint")}
              checked={props.agent.sleepingSince !== undefined}
              disabled={state.busy}
              onChange={(sleeping) =>
                void run(async () => {
                  await calls().sleep({ kind: "agent", id: props.agent.id }, sleeping);
                }, t("efficiency.sleep.failed"))
              }
            />
            <SettingsField label={t("efficiency.review.title")}>
              <Show
                when={state.review}
                fallback={
                  <Show when={state.reviewLoaded}>
                    <Text tone="muted">{state.note ?? t("efficiency.review.none")}</Text>
                  </Show>
                }
              >
                {(review) => (
                  <ReviewCard
                    review={review()}
                    calls={calls()}
                    onDecided={(next) =>
                      setState((draft) => {
                        draft.review = next;
                      })
                    }
                  />
                )}
              </Show>
              <Button variant="ghost" disabled={state.reviewing} onClick={() => void reviewNow(calls())}>
                {state.reviewing ? t("efficiency.review.running") : t("efficiency.review.run")}
              </Button>
            </SettingsField>
            <AgentLearningSettings
              agentId={props.agent.id}
              calls={calls()}
              agentName={(agentId) => props.agentName?.(agentId) ?? agentId}
            />
          </>
        )}
      </Show>
    </SettingsLinkGroup>
  );
}
