import {
  AGENT_REASONING_EFFORTS,
  type AgentReasoningEffort,
  type AgentStatus,
  CHANNEL_ANSWER_MODES,
  type ChannelAnswerMode,
  type ClientAgentModelOption,
  CONDENSE_WORD_THRESHOLDS,
  DEFAULT_WORKSPACE_APPEARANCE,
  DEFAULT_WORKSPACE_CONDENSE,
  DEFAULT_WORKSPACE_LEARNING,
  foreignProvider,
  isAgentProvider,
  isForeignProviderId,
  isReasoningEffort,
  MEMORY_REVIEW_INTERVALS,
  type MemoryReviewInterval,
  type OpenBotDesktopApi,
  SKILL_LEARNING_MODES,
  type SkillLearningMode,
  WORKSPACE_FACE_DEFAULTS,
  WORKSPACE_GATE_TIMEOUT_LIMITS,
  WORKSPACE_SKIN_DEFAULTS,
  WORKSPACE_THEMES,
  type WorkspaceAppearance,
  type WorkspaceCondenseSettings,
  type WorkspaceFaceDefault,
  type WorkspaceLearningSettings,
  type WorkspaceSettings,
  type WorkspaceTheme,
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
import { applyWorkspaceAppearance } from "../../atelier-theme";
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
/** The choices of the server's daily review limit. A value saved outside them shows as well. */
const DAILY_REVIEW_LIMITS = [10, 20, 40, 80, 200] as const;

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
    left.defaults.agentAnswerMode === right.defaults.agentAnswerMode &&
    sameLearning(left.learning ?? DEFAULT_WORKSPACE_LEARNING, right.learning ?? DEFAULT_WORKSPACE_LEARNING) &&
    sameAppearance(left.appearance ?? DEFAULT_WORKSPACE_APPEARANCE, right.appearance ?? DEFAULT_WORKSPACE_APPEARANCE) &&
    sameCondense(left.condense ?? DEFAULT_WORKSPACE_CONDENSE, right.condense ?? DEFAULT_WORKSPACE_CONDENSE)
  );
}

function sameCondense(left: WorkspaceCondenseSettings, right: WorkspaceCondenseSettings): boolean {
  return left.enabled === right.enabled && left.words === right.words;
}

function sameAppearance(left: WorkspaceAppearance, right: WorkspaceAppearance): boolean {
  return left.theme === right.theme && left.faces === right.faces && left.skin === right.skin;
}

const THEME_TEXT = {
  craft: "server.settings.themeCraft",
  modern: "server.settings.themeModern",
  riso: "server.settings.themeRiso",
} as const satisfies Record<WorkspaceTheme, AppTextKey>;

/** The name of each face family and of `mixed`. */
const FACE_FAMILY_TEXT = {
  portrait: "server.settings.facesPortrait",
  sketch: "server.settings.facesSketch",
  flat: "server.settings.facesFlat",
  clay: "server.settings.facesClay",
  character: "server.settings.facesCharacter",
  mixed: "server.settings.facesMixed",
} as const satisfies Record<WorkspaceFaceDefault, AppTextKey>;

