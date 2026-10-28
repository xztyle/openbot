import {
  CHANNEL_ANSWER_MODES,
  CHANNEL_FOCUS_LIMIT,
  type ChannelAnswerMode,
  type WorkspaceAgentChannelDefaults,
  type WorkspaceSettings,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text } from "@openbot/ui";
import { SettingsField, SettingsLinkGroup } from "@openbot/ui/components/SettingsPanel";
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
  };
  const agents = Object.fromEntries(Object.entries(settings.defaults.agents ?? {}).filter(([id]) => id !== agentId));
  return {
    ...settings,
    defaults: {
      ...settings.defaults,
      agents: entry.answerMode !== undefined || entry.focus !== undefined ? { ...agents, [agentId]: entry } : agents,
    },
  };
}

/**
 * The answer mode and the focus note that an agent takes when someone adds it to a channel. Each
 * change saves at once, as the other agent settings do: the mode when it is chosen, the focus when
 * the field loses focus or the agent changes. A save reads the settings again first and changes only
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

  async function save(agentId: string, api: AgentChannelDefaultsApi, change: WorkspaceAgentChannelDefaults) {
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

  return (
    <SettingsLinkGroup title={t("agentSettings.channels.title")}>
      <Text tone="muted">{t("agentSettings.channels.description")}</Text>
      <Show when={state.error}>
        {(message) => (
          <>
            <Text role="alert">{message()}</Text>
            <Show when={!state.saved}>
              <Button variant="ghost" onClick={() => reload?.()}>
                {t("common.retry")}
              </Button>
            </Show>
          </>
        )}
      </Show>
      <Show when={state.saved}>
        <SettingsField label={t("agentSettings.channels.answerMode")}>
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
        </SettingsField>
        <SettingsField label={t("agentSettings.channels.focus")}>
          <Input
            value={state.focus}
            maxlength={CHANNEL_FOCUS_LIMIT}
            placeholder={t("agentSettings.channels.focusPlaceholder")}
            disabled={state.busy}
            onValueChange={(value) =>
              setState((draft) => {
                draft.focus = value;
              })
            }
            onBlur={() => commitFocus()}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.isComposing) return;
              event.preventDefault();
              commitFocus();
            }}
          />
        </SettingsField>
      </Show>
    </SettingsLinkGroup>
  );
}
