import type {
  AgentSessionSettingValue,
  ResetAgentSessionSettingInput,
  SetAgentSessionSettingInput,
  AgentSessionSettings as Settings,
} from "@openbot/contracts/ipc";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsGroup,
  SettingsRow,
  Switch,
} from "@openbot/ui";
import { createEffect, createStore, For, Show } from "solid-js";
import { useText } from "../../text";

export interface AgentSessionSettingsApi {
  read(agentId: string): Promise<Settings>;
  set(input: SetAgentSessionSettingInput): Promise<Settings>;
  reset(input: ResetAgentSessionSettingInput): Promise<Settings>;
  subscribe?(agentId: string, listener: () => void): () => void;
}

/** Saved choices and provider values stay separate, including choices a provider removed. */
export function AgentSessionSettings(props: {
  agentId: string;
  providerIdentity: string;
  api: AgentSessionSettingsApi;
}) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<{ data: Settings | null; busy: boolean; error: string | null }>({
    data: null,
    busy: false,
    error: null,
  });
  let generation = 0;
  let request = 0;
  let reload: (() => void) | undefined;
  createEffect(
    () => [props.agentId, props.providerIdentity, props.api] as const,
    ([agentId, , api]) => {
      const current = ++generation;
      setState(() => ({ data: null, busy: false, error: null }));
      const read = async () => {
        const latest = ++request;
        try {
          const data = await api.read(agentId);
          if (generation === current && request === latest)
            setState((s) => {
              s.data = data;
              s.error = null;
            });
        } catch (error) {
          if (generation === current && request === latest)
            setState((s) => {
              s.error = errorMessage(error, t("agentSettings.session.readFailed"));
            });
        }
      };
      reload = () => void read();
      void read();
      const stop = api.subscribe?.(agentId, () => void read());
      return () => {
        reload = undefined;
        generation++;
        stop?.();
      };
    },
  );
  async function change(settingId: string, value?: AgentSessionSettingValue) {
    if (state.busy) return;
    const current = generation;
    const latest = ++request;
    setState((s) => {
      s.busy = true;
      s.error = null;
    });
    try {
      const data =
        value === undefined
          ? await props.api.reset({ agentId: props.agentId, settingId })
          : await props.api.set({ agentId: props.agentId, settingId, value });
      if (generation === current && request === latest)
        setState((s) => {
          s.data = data;
        });
    } catch (error) {
      if (generation === current)
        setState((s) => {
          s.error = errorMessage(error, t("agentSettings.saveFailed"));
        });
    } finally {
      if (generation === current)
        setState((s) => {
          s.busy = false;
        });
    }
  }
  const ids = () => [
    ...new Set([
      ...(state.data?.options.map((option) => option.id) ?? []),
      ...Object.keys(state.data?.overrides ?? {}),
    ]),
  ];
  return (
    <Show when={ids().length > 0 || state.error}>
      <SettingsGroup
        title={t("agentSettings.session.title")}
        description={state.data?.pending ? t("agentSettings.session.pending") : undefined}
      >
        <Show when={state.error}>
          {(message) => (
            <SettingsRow
              label={t("agentSettings.session.title")}
              help={
                <span class="agent-settings-save-error" role="alert">
                  {message()}
                </span>
              }
            >
              <Button variant="outline" size="sm" onClick={() => reload?.()}>
                {t("common.retry")}
              </Button>
            </SettingsRow>
          )}
        </Show>
        <For each={ids()}>
          {(id) => {
            const option = () => state.data?.options.find((item) => item.id === id);
            const saved = () => state.data?.overrides[id];
            const value = () => saved() ?? option()?.currentValue;
            const choices = () => {
              const item = option();
              return item?.type === "select" ? item.options : [];
            };
            const label = (choice: string) => {
              const entry = choices().find((item) => item.value === choice);
              return entry ? [entry.group, entry.name].filter(Boolean).join(" · ") : choice;
            };
            const unavailable = () => {
              const item = option();
              return (
                !item ||
                (item.type === "select"
                  ? !choices().some((choice) => choice.value === value())
                  : typeof value() !== "boolean")
              );
            };
            return (
              <SettingsRow
                layout={option()?.type === "boolean" ? "inline" : undefined}
                label={option()?.name ?? id}
                description={option()?.description}
                help={
                  <>
                    <Show when={unavailable()}>
                      <span role="status">
                        {t("agentSettings.session.unavailable", { value: String(value() ?? "") })}
                      </span>
                    </Show>
                    <Show when={saved() !== undefined}>
                      <span class="agent-settings-session-effective">
                        {t("agentSettings.session.effective", { value: String(option()?.currentValue ?? "") })}
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t("agentSettings.session.resetNamed", { name: option()?.name ?? id })}
                          disabled={state.busy}
                          onClick={() => void change(id)}
                        >
                          {t("agentSettings.session.reset")}
                        </Button>
                      </span>
                    </Show>
                  </>
                }
              >
                <Show
                  when={option()?.type === "boolean"}
                  fallback={
                    <Select<string>
                      options={choices().map((item) => item.value)}
                      value={typeof value() === "string" ? String(value()) : null}
                      disabled={state.busy || !option()}
                      onChange={(next) => {
                        if (next !== null && next !== value()) void change(id, next);
                      }}
                      itemComponent={(item) => <SelectItem item={item.item}>{label(item.item.rawValue)}</SelectItem>}
                    >
                      <SelectTrigger aria-label={option()?.name ?? id}>
                        <SelectValue<string>>{() => label(String(value() ?? ""))}</SelectValue>
                      </SelectTrigger>
                      <SelectContent />
                    </Select>
                  }
                >
                  <Switch
                    aria-label={option()?.name ?? id}
                    checked={value() === true}
                    disabled={state.busy}
                    onChange={(next) => void change(id, next)}
                  />
                </Show>
              </SettingsRow>
            );
          }}
        </For>
      </SettingsGroup>
    </Show>
  );
}
