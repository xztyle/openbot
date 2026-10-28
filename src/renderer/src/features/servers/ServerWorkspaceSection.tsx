import {
  AGENT_REASONING_EFFORTS,
  type AgentReasoningEffort,
  type AgentStatus,
  CHANNEL_ANSWER_MODES,
  type ChannelAnswerMode,
  type ClientAgentModelOption,
  foreignProvider,
  isAgentProvider,
  isForeignProviderId,
  isReasoningEffort,
  type OpenBotDesktopApi,
  WORKSPACE_GATE_TIMEOUT_LIMITS,
  type WorkspaceSettings,
} from "@openbot/contracts/ipc";
import { FORK_HOST_CAPABILITY } from "@openbot/contracts/team-protocol/fork-host-v1";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  RefreshCw,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  SliderField,
  Text,
} from "@openbot/ui";
import { ProviderModelPicker } from "@openbot/ui/components/ProviderModelPicker";
import { createUnsavedGuard, DiscardChangesDialog } from "@openbot/ui/features/settings/unsaved-changes";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createEffect, createStore, Show, snapshot, untrack } from "solid-js";
import { serverCanAdminister } from "./server-capabilities";
import type { ServerSettingsSectionHost } from "./server-settings-section";

/** The workspace settings calls of one server's host. The desktop reaches them through main. */
export type WorkspaceSettingsCalls = Pick<
  OpenBotDesktopApi["hostAdmin"],
  "getWorkspaceSettings" | "setWorkspaceSettings"
>;

/** The models of the server's host, for the gate model picker. */
export interface WorkspaceGateCatalog {
  modelOptions: ClientAgentModelOption[];
  agentStatus: AgentStatus;
}

export interface ServerWorkspaceSettingsOptions {
  /** The calls of a client with no `window.openbot`, such as the web client. */
  calls?: WorkspaceSettingsCalls;
  /** The models of the connected host. Without it, the section reads the models of the dialog's server. */
  catalog?: () => WorkspaceGateCatalog;
}

const ANSWER_MODE_TEXT = {
  mention: { label: "workspace.answerMode.mention", hint: "workspace.answerMode.mentionHint" },
  always: { label: "workspace.answerMode.always", hint: "workspace.answerMode.alwaysHint" },
  "always-no-gate": { label: "workspace.answerMode.alwaysNoGate", hint: "workspace.answerMode.alwaysNoGateHint" },
  lead: { label: "workspace.answerMode.lead", hint: "workspace.answerMode.leadHint" },
} as const satisfies Record<ChannelAnswerMode, { label: AppTextKey; hint: AppTextKey }>;

const TIMEOUT_STEP_MS = 500;

interface WorkspaceSectionState {
  /** The settings as the host last confirmed them, or null before they load. */
  saved: WorkspaceSettings | null;
  /** The settings the user edits. Null before they load. */
  draft: WorkspaceSettings | null;
  loadError: string | null;
  /** The models read for this server, when the caller does not supply them. */
  catalog: WorkspaceGateCatalog | null;
  catalogError: string | null;
}

export interface ServerWorkspaceSection {
  /** True when this account manages the workspace settings of this server: the tab shows then. */
  available: () => boolean;
  dirty: () => boolean;
  saving: () => boolean;
  save(): Promise<void>;
  reset(): void;
  /** Runs `leave` at once, or after the user agrees to discard the changes that are not saved. */
  requestLeave(leave: () => void): void;
  Panel: () => JSX.Element;
  DiscardDialog: () => JSX.Element;
  resetForServer(): void;
}

function sameSettings(left: WorkspaceSettings, right: WorkspaceSettings): boolean {
  return (
    left.gate.provider === right.gate.provider &&
    left.gate.model === right.gate.model &&
    left.gate.effort === right.gate.effort &&
    left.gate.timeoutMs === right.gate.timeoutMs &&
    left.defaults.agentAnswerMode === right.defaults.agentAnswerMode
  );
}

/**
 * Server Settings > Workspace (`fork-host-v1`): the model of the answer gate, its time limit, and the
 * answer mode of an agent that joins a channel. Changes wait in a draft until the user saves them.
 * The host checks the role again.
 */
