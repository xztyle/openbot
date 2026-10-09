import type { EventCheck, EventCheckApi, EventCheckEnvironmentStatus } from "@openbot/contracts/event-checks";
import { Button, Input, Text } from "@openbot/ui";
import { createEffect, createStore, createUniqueId, For, onCleanup, Show } from "solid-js";
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
  // Several checks can show this section at once, so the heading id is its own.
  const headingId = `event-check-environment-${createUniqueId()}`;
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
    <section class="event-check-section event-check-card" aria-labelledby={headingId}>
      <h4 id={headingId}>{t("agentSettings.eventCheck.environment")}</h4>
      <Text as="p" variant="caption" tone="muted" class="event-check-help">
        {t("agentSettings.eventCheck.environmentHelp")}
      </Text>
      <For each={state.variables}>
        {(variable) => (
          <div class="event-check-variable">
            <label class="settings-field">
              <span>
                <code>{variable.name}</code> —{" "}
                <span class={variable.configured ? "event-check-variable-set" : "event-check-variable-missing"}>
                  {t(
                    variable.configured
                      ? "agentSettings.eventCheck.variableSet"
                      : "agentSettings.eventCheck.variableMissing",
                  )}
                </span>
              </span>
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
            <div class="event-check-variable-actions">
              <Button
                variant="ghost"
                type="button"
                size="sm"
                disabled={state.busy || props.disabled || !variable.configured}
                onClick={() => void write(variable.name, true)}
              >
                {t("agentSettings.eventCheck.removeVariable")}
              </Button>
              <Button
                variant="secondary"
                type="button"
                size="sm"
                disabled={state.busy || props.disabled || !state.values[variable.name]}
                onClick={() => void write(variable.name, false)}
              >
                {t("agentSettings.eventCheck.saveVariable")}
              </Button>
            </div>
          </div>
        )}
      </For>
      <Show when={state.error}>
        <p class="agent-settings-save-error" role="alert">
          {state.error}
        </p>
      </Show>
    </section>
  );
}
