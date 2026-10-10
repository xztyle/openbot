import type { EventCheckTemplate } from "@openbot/contracts/event-check-templates";
import type { EventCheck } from "@openbot/contracts/event-checks";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  Checkbox,
  Dialog,
  ExternalLink,
  Field,
  Heading,
  IconButton,
  Input,
  Text,
  Textarea,
  TriangleAlert,
  X,
} from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { useText } from "@openbot/ui/text";
import { createStore, createUniqueId, For, onCleanup, Show, snapshot } from "solid-js";
import { EventCheckEnvironmentSettings } from "../conversation/EventCheckEnvironmentSettings";
import { EventCheckSettingField } from "../conversation/EventCheckSettingField";
import {
  emptyVariableDraft,
  hasVariableChanges,
  type VariableDraft,
  variableChanges,
  writeVariables,
} from "../conversation/event-check-variables";
import { createUnsavedGuard, DiscardChangesDialog } from "../settings/unsaved-changes";
import {
  checkName,
  type InstallForm,
  initialInstallForm,
  installFormErrors,
  installRequests,
  MAX_ACTOR_IDS,
  MIN_INTERVAL_SECONDS,
  runInstalls,
} from "./marketplace-event-check-install";
import type { EventCheckCatalog } from "./marketplace-event-checks";
import type { MarketplaceAgent } from "./marketplace-model";

export interface EventCheckInstallDialogProps {
  template: EventCheckTemplate;
  /** The agents the check can go to. */
  agents: readonly MarketplaceAgent[];
  /** The agent that starts out chosen, when it is in `agents`. */
  activeAgentId: string;
  catalog: EventCheckCatalog;
  /** Opens a setup page of a private variable. Without it the dialog shows no link. */
  onOpenUrl?: ((url: string) => void) | undefined;
  /** Ask the browser to confirm when the tab closes with typed values. A web page sets it. */
  warnOnPageClose?: boolean | undefined;
  onClose: () => void;
}

interface FailedInstall {
  agentId: string;
  message: string;
}

interface DialogState {
  form: InstallForm;
  /** The user has pressed Install: the form now says what is missing. */
  touched: boolean;
  step: "form" | "variables";
  busy: boolean;
  created: EventCheck[];
  failed: FailedInstall[];
  /**
   * Private values typed here to load a list. Memory only: they leave this dialog in one discovery
   * call, and fill the fields of the next step. They are never part of an install request.
   */
  draft: Record<string, string>;
  /**
   * The private values of each created check, by check ID, and what is marked for removal. They are
   * written when the person presses Done. Memory only.
   */
  variables: Record<string, VariableDraft>;
  /** The values that Done could not write, by agent. The dialog stays open with what was typed. */
  valueFailures: FailedInstall[];
}

/** A value that is long, or has line breaks, is edited in a text area. */
function isLongValue(value: string): boolean {
  return value.includes("\n") || value.length > 120;
}

/**
 * Installs an event check template on one or more agents, then asks for its private variables. Each
 * agent gets its own paused check from one request. A private variable never goes in the request: it
 * is set afterwards in a masked field. A failure for one agent keeps the checks that were created.
 */
