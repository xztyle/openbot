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
  /**
   * Values the user typed earlier in this dialog, by variable name. They fill the fields once, when
   * the section opens. Nothing is saved until the user presses Save value.
   */
  prefill?: Record<string, string> | undefined;
  /** The names that the template gives its variables, by variable name. A variable with none shows its name. */
  labels?: Record<string, string> | undefined;
  /** Called with the status of the variables each time it is read or changed, so a sibling can follow it. */
  onStatus?(variables: EventCheckEnvironmentStatus[]): void;
  /** Called after a value or an approval was saved. The owner reads the check again. */
  changed(): Promise<void>;
}) {
  const { t, errorMessage } = useText();
  // Several checks can show this section at once, so the heading id is its own.
  const headingId = `event-check-environment-${createUniqueId()}`;
  const reasonId = `${headingId}-reason`;
  const [state, setState] = createStore<EnvironmentState>({
    variables: [],
    values: {},
    busy: false,
    error: "",
  });
  // `identity` ends with the check, the api or this section: a write that outlives it is dropped.
  // `reads` ends a status read that a newer read or a write has replaced. A new revision of the same
  // check changes neither the typed values nor the write that is running.
  let identity = 0;
  let reads = 0;
  let prefilled = false;
  onCleanup(() => {
    identity++;
    reads++;
    setState((draft) => {
      draft.values = {};
    });
  });
  // The owner passes a new `check` object after each read of its list, with the same id and revision.
  // That is not a new check: only a change of the api or the id starts the section over.
  let seenApi: EventCheckApi | undefined;
  let seenId: string | undefined;
  createEffect(
    () => [props.api, props.check.id] as const,
    ([api, checkId]) => {
      if (api === seenApi && checkId === seenId) return;
      seenApi = api;
      seenId = checkId;
      identity++;
      const typed = prefilled ? {} : { ...props.prefill };
      prefilled = true;
      setState((draft) => {
        draft.values = typed;
        draft.error = "";
        draft.variables = [];
        draft.busy = false;
      });
    },
  );
  let readApi: EventCheckApi | undefined;
  let readId: string | undefined;
  let readRevision: string | undefined;
  createEffect(
    () => [props.api, props.check.id, props.check.revision] as const,
    ([api, checkId, revision]) => {
      if (api === readApi && checkId === readId && revision === readRevision) return;
      readApi = api;
      readId = checkId;
      readRevision = revision;
      const requested = ++reads;
      const check = props.check;
      void api
        .environment?.({ agentId: check.agentId, id: checkId })
        .then((variables) => {
          if (requested !== reads) return;
          setState((draft) => {
            draft.variables = variables;
          });
          props.onStatus?.(variables);
        })
        .catch((error) => {
          if (requested === reads)
            setState((draft) => {
              draft.error = errorMessage(error, t("agentSettings.eventCheck.failed"));
            });
        });
    },
  );
  async function write(name: string, remove: boolean) {
    const requested = identity,
      api = props.api,
      check = props.check;
    const value = remove ? null : (state.values[name] ?? "");
    if (props.disabled || (!remove && !value)) return;
    setState((draft) => {
      // Only the value that is being saved leaves the field. The other fields keep what was typed.
      draft.values[name] = "";
      draft.busy = true;
      draft.error = "";
    });
    try {
      const variables = await api.setEnvironment?.({ agentId: check.agentId, id: check.id, name, value });
      if (requested !== identity) return;
      if (variables) {
        reads++;
        setState((draft) => {
          draft.variables = variables;
        });
        props.onStatus?.(variables);
      }
      await props.changed();
    } catch (error) {
      if (requested === identity)
        setState((draft) => {
          draft.error = errorMessage(error, t("agentSettings.eventCheck.failed"));
        });
    } finally {
      if (requested === identity)
        setState((draft) => {
          draft.busy = false;
        });
    }
  }
  async function approve() {
    const requested = identity,
      api = props.api,
      check = props.check;
    if (props.disabled) return;
    setState((draft) => {
      draft.busy = true;
      draft.error = "";
    });
    try {
      // Only this button asks the host to approve. The host ignores the request from an agent tool.
      await api.save({ ...check, approveProgram: true });
      if (requested !== identity) return;
      await props.changed();
    } catch (error) {
      if (requested === identity)
        setState((draft) => {
          draft.error = errorMessage(error, t("agentSettings.eventCheck.failed"));
        });
    } finally {
      if (requested === identity)
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
      <Show when={props.disabled}>
        <Text as="p" variant="caption" tone="muted" id={reasonId} class="event-check-help">
          {t("agentSettings.eventCheck.environmentDisabled")}
        </Text>
      </Show>
      <Show when={state.variables.some((variable) => variable.reapprove)}>
        <div class="event-check-variable">
          <Text as="p" variant="caption" tone="muted" class="event-check-help" role="alert">
            {t("agentSettings.eventCheck.reapproveHelp", { program: props.check.source.toolName })}
          </Text>
          <Button
            variant="secondary"
            type="button"
            size="sm"
            aria-describedby={props.disabled ? reasonId : undefined}
            disabled={state.busy || props.disabled}
            onClick={() => void approve()}
          >
            {t("agentSettings.eventCheck.approveProgram")}
          </Button>
        </div>
      </Show>
      <For each={state.variables} keyed={(variable) => variable.name}>
        {(variable) => (
          <div class="event-check-variable">
            <label class="settings-field">
              <span>
                <Show when={props.labels?.[variable().name]} fallback={<code>{variable().name}</code>}>
                  {(label) => label()}
                </Show>{" "}
                —{" "}
                <span class={variable().configured ? "event-check-variable-set" : "event-check-variable-missing"}>
                  {t(
                    variable().configured
                      ? "agentSettings.eventCheck.variableSet"
                      : "agentSettings.eventCheck.variableMissing",
                  )}
                </span>
              </span>
              <Input
                type="password"
                autocomplete="new-password"
                value={state.values[variable().name] ?? ""}
                maxlength={8192}
                placeholder={t("agentSettings.eventCheck.variablePlaceholder")}
                aria-describedby={props.disabled ? reasonId : undefined}
                disabled={state.busy || props.disabled}
                onInput={(event) =>
                  setState((draft) => {
                    draft.values[variable().name] = event.currentTarget.value;
                  })
                }
              />
            </label>
            <div class="event-check-variable-actions">
              <Button
                variant="ghost"
                type="button"
                size="sm"
                aria-describedby={props.disabled ? reasonId : undefined}
                disabled={state.busy || props.disabled || !variable().configured}
                onClick={() => void write(variable().name, true)}
              >
                {t("agentSettings.eventCheck.removeVariable")}
              </Button>
              <Button
                variant="secondary"
                type="button"
                size="sm"
                aria-describedby={props.disabled ? reasonId : undefined}
                disabled={state.busy || props.disabled || !state.values[variable().name]}
                onClick={() => void write(variable().name, false)}
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
