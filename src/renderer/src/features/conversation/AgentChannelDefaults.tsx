import {
  CHANNEL_ANSWER_MODES,
  CHANNEL_FOCUS_LIMIT,
  type ChannelAnswerMode,
  type WorkspaceAgentChannelDefaults,
  type WorkspaceSettings,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsRow,
  Switch,
  saveOnEnter,
  useSettingsDraft,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore, onCleanup, Show } from "solid-js";

/** The workspace settings of the server that runs the agent. The host answers only an owner or admin. */
export interface AgentChannelDefaultsApi {
  read(): Promise<WorkspaceSettings>;
  write(settings: WorkspaceSettings): Promise<WorkspaceSettings>;
}

/** The select value of an agent that follows the workspace default. */
const WORKSPACE_DEFAULT = "workspace-default";
type ModeChoice = ChannelAnswerMode | typeof WORKSPACE_DEFAULT;

const MODE_LABEL = {
  mention: "workspace.answerMode.mention",
  always: "workspace.answerMode.always",
  "always-no-gate": "workspace.answerMode.alwaysNoGate",
  lead: "workspace.answerMode.lead",
} as const satisfies Record<ChannelAnswerMode, AppTextKey>;

interface ChannelDefaultsState {
  /** The agent's saved defaults, or null before they load. */
  saved: WorkspaceAgentChannelDefaults | null;
  workspaceMode: ChannelAnswerMode;
  focus: string;
  busy: boolean;
  error: string | null;
}

/** The settings with `change` applied to the defaults of one agent. An agent with no default left has no entry. */
function withAgentDefaults(
  settings: WorkspaceSettings,
  agentId: string,
  change: WorkspaceAgentChannelDefaults,
): WorkspaceSettings {
  const next: WorkspaceAgentChannelDefaults = { ...settings.defaults.agents?.[agentId], ...change };
  const entry: WorkspaceAgentChannelDefaults = {
    ...(next.answerMode === undefined ? {} : { answerMode: next.answerMode }),
    ...(next.focus === undefined || !next.focus.trim() ? {} : { focus: next.focus.trim() }),
    ...(next.shareMainChat ? { shareMainChat: true } : {}),
  };
  const agents = Object.fromEntries(Object.entries(settings.defaults.agents ?? {}).filter(([id]) => id !== agentId));
  return {
    ...settings,
    defaults: {
      ...settings.defaults,
      agents: Object.keys(entry).length > 0 ? { ...agents, [agentId]: entry } : agents,
    },
  };
}

/**
 * The answer mode and the focus note that an agent takes when someone adds it to a channel, as rows
 * of the agent's "Where it works" group. The mode and the switch save at once; the focus is a text
 * field and saves with the panel's save bar, or when the agent changes. A save reads the settings again first and changes only
 * this agent, so it keeps what another admin saved since the panel read them.
 */