export function createServerWorkspaceSection(
  host: ServerSettingsSectionHost,
  visible: () => boolean,
): ServerWorkspaceSection {
  const { t, format, errorMessage } = useText();
  const { props, actionsAvailable, busy, run } = host;
  const calls = (): WorkspaceSettingsCalls => props.workspaceSettings?.calls ?? window.openbot.hostAdmin;
  const [state, setState] = createStore<WorkspaceSectionState>({
    saved: null,
    draft: null,
    loadError: null,
    catalog: null,
    catalogError: null,
  });
  /** Bumped for each read and each server, so an answer for an earlier one is dropped. */
  let generation = 0;

  const available = () =>
    Boolean(props.workspaceSettings) && actionsAvailable() && serverCanAdminister(props.server, FORK_HOST_CAPABILITY);
  const dirty = () => {
    const { saved, draft } = state;
    return Boolean(saved && draft && !sameSettings(saved, draft));
  };
  const saving = () => busy() === "workspace";
  const catalog = (): WorkspaceGateCatalog | null => props.workspaceSettings?.catalog?.() ?? state.catalog;

  function load(serverId: string): void {
    const current = ++generation;
    setState((draft) => {
      draft.loadError = null;
      draft.catalogError = null;
    });
    untrack(calls)
      .getWorkspaceSettings(serverId)
      .then(
        (settings) => {
          if (current !== generation) return;
          setState((draft) => {
            // A draft that holds changes stays: the user comes back to finish it.
            const keepDraft = draft.saved && draft.draft && !sameSettings(draft.saved, draft.draft);
            draft.saved = settings;
            if (!keepDraft) draft.draft = structuredClone(settings);
          });
        },
        (error: unknown) => {
          if (current !== generation) return;
          setState((draft) => {
            draft.loadError = errorMessage(error, t("server.settings.workspaceLoadFailed"));
          });
        },
      );
    if (untrack(() => props.workspaceSettings?.catalog)) return;
    Promise.all([window.openbot.agent.listModels(serverId), window.openbot.agent.getStatus(serverId)]).then(
      ([modelOptions, agentStatus]) => {
        if (current !== generation) return;
        setState((draft) => {
          draft.catalog = { modelOptions, agentStatus };
        });
      },
      (error: unknown) => {
        if (current !== generation) return;
        setState((draft) => {
          draft.catalogError = errorMessage(error, t("server.settings.workspaceModelsFailed"));
        });
      },
    );
  }

  // Read again each time the section shows, so the changes of another admin appear.
  createEffect(
    () => (props.open && visible() && available() ? props.server.id : null),
    (serverId) => {
      if (serverId) untrack(() => load(serverId));
    },
  );

  function reset(): void {
    setState((draft) => {
      draft.draft = draft.saved ? structuredClone(snapshot(draft.saved)) : null;
    });
  }

  const guard = createUnsavedGuard({ dirty, onDiscard: reset });

  async function save(): Promise<void> {
    const next = state.draft;
    if (!next || !dirty()) return;
    const serverId = props.server.id;
    const request = generation;
    const { gate, defaults } = structuredClone(snapshot(next));
    // Without `defaults.agents`, the host keeps the channel defaults of each agent as they are now, also
    // the ones that the agent settings changed after this section read them.
    const settings: WorkspaceSettings = { gate, defaults: { agentAnswerMode: defaults.agentAnswerMode } };
    await run("workspace", async () => {
      const result = await calls().setWorkspaceSettings(settings, serverId);
      if (request !== generation) return;
      setState((draft) => {
        draft.saved = result;
        draft.draft = structuredClone(result);
      });
    });
  }

  function resetForServer(): void {
    generation += 1;
    setState((draft) => {
      draft.saved = null;
      draft.draft = null;
      draft.loadError = null;
      draft.catalog = null;
      draft.catalogError = null;
    });
  }

  function updateGate(change: (gate: WorkspaceSettings["gate"]) => void): void {
    setState((draft) => {
      if (draft.draft) change(draft.draft.gate);
    });
  }

  function Panel() {
    return (
      <>
        <Show when={state.loadError}>
          {(message) => (
            <Alert tone="danger" role="alert">
              <AlertContent>
                <AlertDescription>{message()}</AlertDescription>
              </AlertContent>
              <AlertActions>
                <Button type="button" size="sm" variant="ghost" onClick={() => load(props.server.id)}>
                  <RefreshCw aria-hidden="true" />
                  {t("common.retry")}
                </Button>
              </AlertActions>
            </Alert>
          )}
        </Show>
        <Show when={state.draft}>
          {(settings) => (
            <>
              <SettingsSection
                title={t("server.settings.workspaceDefaults")}
                description={t("server.settings.workspaceDefaultsDescription")}
              >
                <ItemGroup class="settings-modal-card">
                  <AnswerModeRow
                    value={settings().defaults.agentAnswerMode}
                    disabled={Boolean(busy())}
                    menuMount={host.menuMount()}
                    onChange={(mode) =>
                      setState((draft) => {
                        if (draft.draft) draft.draft.defaults.agentAnswerMode = mode;
                      })
                    }
                  />
                </ItemGroup>
              </SettingsSection>
              <SettingsSection
                title={t("server.settings.workspaceGate")}
                description={t("server.settings.workspaceGateDescription")}
              >
                <ItemGroup class="settings-modal-card">
                  <GateModelRow
                    gate={settings().gate}
                    catalog={catalog()}
                    catalogError={state.catalogError}
                    disabled={Boolean(busy())}
                    onChange={(provider, model) =>
                      updateGate((gate) => {
                        gate.provider = provider;
                        gate.model = model;
                        // The effort belongs to the model: the host takes the lowest one of the new model.
                        delete gate.effort;
                      })
                    }
                    onEffortChange={(effort) =>
                      updateGate((gate) => {
                        gate.effort = effort;
                      })
                    }
                  />
                  <Item>
                    <ItemContent>
                      <SliderField
                        label={t("server.settings.workspaceGateTimeout")}
                        description={t("server.settings.workspaceGateTimeoutDescription")}
                        value={settings().gate.timeoutMs}
                        minValue={WORKSPACE_GATE_TIMEOUT_LIMITS.minimum}
                        maxValue={WORKSPACE_GATE_TIMEOUT_LIMITS.maximum}
                        step={TIMEOUT_STEP_MS}
                        disabled={Boolean(busy())}
                        formatValue={(value) =>
                          t("server.settings.workspaceGateSeconds", {
                            seconds: format.number(value / 1000, { maximumFractionDigits: 1 }),
                          })
                        }
                        onChange={(value) =>
                          updateGate((gate) => {
                            gate.timeoutMs = value;
                          })
                        }
                      />
                    </ItemContent>
                  </Item>
                </ItemGroup>
              </SettingsSection>
            </>
          )}
        </Show>
      </>
    );
  }

  return {
    available,
    dirty,
    saving,
    save,
    reset,
    requestLeave: (leave) => guard.request(leave),
    Panel,
    DiscardDialog: () => <DiscardChangesDialog guard={guard} />,
    resetForServer,
  };
}

