import type { EventCheckTemplate, EventCheckTemplateField } from "@openbot/contracts/event-check-templates";
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
  SwitchField,
  Text,
  Textarea,
  TriangleAlert,
  X,
} from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { useText } from "@openbot/ui/text";
import { createStore, createUniqueId, For, Show } from "solid-js";
import { EventCheckEnvironmentSettings } from "../conversation/EventCheckEnvironmentSettings";
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
}

/** The label of a setting. A setting that the install does not need says so. */
function FieldLabel(props: { field: EventCheckTemplateField }) {
  const { t } = useText();
  return (
    <>
      {props.field.label}
      <Show when={!props.field.required}>
        {" "}
        <span class="marketplace-install-optional">{t("marketplace.eventCheck.optional")}</span>
      </Show>
    </>
  );
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
  });
  const dialogId = createUniqueId();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const errors = () => installFormErrors(props.template, state.form);
  const agentName = (agentId: string) => props.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  const shown = () => state.touched;

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
  }

  async function retryFailed() {
    if (state.busy) return;
    const requests = installRequests(props.template, state.form, timezone);
    if (requests) await run(requests);
  }

  const Failures = () => (
    <Show when={state.failed.length > 0}>
      <Alert tone="danger" role="alert">
        <AlertIcon>
          <TriangleAlert />
        </AlertIcon>
        <AlertContent>
          <AlertTitle>{t("marketplace.eventCheck.dialog.failedTitle")}</AlertTitle>
          <For each={state.failed}>
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
    <Dialog.Root
      open={true}
      onOpenChange={(open) => {
        if (!open && !state.busy) props.onClose();
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
                onClick={props.onClose}
              >
                <X />
              </IconButton>
            </header>

            <Show
              when={state.step === "form"}
              fallback={
                <div class="marketplace-install-body">
                  <Failures />
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
                              check={props.catalog.check(created.agentId, created.id) ?? created}
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
                    <Button type="button" onClick={props.onClose}>
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
                    <Show
                      when={field.type === "boolean"}
                      fallback={
                        <Field
                          label={<FieldLabel field={field} />}
                          description={field.description}
                          required={field.required}
                          error={
                            shown() && errors().fields.includes(field.name)
                              ? t("marketplace.eventCheck.dialog.fieldRequired")
                              : undefined
                          }
                        >
                          <Show
                            when={isLongValue(field.value)}
                            fallback={
                              <Input
                                value={state.form.configuration[field.name] ?? ""}
                                maxlength={8192}
                                disabled={state.busy}
                                onValueChange={(value) =>
                                  setState((draft) => {
                                    draft.form.configuration[field.name] = value;
                                  })
                                }
                              />
                            }
                          >
                            <Textarea
                              value={state.form.configuration[field.name] ?? ""}
                              maxlength={8192}
                              disabled={state.busy}
                              onValueChange={(value) =>
                                setState((draft) => {
                                  draft.form.configuration[field.name] = value;
                                })
                              }
                            />
                          </Show>
                        </Field>
                      }
                    >
                      <SwitchField
                        class="marketplace-install-switch"
                        label={<FieldLabel field={field} />}
                        description={field.description}
                        checked={state.form.configuration[field.name] === "true"}
                        disabled={state.busy}
                        onChange={(on) =>
                          setState((draft) => {
                            draft.form.configuration[field.name] = on ? "true" : "false";
                          })
                        }
                      />
                    </Show>
                  )}
                </For>

                <Field
                  label={t("agentSettings.eventCheck.seconds")}
                  required
                  error={shown() && errors().interval ? t("marketplace.eventCheck.dialog.intervalInvalid") : undefined}
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
                  required
                  error={shown() && errors().instruction ? t("marketplace.eventCheck.dialog.fieldRequired") : undefined}
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

                <Failures />

                <footer class="marketplace-install-footer">
                  <Button type="button" variant="ghost" disabled={state.busy} onClick={props.onClose}>
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
  );
}