export function AgentChannelDefaults(props: { agentId: string; api: AgentChannelDefaultsApi }) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<ChannelDefaultsState>({
    saved: null,
    workspaceMode: "mention",
    focus: "",
    busy: false,
    error: null,
  });
  let generation = 0;
  let reload: (() => void) | undefined;
  /** The agent whose defaults the fields show, for a save that runs after the agent changed. */
  let shownAgentId = "";
  let shownApi: AgentChannelDefaultsApi | undefined;

  function applyRead(settings: WorkspaceSettings, agentId: string): void {
    const saved = settings.defaults.agents?.[agentId] ?? {};
    setState((draft) => {
      draft.saved = saved;
      draft.workspaceMode = settings.defaults.agentAnswerMode;
      draft.focus = saved.focus ?? "";
      draft.error = null;
    });
  }

  createEffect(
    () => [props.agentId, props.api] as const,
    ([agentId, api]) => {
      const current = ++generation;
      shownAgentId = agentId;
      shownApi = api;
      setState((draft) => {
        draft.saved = null;
        draft.focus = "";
        draft.busy = false;
        draft.error = null;
      });
      const read = () =>
        api.read().then(
          (settings) => {
            if (generation === current) applyRead(settings, agentId);
          },
          (error: unknown) => {
            if (generation === current)
              setState((draft) => {
                draft.error = errorMessage(error, t("agentSettings.channels.readFailed"));
              });
          },
        );
      reload = () => void read();
      void read();
      return () => {
        // The focus that the person typed for this agent is saved, as a name is when the agent changes.
        commitFocus(agentId, api);
        reload = undefined;
      };
    },
  );
  onCleanup(() => {
    generation += 1;
  });

  // Each save reads the settings and writes them whole. Two at once, such as the focus that an agent
  // change commits and a mode picked right after, would each write over the other: they run in turn.
  let saveTail: Promise<void> = Promise.resolve();
  function save(agentId: string, api: AgentChannelDefaultsApi, change: WorkspaceAgentChannelDefaults) {
    const run = saveTail.then(() => saveNow(agentId, api, change));
    saveTail = run;
    return run;
  }

  async function saveNow(agentId: string, api: AgentChannelDefaultsApi, change: WorkspaceAgentChannelDefaults) {
    const current = generation;
    const shown = () => generation === current && shownAgentId === agentId;
    if (shown())
      setState((draft) => {
        draft.busy = true;
        draft.error = null;
      });
    try {
      const latest = await api.read();
      const saved = await api.write(withAgentDefaults(latest, agentId, change));
      if (shown()) {
        const focus = state.focus;
        applyRead(saved, agentId);
        // A focus that the person changed again while the save ran stays in the field.
        if (change.focus === undefined)
          setState((draft) => {
            draft.focus = focus;
          });
      }
    } catch (error) {
      if (shown())
        setState((draft) => {
          draft.error = errorMessage(error, t("agentSettings.saveFailed"));
        });
    } finally {
      if (shown())
        setState((draft) => {
          draft.busy = false;
        });
    }
  }

  function commitFocus(agentId = shownAgentId, api = shownApi): void {
    const saved = state.saved;
    if (!saved || !api) return;
    const next = state.focus.trim();
    if (next === (saved.focus ?? "")) return;
    void save(agentId, api, { focus: next });
  }

  const modeChoice = (): ModeChoice => state.saved?.answerMode ?? WORKSPACE_DEFAULT;
  const modeLabel = (choice: ModeChoice) =>
    choice === WORKSPACE_DEFAULT
      ? t("agentSettings.channels.workspaceDefault", { mode: t(MODE_LABEL[state.workspaceMode]) })
      : t(MODE_LABEL[choice]);

  const drafts = useSettingsDraft({
    dirty: () => state.saved !== null && state.focus.trim() !== (state.saved.focus ?? ""),
    async save() {
      await save(props.agentId, props.api, { focus: state.focus.trim() });
      if (state.error) throw new Error(state.error);
    },
    reset: () =>
      setState((draft) => {
        draft.focus = draft.saved?.focus ?? "";
      }),
  });

  return (
    <>
      <Show when={state.error && !state.saved}>
        <SettingsRow
          label={t("agentSettings.channels.title")}
          help={
            <span class="agent-settings-save-error" role="alert">
              {state.error}
            </span>
          }
        >
          <Button variant="outline" size="sm" onClick={() => reload?.()}>
            {t("common.retry")}
          </Button>
        </SettingsRow>
      </Show>
      <Show when={state.saved}>
        <SettingsRow
          label={t("agentSettings.channels.answerMode")}
          description={t("agentSettings.channels.description")}
          help={
            <Show when={state.error}>
              <span class="agent-settings-save-error" role="alert">
                {state.error}
              </span>
            </Show>
          }
        >
          <Select<ModeChoice>
            options={[WORKSPACE_DEFAULT, ...CHANNEL_ANSWER_MODES]}
            value={modeChoice()}
            disabled={state.busy}
            onChange={(next) => {
              if (next === null || next === modeChoice()) return;
              void save(props.agentId, props.api, {
                answerMode: next === WORKSPACE_DEFAULT ? undefined : next,
              });
            }}
            itemComponent={(item) => <SelectItem item={item.item}>{modeLabel(item.item.rawValue)}</SelectItem>}
          >
            <SelectTrigger aria-label={t("agentSettings.channels.answerMode")}>
              <SelectValue<ModeChoice>>
                {(selected) => modeLabel(selected.selectedOption() ?? modeChoice())}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </SettingsRow>
        <SettingsRow
          layout="stack"
          controlId="agent-settings-channel-focus"
          label={t("agentSettings.channels.focus")}
          description={t("agentSettings.channels.focusDescription")}
        >
          <Input
            id="agent-settings-channel-focus"
            value={state.focus}
            maxlength={CHANNEL_FOCUS_LIMIT}
            placeholder={t("agentSettings.channels.focusPlaceholder")}
            onValueChange={(value) =>
              setState((draft) => {
                draft.focus = value;
              })
            }
            onKeyDown={saveOnEnter(drafts)}
          />
        </SettingsRow>
        <SettingsRow
          layout="inline"
          controlId="agent-settings-channels-sharemainchat"
          label={t("agentSettings.channels.shareMainChat")}
          description={t("agentSettings.channels.shareMainChatHint")}
        >
          <Switch
            id="agent-settings-channels-sharemainchat"
            aria-label={t("agentSettings.channels.shareMainChat")}
            checked={state.saved?.shareMainChat === true}
            disabled={state.busy}
            onChange={(shareMainChat) => void save(props.agentId, props.api, { shareMainChat })}
          />
        </SettingsRow>
      </Show>
    </>
  );
}
