import type { DiscordChannelConfig, DiscordChannelSetting, DiscordTextChannel } from "@openbot/contracts/ipc";
import {
  Button,
  Item,
  ItemContent,
  ItemGroup,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  SwitchField,
  Text,
} from "@openbot/ui";
import { createEffect, createStore, For, Match, Switch as Pick, Show } from "solid-js";
import { useText } from "../../text";
import { DiscordMark } from "./brand-marks";
import { ReadFailedAlert, WizardDialog } from "./IntegrationLayout";
import { createUnsavedGuard, DiscardChangesDialog } from "./unsaved-changes";

/** Which agent answers in each Discord server and channel, read and saved through the host. */
export interface DiscordChannelsControl {
  /** The saved settings and the server's text channels. Rejects with the reason. */
  load: (workspaceId: string) => Promise<{ config: DiscordChannelConfig; channels: readonly DiscordTextChannel[] }>;
  /** Saves the settings and returns what the host stored. Rejects with the reason. */
  save: (workspaceId: string, config: DiscordChannelConfig) => Promise<DiscordChannelConfig>;
}

/** The empty value of an agent picker: the next default. */
/** The "default" choice. Not empty: the select treats an empty value as no choice and shows nothing. */
const DEFAULT = "default";

interface ChannelDraft {
  agentId: string;
  answerAll: boolean;
}

function draftOf(config: DiscordChannelConfig, channels: readonly DiscordTextChannel[]) {
  const settings = new Map(config.channels.map((channel) => [channel.channelId, channel]));
  const drafts: Record<string, ChannelDraft> = {};
  for (const channel of channels) {
    const setting = settings.get(channel.id);
    drafts[channel.id] = { agentId: setting?.agentId ?? DEFAULT, answerAll: setting?.answerAll ?? false };
  }
  return { serverAgentId: config.serverAgentId ?? DEFAULT, channels: drafts };
}

function configOf(draft: ReturnType<typeof draftOf>, kept: readonly DiscordChannelSetting[]): DiscordChannelConfig {
  const channels: DiscordChannelSetting[] = Object.entries(draft.channels)
    .filter(([, channel]) => channel.agentId !== DEFAULT || channel.answerAll)
    .map(([channelId, channel]) => ({
      channelId,
      agentId: channel.agentId === DEFAULT ? null : channel.agentId,
      answerAll: channel.answerAll,
    }));
  // A saved channel that Discord did not list now, such as one OpenBot cannot see, keeps its settings.
  for (const setting of kept) if (!(setting.channelId in draft.channels)) channels.push({ ...setting });
  return { serverAgentId: draft.serverAgentId === DEFAULT ? null : draft.serverAgentId, channels };
}

/**
 * Configures one Discord server: the agent that answers in it, and for each text channel its own
 * agent and whether OpenBot answers every message there. Save stores all of it at once; closing with
 * changes asks first.
 */
