import type { EventCheck, EventCheckApi, EventCheckEnvironmentStatus } from "@openbot/contracts/event-checks";
import { Button, Input } from "@openbot/ui";
import { createEffect, createStore, For, onCleanup, Show } from "solid-js";
import { useText } from "../../text";

interface EnvironmentState {
  variables: EventCheckEnvironmentStatus[];
  values: Record<string, string>;
  busy: boolean;
  error: string;
}

export function EventCheckEnvironmentSettings(props: {
  api: EventCheckApi;
  check: EventCheck;
  disabled?: boolean;
  changed(): Promise<void>;
}) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<EnvironmentState>({
    variables: [],
    values: {},
    busy: false,
    error: "",
  });
  let generation = 0;
  onCleanup(() => {
    generation++;
    setState((draft) => {
      draft.values = {};
    });
  });
  createEffect(
    () => [props.api, props.check.id, props.check.revision] as const,
    () => {
      const requested = ++generation;
      const api = props.api,
        check = props.check;
      setState((draft) => {
        draft.values = {};
        draft.error = "";
        draft.variables = [];
      });
      void api
        .environment?.({ agentId: check.agentId, id: check.id })
        .then((variables) => {
          if (requested === generation)
            setState((draft) => {
              draft.variables = variables;
            });
        })
        .catch((error) => {
          if (requested === generation)
            setState((draft) => {
              draft.error = errorMessage(error, t("agentSettings.eventCheck.failed"));
            });
        });
    },
  );
  async function write(name: string, remove: boolean) {
    const requested = generation,
      api = props.api,
      check = props.check;
    const value = remove ? null : (state.values[name] ?? "");
    if (props.disabled || (!remove && !value)) return;
    setState((draft) => {
      draft.values = {};
      draft.busy = true;
      draft.error = "";
    });
    try {
      const variables = await api.setEnvironment?.({ agentId: check.agentId, id: check.id, name, value });
      if (requested !== generation) return;
      if (variables)
        setState((draft) => {
          draft.variables = variables;
        });
      await props.changed();
    } catch (error) {
      if (requested === generation)
        setState((draft) => {
          draft.error = errorMessage(error, t("agentSettings.eventCheck.failed"));
        });
    } finally {
      if (requested === generation)
        setState((draft) => {
          draft.busy = false;
        });
    }
  }
  return (
    <section class="event-check-environment">
      <h3>{t("agentSettings.eventCheck.environment")}</h3>
      <p>{t("agentSettings.eventCheck.environmentHelp")}</p>
      <For each={state.variables}>
        {(variable) => (
          <div>
            <label>
              {variable.name} —{" "}
              {t(
                variable.configured
                  ? "agentSettings.eventCheck.variableSet"
                  : "agentSettings.eventCheck.variableMissing",
              )}
              <Input
                type="password"
                autocomplete="new-password"
                value={state.values[variable.name] ?? ""}
                maxlength={8192}
                placeholder={t("agentSettings.eventCheck.variablePlaceholder")}
                disabled={state.busy || props.disabled}
                onInput={(event) =>
                  setState((draft) => {
                    draft.values[variable.name] = event.currentTarget.value;
                  })
                }
              />
            </label>
            <Button
              disabled={state.busy || props.disabled || !state.values[variable.name]}
              onClick={() => void write(variable.name, false)}
            >
              {t("agentSettings.eventCheck.saveVariable")}
            </Button>
            <Button
              variant="ghost"
              disabled={state.busy || props.disabled || !variable.configured}
              onClick={() => void write(variable.name, true)}
            >
              {t("agentSettings.eventCheck.removeVariable")}
            </Button>
          </div>
        )}
      </For>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
    </section>
  );
}