function AnswerModeRow(props: {
  value: ChannelAnswerMode;
  disabled: boolean;
  menuMount: HTMLElement | undefined;
  onChange: (mode: ChannelAnswerMode) => void;
}) {
  const { t } = useText();
  return (
    <Item>
      <ItemContent>
        <ItemTitle id="server-settings-workspace-mode-label">{t("server.settings.workspaceDefaultMode")}</ItemTitle>
        <ItemDescription>{t(ANSWER_MODE_TEXT[props.value].hint)}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Select<ChannelAnswerMode>
          options={[...CHANNEL_ANSWER_MODES]}
          value={props.value}
          disabled={props.disabled}
          placement="bottom-end"
          sameWidth={false}
          onChange={(mode) => {
            if (mode && mode !== props.value) props.onChange(mode);
          }}
          itemComponent={(item) => (
            <SelectItem item={item.item}>
              <span class="server-workspace-mode-option">
                <span>{t(ANSWER_MODE_TEXT[item.item.rawValue].label)}</span>
                <Text as="span" variant="caption" tone="muted">
                  {t(ANSWER_MODE_TEXT[item.item.rawValue].hint)}
                </Text>
              </span>
            </SelectItem>
          )}
        >
          <SelectTrigger size="sm" aria-labelledby="server-settings-workspace-mode-label">
            <SelectValue<ChannelAnswerMode>>
              {(selected) => t(ANSWER_MODE_TEXT[selected.selectedOption() ?? props.value].label)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent mount={props.menuMount} />
        </Select>
      </ItemActions>
    </Item>
  );
}

/** The effort the host uses for a gate that names none, or none that the model takes: the lowest one. */
function gateEffort(
  gate: WorkspaceSettings["gate"],
  model: ClientAgentModelOption | undefined,
): AgentReasoningEffort | undefined {
  if (!model || model.reasoningEffortConfigurable === false || !model.supportedReasoningEfforts.length)
    return undefined;
  const efforts = model.supportedReasoningEfforts;
  if (isReasoningEffort(gate.effort) && efforts.includes(gate.effort)) return gate.effort;
  return AGENT_REASONING_EFFORTS.find((effort) => efforts.includes(effort)) ?? model.defaultReasoningEffort;
}

function GateModelRow(props: {
  gate: WorkspaceSettings["gate"];
  catalog: WorkspaceGateCatalog | null;
  catalogError: string | null;
  disabled: boolean;
  onChange: (provider: string, model: string) => void;
  onEffortChange: (effort: AgentReasoningEffort) => void;
}) {
  const { t } = useText();
  const selected = () =>
    props.catalog?.modelOptions.find(
      (option) => option.provider === props.gate.provider && option.id === props.gate.model,
    );
  return (
    <Item>
      <ItemContent>
        <ItemTitle>{t("server.settings.workspaceGateModel")}</ItemTitle>
        <ItemDescription class={props.catalogError ? "server-settings-item-error" : undefined}>
          {props.catalogError ?? t("server.settings.workspaceGateModelDescription")}
        </ItemDescription>
      </ItemContent>
      <Show when={props.catalog}>
        {(catalog) => (
          <ItemActions>
            <ProviderModelPicker
              variant="pill"
              ariaLabel={t("server.settings.workspaceGateModel")}
              provider={isAgentProvider(props.gate.provider) ? props.gate.provider : "claude"}
              foreignProvider={
                isForeignProviderId(props.gate.provider) ? foreignProvider(props.gate.provider) : undefined
              }
              value={props.gate.model}
              modelOptions={catalog().modelOptions}
              agentStatus={catalog().agentStatus}
              reasoningEffort={gateEffort(props.gate, selected())}
              onReasoningEffortChange={props.onEffortChange}
              disabled={props.disabled}
              onChange={(model, provider) => props.onChange(provider, model)}
            />
          </ItemActions>
        )}
      </Show>
    </Item>
  );
}