export function DiscordChannelsDialog(props: {
  /** The Discord server; the dialog is open while it is set. */
  connection: { workspaceId: string; workspaceName: string } | null;
  agents: readonly { id: string; name: string }[];
  control: DiscordChannelsControl;
  onClose: () => void;
}) {
  const { t, errorMessage } = useText();
  const [view, setView] = createStore<{
    status: "loading" | "ready" | "failed" | "saving";
    error: string;
    channels: DiscordTextChannel[];
    saved: DiscordChannelConfig;
    savedKey: string;
    draft: ReturnType<typeof draftOf>;
  }>({
    status: "loading",
    error: "",
    channels: [],
    saved: { serverAgentId: null, channels: [] },
    savedKey: "",
    draft: { serverAgentId: DEFAULT, channels: {} },
  });
  let reads = 0;
  const load = (workspaceId: string) => {
    const read = ++reads;
    setView((state) => {
      state.status = "loading";
      state.error = "";
    });
    void props.control.load(workspaceId).then(
      ({ config, channels }) => {
        if (read !== reads) return;
        const draft = draftOf(config, channels);
        setView((state) => {
          state.status = "ready";
          state.channels = channels.map((channel) => ({ ...channel }));
          state.saved = config;
          state.savedKey = JSON.stringify(draft);
          state.draft = draft;
        });
      },
      (error: unknown) => {
        if (read !== reads) return;
        setView((state) => {
          state.status = "failed";
          state.error = errorMessage(error, t("connector.discord.channelsLoadFailed"));
        });
      },
    );
  };
  createEffect(
    () => props.connection?.workspaceId,
    (workspaceId) => {
      reads += 1;
      if (workspaceId) load(workspaceId);
    },
  );
  const dirty = () => view.status === "ready" && JSON.stringify(view.draft) !== view.savedKey;
  const guard = createUnsavedGuard({ dirty });
  const close = () => guard.request(props.onClose);
  const save = (workspaceId: string) => {
    const config = configOf(view.draft, view.saved.channels);
    setView((state) => {
      state.status = "saving";
      state.error = "";
    });
    void props.control.save(workspaceId, config).then(
      (stored) => {
        const draft = draftOf(stored, view.channels);
        setView((state) => {
          state.status = "ready";
          state.saved = stored;
          state.savedKey = JSON.stringify(draft);
          state.draft = draft;
        });
        props.onClose();
      },
      (error: unknown) => {
        setView((state) => {
          state.status = "ready";
          state.error = errorMessage(error, t("connector.discord.channelsSaveFailed"));
        });
      },
    );
  };
  const agentName = (id: string, fallback: string) =>
    id === DEFAULT ? fallback : (props.agents.find((agent) => agent.id === id)?.name ?? fallback);
  const picker = (input: { label: string; value: string; fallback: string; onChange: (id: string) => void }) => (
    <Select<string>
      options={[DEFAULT, ...props.agents.map((agent) => agent.id)]}
      // A saved agent that is gone shows the default, as routing does.
      value={props.agents.some((agent) => agent.id === input.value) ? input.value : DEFAULT}
      disabled={view.status !== "ready"}
      onChange={(next) => {
        if (next !== null && next !== input.value) input.onChange(next);
      }}
      itemComponent={(item) => (
        <SelectItem item={item.item}>{agentName(item.item.rawValue, input.fallback)}</SelectItem>
      )}
    >
      <SelectTrigger size="sm" aria-label={input.label}>
        <SelectValue<string>>{(state) => agentName(state.selectedOption() ?? DEFAULT, input.fallback)}</SelectValue>
      </SelectTrigger>
      <SelectContent class="integration-select-content" />
    </Select>
  );
  return (
    <>
      <WizardDialog
        open={props.connection !== null}
        closeLabel={t("connector.discord.close")}
        onClose={close}
        logo={<DiscordMark />}
        link="connected"
        title={t("connector.discord.channelsTitle", { workspace: props.connection?.workspaceName ?? "" })}
        description={t("connector.discord.channelsDescription")}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Show when={props.connection}>
              {(connection) => (
                <Button
                  type="button"
                  loading={view.status === "saving"}
                  disabled={!dirty()}
                  onClick={() => save(connection().workspaceId)}
                >
                  {t("connector.discord.channelsSave")}
                </Button>
              )}
            </Show>
          </>
        }
      >
        <Pick
          fallback={
            <div class="slack-integration-stack">
              <Show when={view.error}>{(message) => <ReadFailedAlert message={message()} />}</Show>
              <Text as="span" variant="label-sm">
                {t("connector.discord.channelsServerAgent")}
              </Text>
              {picker({
                label: t("connector.discord.channelsServerAgent"),
                value: view.draft.serverAgentId,
                fallback: t("connector.discord.channelsOrchestratorDefault"),
                onChange: (id) =>
                  setView((state) => {
                    state.draft.serverAgentId = id;
                  }),
              })}
              <Text as="span" variant="label-sm">
                {t("connector.discord.channelsListTitle")}
              </Text>
              <Show
                when={view.channels.length > 0}
                fallback={
                  <Text variant="body-sm" tone="muted" role="status">
                    {t("connector.discord.channelsNone")}
                  </Text>
                }
              >
                <ItemGroup class="settings-modal-card">
                  <For each={view.channels}>
                    {(channel) => {
                      const current = () => view.draft.channels[channel.id] ?? { agentId: DEFAULT, answerAll: false };
                      return (
                        <Item class="settings-modal-row">
                          <ItemContent>
                            <ItemTitle>#{channel.name}</ItemTitle>
                            {picker({
                              label: t("connector.discord.channelsChannelAgent", { channel: channel.name }),
                              value: current().agentId,
                              fallback: t("connector.discord.channelsServerDefault"),
                              onChange: (id) =>
                                setView((state) => {
                                  const entry = state.draft.channels[channel.id];
                                  if (entry) entry.agentId = id;
                                }),
                            })}
                            <SwitchField
                              size="sm"
                              checked={current().answerAll}
                              disabled={view.status !== "ready"}
                              label={t("connector.discord.channelsAnswerAll")}
                              description={t("connector.discord.channelsAnswerAllDescription")}
                              onChange={(checked: boolean) =>
                                setView((state) => {
                                  const entry = state.draft.channels[channel.id];
                                  if (entry) entry.answerAll = checked;
                                })
                              }
                            />
                          </ItemContent>
                        </Item>
                      );
                    }}
                  </For>
                </ItemGroup>
              </Show>
            </div>
          }
        >
          <Match when={view.status === "loading"}>
            <div class="slack-waiting" aria-live="polite">
              <Spinner size="sm" />
              <Text variant="caption" tone="muted">
                {t("connector.discord.channelsLoading")}
              </Text>
            </div>
          </Match>
          <Match when={view.status === "failed"}>
            <ReadFailedAlert
              message={view.error}
              onRetry={() => {
                const workspaceId = props.connection?.workspaceId;
                if (workspaceId) load(workspaceId);
              }}
            />
          </Match>
        </Pick>
      </WizardDialog>
      <DiscardChangesDialog guard={guard} />
    </>
  );
}
