import {
  EVENT_CHECK_SECRET_LINK_PREFIX,
  type EventCheck,
  type EventCheckApi,
  type EventCheckEnvironmentStatus,
} from "@openbot/contracts/event-checks";
import { Button, Input, NativeSelect, SettingsGroup, SettingsRow } from "@openbot/ui";
import { createEffect, createStore, createUniqueId, For, onCleanup, Show } from "solid-js";
import { useText } from "../../text";

interface EnvironmentState {
  variables: EventCheckEnvironmentStatus[];
  /** The keys in Secrets that a variable can link, as `scope/NAME`. */
  secrets: string[];
  busy: boolean;
  error: string;
}

/** The Secrets key that a typed value links, or null for a value that is pasted. */
function typedLink(value: string | undefined): string | null {
  return value?.startsWith(EVENT_CHECK_SECRET_LINK_PREFIX) ? value.slice(EVENT_CHECK_SECRET_LINK_PREFIX.length) : null;
}

/**
 * The private variables of one check, as masked fields. The section only shows what was typed and
 * what was marked for removal: the owner keeps both and writes them when the person saves, so one
 * Save covers the check and its variables. The approval of a changed program is the one action that
 * happens here, because it is a separate decision.
 */
export function EventCheckEnvironmentSettings(props: {
  api: EventCheckApi;
  check: EventCheck;
  /** The text typed in each masked field, by variable name. Memory only, and never shown outside the field. */
  values: Record<string, string>;
  /** The variables that are marked for removal, by name. The removal happens when the owner saves. */
  removed: Record<string, boolean>;
  onValue(name: string, value: string): void;
  onRemove(name: string, remove: boolean): void;
  /** The name of the button that saves, so the notes say which button writes a typed value. */
  saveAction: string;
  /** True while the owner saves: the fields are off. */
  busy?: boolean | undefined;
  /** The approval is off, because the saved check differs from the one on screen. */
  approveBlocked?: boolean | undefined;
  /** The names that the template gives its variables, by variable name. A variable with none shows its name. */
  labels?: Record<string, string> | undefined;
  /** Called with the status of the variables each time it is read, so a sibling can follow it. */
  onStatus?(variables: EventCheckEnvironmentStatus[]): void;
  /** Called after the program was approved. The owner reads the check again. */
  changed(): Promise<void>;
}) {
  const { t, errorMessage } = useText();
  // Several checks can show this section at once, so the heading id is its own.
  const headingId = `event-check-environment-${createUniqueId()}`;
  const reasonId = `${headingId}-reason`;
  const noteId = (index: number) => `${headingId}-note-${index}`;
  const [state, setState] = createStore<EnvironmentState>({
    variables: [],
    secrets: [],
    busy: false,
    error: "",
  });
  // The Secrets list, read once for each api. A host without Secrets has no list, and the field stays.
  createEffect(
    () => props.api,
    (api) => {
      void api
        .secrets?.()
        .then((secrets) =>
          setState((draft) => {
            draft.secrets = secrets;
          }),
        )
        .catch(() => undefined);
    },
  );
  // `identity` ends with the check, the api or this section: an approval that outlives it is dropped.
  // `reads` ends a status read that a newer read has replaced.
  let identity = 0;
  let reads = 0;
  onCleanup(() => {
    identity++;
    reads++;
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
      setState((draft) => {
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
  async function approve() {
    const requested = identity,
      api = props.api,
      check = props.check;
    if (props.approveBlocked) return;
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
  const off = () => Boolean(props.busy) || state.busy;
  return (
    <>
      <SettingsGroup
        title={<span id={headingId}>{t("agentSettings.eventCheck.environment")}</span>}
        description={t("agentSettings.eventCheck.environmentHelp")}
      >
        <Show when={state.variables.some((variable) => variable.reapprove)}>
          <SettingsRow
            label={t("agentSettings.eventCheck.approveProgram")}
            description={
              <span role="alert">
                {t("agentSettings.eventCheck.reapproveHelp", { program: props.check.source.toolName })}
              </span>
            }
            help={
              props.approveBlocked ? (
                <span id={reasonId}>{t("agentSettings.eventCheck.environmentDisabled")}</span>
              ) : undefined
            }
          >
            <Button
              variant="outline"
              type="button"
              size="sm"
              aria-describedby={props.approveBlocked ? reasonId : undefined}
              disabled={off() || props.approveBlocked}
              onClick={() => void approve()}
            >
              {t("agentSettings.eventCheck.approveProgram")}
            </Button>
          </SettingsRow>
        </Show>
        <For each={state.variables} keyed={(variable) => variable.name}>
          {(variable, index) => {
            const removing = () => props.removed[variable().name] === true;
            const typed = () => (props.values[variable().name] ?? "") !== "";
            const linking = () => typedLink(props.values[variable().name]);
            const inputId = `${headingId}-${index()}`;
            return (
              <SettingsRow
                layout="stack"
                class="event-check-variable"
                controlId={inputId}
                label={
                  <>
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
                  </>
                }
                help={
                  <>
                    <Show when={!typed() && !removing() && variable().linkedSecret}>
                      {(secret) => <span>{t("agentSettings.eventCheck.linkedSecret", { secret: secret() })}</span>}
                    </Show>
                    <Show when={removing() || typed()}>
                      <span id={noteId(index())}>
                        {removing()
                          ? t("agentSettings.eventCheck.variableRemoving", { action: props.saveAction })
                          : linking()
                            ? t("agentSettings.eventCheck.linkPending", {
                                secret: linking() ?? "",
                                action: props.saveAction,
                              })
                            : t("agentSettings.eventCheck.variablePending", { action: props.saveAction })}
                      </span>
                    </Show>
                  </>
                }
              >
                <div class="event-check-variable-controls">
                  <Input
                    id={inputId}
                    type="password"
                    autocomplete="new-password"
                    value={linking() ? "" : (props.values[variable().name] ?? "")}
                    maxlength={8192}
                    placeholder={t("agentSettings.eventCheck.variablePlaceholder")}
                    aria-describedby={removing() || typed() ? noteId(index()) : undefined}
                    disabled={off() || removing()}
                    onInput={(event) => props.onValue(variable().name, event.currentTarget.value)}
                  />
                  <Show when={state.secrets.length > 0}>
                    <NativeSelect
                      size="sm"
                      aria-label={t("agentSettings.eventCheck.useSecret")}
                      value={linking() ?? (typed() || removing() ? "" : (variable().linkedSecret ?? ""))}
                      disabled={off() || removing()}
                      onChange={(event) =>
                        props.onValue(
                          variable().name,
                          event.currentTarget.value
                            ? `${EVENT_CHECK_SECRET_LINK_PREFIX}${event.currentTarget.value}`
                            : "",
                        )
                      }
                    >
                      <option value="">{t("agentSettings.eventCheck.useSecret")}</option>
                      <For each={state.secrets}>{(secret) => <option value={secret}>{secret}</option>}</For>
                      {/* A link to a key that Secrets no longer holds still shows, so the select reads true. */}
                      <Show when={variable().linkedSecret && !state.secrets.includes(variable().linkedSecret ?? "")}>
                        <option value={variable().linkedSecret}>{variable().linkedSecret}</option>
                      </Show>
                    </NativeSelect>
                  </Show>
                  <Button
                    variant="outline"
                    type="button"
                    size="sm"
                    class="event-check-variable-remove"
                    disabled={off() || (!removing() && !variable().configured && !variable().linkedSecret)}
                    onClick={() => props.onRemove(variable().name, !removing())}
                  >
                    {removing()
                      ? t("agentSettings.eventCheck.keepVariable")
                      : t("agentSettings.eventCheck.removeVariable")}
                  </Button>
                </div>
              </SettingsRow>
            );
          }}
        </For>
      </SettingsGroup>
      <Show when={state.error}>
        <p class="agent-settings-save-error" role="alert">
          {state.error}
        </p>
      </Show>
    </>
  );
}