export function EventCheckInstallDialog(props: EventCheckInstallDialogProps) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<DialogState>({
    form: initialInstallForm(
      props.template,
      props.agents.some((agent) => agent.id === props.activeAgentId) ? [props.activeAgentId] : [],
    ),
    touched: false,
    step: "form",
    busy: false,
    created: [],
    failed: [],
    draft: {},
    variables: {},
    valueFailures: [],
  });
  onCleanup(() => {
    setState((draft) => {
      draft.draft = {};
      draft.variables = {};
    });
  });
  const initialForm = JSON.stringify(state.form);
  /** Whether the person typed anything that closing would lose. */
  const unsaved = () =>
    state.step === "form"
      ? JSON.stringify(state.form) !== initialForm || Object.values(state.draft).some((value) => value.trim() !== "")
      : Object.values(state.variables).some((draft) => hasVariableChanges(draft));
  const guard = createUnsavedGuard({ dirty: unsaved, warnOnPageClose: () => props.warnOnPageClose === true });
  const dialogId = createUniqueId();
  const firstPicker = () => props.template.configuration.find((field) => field.picker !== undefined)?.name;
  const canPick = () => props.catalog.canDiscover() && firstPicker() !== undefined;
  /** The label of the first private value that is still empty, or null when each one is typed. */
  const missingDraft = () =>
    props.template.variables.find((variable) => (state.draft[variable.name] ?? "").trim() === "")?.label ?? null;
  const pickerLoad = (fieldName: string) => () =>
    props.catalog.discover({
      slug: props.template.slug,
      field: fieldName,
      configuration: Object.fromEntries(
        props.template.configuration
          .filter((field) => field.picker === undefined)
          .map((field) => [field.name, state.form.configuration[field.name] ?? field.value]),
      ),
      variables: { ...state.draft },
    });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const errors = () => installFormErrors(props.template, state.form);
  const variableNames = () => props.template.variables.map((variable) => variable.name);
  const variableLabel = (name: string) =>
    props.template.variables.find((variable) => variable.name === name)?.label ?? name;
  /** The id of the first field with an error, in the order of the form. */
  const firstInvalidId = (): string | undefined => {
    const found = errors();
    if (found.agents) {
      const first = props.agents[0];
      return first ? `${dialogId}-agent-${first.id}` : undefined;
    }
    if (found.accountLabel) return `${dialogId}-account`;
    if (found.name) return `${dialogId}-name`;
    const field = props.template.configuration.find((entry) => found.fields.includes(entry.name));
    if (field) return `${dialogId}-config-${field.name}`;
    if (found.interval) return `${dialogId}-interval`;
    if (found.actorIds) return `${dialogId}-actors`;
    if (found.instruction) return `${dialogId}-instruction`;
    return undefined;
  };
  const agentName = (agentId: string) => props.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  const shown = () => state.touched;
  // The names of the private variables as the template words them, so no raw `NAME_IN_CAPS` is shown.
  const variableLabels = () =>
    Object.fromEntries(props.template.variables.map((variable) => [variable.name, variable.label]));

  function toggleAgent(agentId: string, on: boolean) {
    setState((draft) => {
      // The chosen agents keep the order of the list.
      draft.form.agentIds = props.agents
        .map((agent) => agent.id)
        .filter((id) => (id === agentId ? on : draft.form.agentIds.includes(id)));
    });
  }

  async function run(requests: NonNullable<ReturnType<typeof installRequests>>) {
    setState((draft) => {
      draft.busy = true;
      draft.failed = [];
    });
    const outcome = await runInstalls(requests, props.catalog.install);
    setState((draft) => {
      draft.busy = false;
      draft.created.push(...outcome.created);
      // The values typed to load a list fill the masked fields of each new check. They are written
      // only when the person presses Done.
      for (const created of outcome.created)
        draft.variables[created.id] = {
          values: Object.fromEntries(variableNames().map((name) => [name, state.draft[name] ?? ""])),
          removed: {},
        };
      draft.failed = outcome.failed.map((failure) => ({
        agentId: failure.agentId,
        message: errorMessage(failure.error, t("agentSettings.eventCheck.failed")),
      }));
      // With nothing created there is nothing to set up: the form stays, with what went wrong.
      if (draft.created.length > 0) draft.step = "variables";
      // A retry covers only the agents that failed.
      draft.form.agentIds = outcome.failed.map((failure) => failure.agentId);
    });
  }

  async function submit() {
    if (state.busy) return;
    setState((draft) => {
      draft.touched = true;
    });
    const requests = installRequests(props.template, state.form, timezone);
    if (requests) await run(requests);
    else queueMicrotask(() => document.getElementById(firstInvalidId() ?? "")?.focus());
  }

  /**
   * Done writes the typed values of each created check, then closes. A value that fails stays typed
   * and the dialog stays open, so nothing the person typed is dropped without a word.
   */
  async function finish() {
    if (state.busy) return;
    const api = props.catalog.checkApi();
    const work = state.created
      .map((created) => ({
        created,
        changes: variableChanges(snapshot(state.variables[created.id] ?? emptyVariableDraft()), variableNames()),
      }))
      .filter((entry) => entry.changes.length > 0);
    if (!api || work.length === 0) {
      props.onClose();
      return;
    }
    setState((draft) => {
      draft.busy = true;
      draft.valueFailures = [];
    });
    const failures: FailedInstall[] = [];
    for (const { created, changes } of work) {
      const outcome = await writeVariables(api, { agentId: created.agentId, id: created.id }, changes, (change) =>
        setState((draft) => {
          const target = draft.variables[created.id];
          if (target) {
            target.values[change.name] = "";
            target.removed[change.name] = false;
          }
        }),
      );
      if (outcome.failed)
        failures.push({
          agentId: created.agentId,
          message: t("agentSettings.eventCheck.variableFailed", {
            name: variableLabel(outcome.failed.name),
            reason: errorMessage(outcome.failed.error, t("agentSettings.eventCheck.failed")),
          }),
        });
      try {
        await props.catalog.refresh(created.agentId);
      } catch {
        // The values are written. The next read of the checks shows them.
      }
    }
    setState((draft) => {
      draft.busy = false;
      draft.valueFailures = failures;
    });
    if (failures.length === 0) props.onClose();
  }

  async function retryFailed() {
    if (state.busy) return;
    const requests = installRequests(props.template, state.form, timezone);
    if (requests) await run(requests);
  }

  const Failures = (list: { title: string; items: FailedInstall[] }) => (
    <Show when={list.items.length > 0}>
      <Alert tone="danger" role="alert">
        <AlertIcon>
          <TriangleAlert />
        </AlertIcon>
        <AlertContent>
          <AlertTitle>{list.title}</AlertTitle>
          <For each={list.items}>
            {(failure) => (
              <AlertDescription>
                {t("marketplace.eventCheck.dialog.failedFor", {
                  agent: agentName(failure.agentId),
                  reason: failure.message,
                })}
              </AlertDescription>
            )}
          </For>
        </AlertContent>
      </Alert>
    </Show>
  );

  return (
    <>
      <Dialog.Root
        open={true}
        onOpenChange={(open) => {
          if (!open && !state.busy) guard.request(props.onClose);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay class="marketplace-install-backdrop">
            <Dialog.Content class="marketplace-install-dialog" as="section">
              <header class="marketplace-install-header">
                <Dialog.Title class="marketplace-install-title">
                  {state.step === "form"
                    ? t("marketplace.eventCheck.dialog.title", { name: props.template.name })
                    : t("marketplace.eventCheck.dialog.done.title")}
                </Dialog.Title>
                <Dialog.Description class="marketplace-install-description">
                  {state.step === "form"
                    ? t("marketplace.eventCheck.dialog.description")
                    : props.template.variables.length > 0
                      ? t("marketplace.eventCheck.dialog.done.paused")
                      : t("marketplace.eventCheck.dialog.done.noVariables")}
                </Dialog.Description>
                <IconButton
                  class="marketplace-install-close"
                  label={t("common.close")}
                  variant="ghost"
                  disabled={state.busy}
                  onClick={() => guard.request(props.onClose)}
                >
                  <X />
                </IconButton>
              </header>

              <Show
                when={state.step === "form"}
                fallback={
                  <div class="marketplace-install-body">
                    <Failures title={t("marketplace.eventCheck.dialog.failedTitle")} items={state.failed} />
                    <Failures
                      title={t("marketplace.eventCheck.dialog.valuesFailedTitle")}
                      items={state.valueFailures}
                    />
                    <Show when={props.template.variables.length > 0}>
                      <ul class="marketplace-install-variables">
                        <For each={props.template.variables}>
                          {(variable) => (
                            <li>
                              <Text as="span" variant="body-sm">
                                {variable.label}
                              </Text>
                              <Show when={variable.hint}>
                                <Text as="span" variant="caption" tone="muted">
                                  {variable.hint}
                                </Text>
                              </Show>
                              <Show when={variable.docsUrl && props.onOpenUrl}>
                                <Button
                                  type="button"
                                  variant="link"
                                  aria-label={t("marketplace.eventCheck.need.docsNamed", { label: variable.label })}
                                  onClick={() => {
                                    if (variable.docsUrl) props.onOpenUrl?.(variable.docsUrl);
                                  }}
                                >
                                  {t("marketplace.eventCheck.need.docs")}
                                  <ExternalLink aria-hidden="true" />
                                </Button>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                    <For each={state.created}>
                      {(created) => (
                        <div class="marketplace-install-created">
                          <Heading as="h3" size="sm" class="marketplace-install-created-name">
                            {t("marketplace.eventCheck.dialog.done.check", {
                              agent: agentName(created.agentId),
                              name: created.name,
                            })}
                          </Heading>
                          <Show when={props.template.variables.length > 0 ? props.catalog.checkApi() : undefined}>
                            {(api) => (
                              <EventCheckEnvironmentSettings
                                api={api()}
                                labels={variableLabels()}
                                values={state.variables[created.id]?.values ?? {}}
                                removed={state.variables[created.id]?.removed ?? {}}
                                saveAction={t("marketplace.eventCheck.dialog.finish")}
                                busy={state.busy}
                                check={props.catalog.check(created.agentId, created.id) ?? created}
                                onValue={(name, value) =>
                                  setState((draft) => {
                                    const target = draft.variables[created.id];
                                    if (target) target.values[name] = value;
                                  })
                                }
                                onRemove={(name, remove) =>
                                  setState((draft) => {
                                    const target = draft.variables[created.id];
                                    if (!target) return;
                                    target.removed[name] = remove;
                                    if (remove) target.values[name] = "";
                                  })
                                }
                                changed={() => props.catalog.refresh(created.agentId)}
                              />
                            )}
                          </Show>
                        </div>
                      )}
                    </For>
                    <footer class="marketplace-install-footer">
                      <Show when={state.failed.length > 0}>
                        <Button type="button" variant="outline" loading={state.busy} onClick={() => void retryFailed()}>
                          {t("marketplace.eventCheck.dialog.retryFailed")}
                        </Button>
                      </Show>
                      <Button type="button" loading={state.busy} onClick={() => void finish()}>
                        {t("marketplace.eventCheck.dialog.finish")}
                      </Button>
                    </footer>
                  </div>
                }
              >
                <form
                  class="marketplace-install-body"
                  // A missing value is said under its field, in the field's words, not in a native bubble.
                  novalidate
                  aria-busy={state.busy ? "true" : undefined}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <fieldset class="marketplace-install-agents" disabled={state.busy}>
                    <legend class="ui-label">
                      {t("marketplace.eventCheck.dialog.agents")}
                      <span class="ui-field-required" aria-hidden="true">
                        *
                      </span>
                    </legend>
                    <Show
                      when={props.agents.length > 0}
                      fallback={
                        <Text as="p" variant="body-sm" tone="muted">
                          {t("marketplace.eventCheck.dialog.noAgents")}
                        </Text>
                      }
                    >
                      <For each={props.agents}>
                        {(agent) => (
                          <label class="marketplace-install-agent" for={`${dialogId}-agent-${agent.id}`}>
                            <Checkbox
                              id={`${dialogId}-agent-${agent.id}`}
                              checked={state.form.agentIds.includes(agent.id)}
                              onChange={(event) => toggleAgent(agent.id, event.currentTarget.checked)}
                            />
                            <span class="marketplace-avatar" data-size="xs">
                              <AgentAvatar agent={agent} motion="idle" />
                            </span>
                            <span>{agent.name}</span>
                          </label>
                        )}
                      </For>
                    </Show>
                    <Show when={shown() && errors().agents}>
                      <p class="ui-field-error" role="alert">
                        {t("marketplace.eventCheck.dialog.agentsRequired")}
                      </p>
                    </Show>
                  </fieldset>

                  <Field
                    label={t("marketplace.eventCheck.dialog.accountLabel")}
                    description={t("marketplace.eventCheck.dialog.accountLabelHelp")}
                    htmlFor={`${dialogId}-account`}
                    required
                    error={
                      shown() && errors().accountLabel ? t("marketplace.eventCheck.dialog.fieldRequired") : undefined
                    }
                  >
                    <Input
                      value={state.form.accountLabel}
                      maxlength={128}
                      placeholder={props.template.accountLabelHint}
                      disabled={state.busy}
                      onValueChange={(value) =>
                        setState((draft) => {
                          draft.form.accountLabel = value;
                        })
                      }
                    />
                  </Field>

                  <Field
                    label={t("agentSettings.eventCheck.name")}
                    htmlFor={`${dialogId}-name`}
                    required
                    error={shown() && errors().name ? t("marketplace.eventCheck.dialog.fieldRequired") : undefined}
                  >
                    <Input
                      value={checkName(props.template, state.form)}
                      maxlength={256}
                      disabled={state.busy}
                      onValueChange={(value) =>
                        setState((draft) => {
                          draft.form.name = value;
                        })
                      }
                    />
                  </Field>

                  <For each={props.template.configuration}>
                    {(field) => (
                      <>
                        <Show when={canPick() && field.name === firstPicker()}>
                          <fieldset class="marketplace-install-draft" disabled={state.busy}>
                            <legend class="ui-label">{t("marketplace.eventCheck.dialog.draftTitle")}</legend>
                            <Text as="small" variant="caption" tone="muted">
                              {t("marketplace.eventCheck.dialog.draftHelp")}
                            </Text>
                            <For each={props.template.variables}>
                              {(variable) => (
                                <Field label={variable.label}>
                                  <Input
                                    type="password"
                                    autocomplete="new-password"
                                    value={state.draft[variable.name] ?? ""}
                                    maxlength={8192}
                                    disabled={state.busy}
                                    onValueChange={(value) =>
                                      setState((draft) => {
                                        draft.draft[variable.name] = value;
                                      })
                                    }
                                  />
                                </Field>
                              )}
                            </For>
                          </fieldset>
                        </Show>
                        <EventCheckSettingField
                          name={field.name}
                          controlId={`${dialogId}-config-${field.name}`}
                          label={field.label}
                          description={field.description}
                          required={field.required}
                          type={field.type}
                          value={state.form.configuration[field.name] ?? ""}
                          labels={state.form.labels[field.name]}
                          disabled={state.busy}
                          multiline={isLongValue(field.value)}
                          picker={
                            field.picker !== undefined && canPick()
                              ? {
                                  picker: field.picker,
                                  load: pickerLoad(field.name),
                                  blocked: missingDraft()
                                    ? t("agentSettings.eventCheck.picker.needTyped", { name: missingDraft() ?? "" })
                                    : undefined,
                                }
                              : undefined
                          }
                          error={
                            shown() && errors().fields.includes(field.name)
                              ? t("marketplace.eventCheck.dialog.fieldRequired")
                              : undefined
                          }
                          onChange={(value, labels) =>
                            setState((draft) => {
                              draft.form.configuration[field.name] = value;
                              if (labels) draft.form.labels[field.name] = labels;
                            })
                          }
                        />
                      </>
                    )}
                  </For>

                  <Field
                    label={t("agentSettings.eventCheck.seconds")}
                    htmlFor={`${dialogId}-interval`}
                    required
                    error={
                      shown() && errors().interval ? t("marketplace.eventCheck.dialog.intervalInvalid") : undefined
                    }
                  >
                    <Input
                      type="number"
                      min={MIN_INTERVAL_SECONDS}
                      value={state.form.intervalSeconds}
                      disabled={state.busy}
                      onValueChange={(value) =>
                        setState((draft) => {
                          draft.form.intervalSeconds = value;
                        })
                      }
                    />
                  </Field>

                  <Field
                    label={t("marketplace.eventCheck.dialog.actorIds")}
                    description={t("marketplace.eventCheck.dialog.actorIdsHelp")}
                    htmlFor={`${dialogId}-actors`}
                    error={
                      shown() && errors().actorIds
                        ? t("marketplace.eventCheck.dialog.actorIdsTooMany", { max: MAX_ACTOR_IDS })
                        : undefined
                    }
                  >
                    <Textarea
                      value={state.form.actorIds}
                      spellcheck={false}
                      disabled={state.busy}
                      onValueChange={(value) =>
                        setState((draft) => {
                          draft.form.actorIds = value;
                        })
                      }
                    />
                  </Field>

                  <Field
                    label={t("agentSettings.eventCheck.instruction")}
                    htmlFor={`${dialogId}-instruction`}
                    required
                    error={
                      shown() && errors().instruction ? t("marketplace.eventCheck.dialog.fieldRequired") : undefined
                    }
                  >
                    <Textarea
                      value={state.form.instruction}
                      maxlength={16000}
                      disabled={state.busy}
                      onValueChange={(value) =>
                        setState((draft) => {
                          draft.form.instruction = value;
                        })
                      }
                    />
                  </Field>

                  <Failures title={t("marketplace.eventCheck.dialog.failedTitle")} items={state.failed} />

                  <footer class="marketplace-install-footer">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={state.busy}
                      onClick={() => guard.request(props.onClose)}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      type="submit"
                      loading={state.busy}
                      loadingLabel={t("marketplace.eventCheck.dialog.installing")}
                    >
                      {t("marketplace.eventCheck.dialog.submit", { count: state.form.agentIds.length })}
                    </Button>
                  </footer>
                </form>
              </Show>
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      </Dialog.Root>
      <DiscardChangesDialog
        guard={guard}
        description={state.step === "variables" ? t("marketplace.eventCheck.dialog.discardValues") : undefined}
      />
    </>
  );
}