function sameLearning(left: WorkspaceLearningSettings, right: WorkspaceLearningSettings): boolean {
  return (
    left.memoryReviewTurns === right.memoryReviewTurns &&
    left.skillLearning === right.skillLearning &&
    left.dailyReviewLimit === right.dailyReviewLimit
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
    const { gate, defaults, learning, appearance, condense } = structuredClone(snapshot(next));
    // Without `defaults.agents`, the host keeps the channel defaults of each agent as they are now, also
    // the ones that the agent settings changed after this section read them.
    const settings: WorkspaceSettings = {
      gate,
      defaults: { agentAnswerMode: defaults.agentAnswerMode },
      ...(learning ? { learning } : {}),
      ...(appearance ? { appearance } : {}),
      ...(condense ? { condense } : {}),
    };
    await run("workspace", async () => {
      const result = await calls().setWorkspaceSettings(settings, serverId);
      if (request !== generation) return;
      setState((draft) => {
        draft.saved = result;
        draft.draft = structuredClone(result);
      });
      // The look shows at once; other devices read it with their next DM list.
      if (result.appearance) applyWorkspaceAppearance(result.appearance);
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

  function updateLearning(change: (learning: WorkspaceLearningSettings) => void): void {
    setState((draft) => {
      if (!draft.draft) return;
      draft.draft.learning ??= { ...DEFAULT_WORKSPACE_LEARNING };
      change(draft.draft.learning);
    });
  }

  function updateCondense(change: (condense: WorkspaceCondenseSettings) => void): void {
    setState((draft) => {
      if (!draft.draft) return;
      draft.draft.condense ??= { ...DEFAULT_WORKSPACE_CONDENSE };
      change(draft.draft.condense);
    });
  }

  function updateAppearance(change: (appearance: WorkspaceAppearance) => void): void {
    setState((draft) => {
      if (!draft.draft) return;
      draft.draft.appearance ??= { ...DEFAULT_WORKSPACE_APPEARANCE };
      change(draft.draft.appearance);
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
                title={t("server.settings.appearance")}
                description={t("server.settings.appearanceDescription")}
              >
                <ItemGroup class="settings-modal-card">
                  <AppearanceRows
                    appearance={settings().appearance ?? DEFAULT_WORKSPACE_APPEARANCE}
                    disabled={Boolean(busy())}
                    menuMount={host.menuMount()}
                    onChange={updateAppearance}
                  />
                </ItemGroup>
              </SettingsSection>
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
              <SettingsSection
                title={t("server.settings.learning")}
                description={t("server.settings.learningDescription")}
              >
                <ItemGroup class="settings-modal-card">
                  <LearningRows
                    learning={settings().learning ?? DEFAULT_WORKSPACE_LEARNING}
                    disabled={Boolean(busy())}
                    menuMount={host.menuMount()}
                    onChange={updateLearning}
                  />
                </ItemGroup>
              </SettingsSection>
              <SettingsSection
                title={t("server.settings.agentReplies")}
                description={t("server.settings.agentRepliesDescription")}
              >
                <ItemGroup class="settings-modal-card">
                  <CondenseRows
                    condense={settings().condense ?? DEFAULT_WORKSPACE_CONDENSE}
                    disabled={Boolean(busy())}
                    menuMount={host.menuMount()}
                    onChange={updateCondense}
                  />
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

/** Server Settings > Workspace > Appearance: the theme, the face family and the skin tone of every member's view. */
function AppearanceRows(props: {
  appearance: WorkspaceAppearance;
  disabled: boolean;
  menuMount: HTMLElement | undefined;
  onChange: (change: (appearance: WorkspaceAppearance) => void) => void;
}) {
  const { t } = useText();
  return (
    <>
      <ChoiceRow
        id="server-settings-workspace-theme"
        title={t("server.settings.workspaceTheme")}
        hint={t("server.settings.workspaceThemeHint")}
        options={[...WORKSPACE_THEMES]}
        value={props.appearance.theme}
        label={(value) => {
          const theme = WORKSPACE_THEMES.find((candidate) => candidate === value);
          return theme ? t(THEME_TEXT[theme]) : value;
        }}
        disabled={props.disabled}
        menuMount={props.menuMount}
        onChange={(value) => {
          const theme = WORKSPACE_THEMES.find((candidate) => candidate === value);
          if (theme)
            props.onChange((appearance) => {
              appearance.theme = theme;
            });
        }}
      />
      <ChoiceRow
        id="server-settings-agent-faces"
        title={t("server.settings.agentFaces")}
        hint={t("server.settings.agentFacesHint")}
        options={[...WORKSPACE_FACE_DEFAULTS]}
        value={props.appearance.faces}
        label={(value) => {
          const family = WORKSPACE_FACE_DEFAULTS.find((candidate) => candidate === value);
          return family ? t(FACE_FAMILY_TEXT[family]) : value;
        }}
        disabled={props.disabled}
        menuMount={props.menuMount}
        onChange={(value) => {
          const family = WORKSPACE_FACE_DEFAULTS.find((candidate) => candidate === value);
          if (family)
            props.onChange((appearance) => {
              appearance.faces = family;
            });
        }}
      />
      <ChoiceRow
        id="server-settings-skin-tone"
        title={t("server.settings.skinTone")}
        hint={t("server.settings.skinToneHint")}
        options={[...WORKSPACE_SKIN_DEFAULTS]}
        value={props.appearance.skin}
        label={(value) =>
          value === "varied" ? t("server.settings.skinVaried") : t("server.settings.skinToneValue", { tone: value })
        }
        disabled={props.disabled}
        menuMount={props.menuMount}
        onChange={(value) => {
          const skin = WORKSPACE_SKIN_DEFAULTS.find((candidate) => candidate === value);
          if (skin)
            props.onChange((appearance) => {
              appearance.skin = skin;
            });
        }}
      />
    </>
  );
}

/** Server Settings > Workspace > Learning: the background memory review and skill learning of the agents. */
function LearningRows(props: {
  learning: WorkspaceLearningSettings;
  disabled: boolean;
  menuMount: HTMLElement | undefined;
  onChange: (change: (learning: WorkspaceLearningSettings) => void) => void;
}) {
  const { t, format } = useText();
  const reviewLabel = (turns: number) =>
    turns === 0 ? t("server.settings.memoryReviewOff") : t("server.settings.memoryReviewEvery", { turns });
  const limits = () =>
    [...new Set<number>([...DAILY_REVIEW_LIMITS, props.learning.dailyReviewLimit])].sort((a, b) => a - b);
  return (
    <>
      <ChoiceRow
        id="server-settings-memory-review"
        title={t("server.settings.memoryReview")}
        hint={t("server.settings.memoryReviewHint")}
        options={MEMORY_REVIEW_INTERVALS.map(String)}
        value={String(props.learning.memoryReviewTurns)}
        label={(value) => reviewLabel(Number(value))}
        disabled={props.disabled}
        menuMount={props.menuMount}
        onChange={(value) => {
          const turns = MEMORY_REVIEW_INTERVALS.find((interval) => String(interval) === value);
          if (turns !== undefined)
            props.onChange((learning) => {
              learning.memoryReviewTurns = turns satisfies MemoryReviewInterval;
            });
        }}
      />
      <ChoiceRow
        id="server-settings-skill-learning"
        title={t("server.settings.skillLearning")}
        hint={t("server.settings.skillLearningHint")}
        options={[...SKILL_LEARNING_MODES]}
        value={props.learning.skillLearning}
        label={(value) =>
          value === "automatic" ? t("server.settings.skillLearningAutomatic") : t("server.settings.skillLearningOff")
        }
        disabled={props.disabled || props.learning.memoryReviewTurns === 0}
        menuMount={props.menuMount}
        onChange={(value) => {
          const mode = SKILL_LEARNING_MODES.find((candidate) => candidate === value);
          if (mode)
            props.onChange((learning) => {
              learning.skillLearning = mode satisfies SkillLearningMode;
            });
        }}
      />
      <ChoiceRow
        id="server-settings-daily-reviews"
        title={t("server.settings.dailyReviewLimit")}
        hint={t("server.settings.dailyReviewLimitHint")}
        options={limits().map(String)}
        value={String(props.learning.dailyReviewLimit)}
        label={(value) => t("server.settings.dailyReviewLimitValue", { count: format.number(Number(value)) })}
        disabled={props.disabled || props.learning.memoryReviewTurns === 0}
        menuMount={props.menuMount}
        onChange={(value) => {
          const limit = Number(value);
          if (Number.isSafeInteger(limit) && limit > 0)
            props.onChange((learning) => {
              learning.dailyReviewLimit = limit;
            });
        }}
      />
    </>
  );
}

/** Server Settings > Workspace > Agent replies: the reply condenser and the length it starts at. */
function CondenseRows(props: {
  condense: WorkspaceCondenseSettings;
  disabled: boolean;
  menuMount: HTMLElement | undefined;
  onChange: (change: (condense: WorkspaceCondenseSettings) => void) => void;
}) {
  const { t, format } = useText();
  const thresholds = () =>
    [...new Set<number>([...CONDENSE_WORD_THRESHOLDS, props.condense.words])].sort((a, b) => a - b);
  return (
    <>
      <ChoiceRow
        id="server-settings-condense"
        title={t("server.settings.condenseReplies")}
        hint={t("server.settings.condenseRepliesHint")}
        options={["on", "off"]}
        value={props.condense.enabled ? "on" : "off"}
        label={(value) =>
          value === "on" ? t("server.settings.condenseRepliesOn") : t("server.settings.condenseRepliesOff")
        }
        disabled={props.disabled}
        menuMount={props.menuMount}
        onChange={(value) =>
          props.onChange((condense) => {
            condense.enabled = value === "on";
          })
        }
      />
      <ChoiceRow
        id="server-settings-condense-words"
        title={t("server.settings.condenseWords")}
        hint={t("server.settings.condenseWordsHint")}
        options={thresholds().map(String)}
        value={String(props.condense.words)}
        label={(value) => t("server.settings.condenseWordsValue", { count: format.number(Number(value)) })}
        disabled={props.disabled || !props.condense.enabled}
        menuMount={props.menuMount}
        onChange={(value) => {
          const words = Number(value);
          if (Number.isSafeInteger(words) && words > 0)
            props.onChange((condense) => {
              condense.words = words;
            });
        }}
      />
    </>
  );
}

function ChoiceRow(props: {
  id: string;
  title: string;
  hint: string;
  options: string[];
  value: string;
  label: (value: string) => string;
  disabled: boolean;
  menuMount: HTMLElement | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <Item>
      <ItemContent>
        <ItemTitle id={`${props.id}-label`}>{props.title}</ItemTitle>
        <ItemDescription>{props.hint}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Select<string>
          options={props.options}
          value={props.value}
          disabled={props.disabled}
          placement="bottom-end"
          sameWidth={false}
          onChange={(value) => {
            if (value && value !== props.value) props.onChange(value);
          }}
          itemComponent={(item) => <SelectItem item={item.item}>{props.label(item.item.rawValue)}</SelectItem>}
        >
          <SelectTrigger size="sm" aria-labelledby={`${props.id}-label`}>
            <SelectValue<string>>{(selected) => props.label(selected.selectedOption() ?? props.value)}</SelectValue>
          </SelectTrigger>
          <SelectContent mount={props.menuMount} />
        </Select>
      </ItemActions>
    </Item>
  );
}
