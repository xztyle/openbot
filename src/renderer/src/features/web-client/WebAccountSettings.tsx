import type { AppAppearance } from "@openbot/contracts/app-appearance";
import type { AppLanguage } from "@openbot/contracts/app-language";
import { type CentralAuthUser, WORKSPACE_AGENT_NOISE_LEVELS, type WorkspaceAgentNoise } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Archive,
  Bell,
  Button,
  CircleDollarSign,
  CreditCard,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  KeyRound,
  NativeSelect,
  Palette,
  SettingsSection,
  Sparkles,
  SwitchField,
  Tabs,
  UserRound,
} from "@openbot/ui";
import { AppearanceSelect } from "@openbot/ui/features/settings/AppearanceSelect";
import { LanguageSelect } from "@openbot/ui/features/settings/LanguageSelect";
import { SendShortcutSelect } from "@openbot/ui/features/settings/SendShortcutSelect";
import { SettingsDialogShell, type SettingsPagePlacement } from "@openbot/ui/features/settings/SettingsDialogShell";
import { SettingsProfileTab } from "@openbot/ui/features/settings/SettingsProfileTab";
import { SoundThemePicker } from "@openbot/ui/features/settings/SoundThemePicker";
import { createSettingsProfileStore } from "@openbot/ui/features/settings/stores/profile-store";
import { useText } from "@openbot/ui/text";
import { usesTouchLayout } from "@openbot/ui/utils";
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { readActionSoundChoice, replayActionSoundChoice, setActionSoundChoice } from "../../action-sounds";
import { setShowAgentSteps, useShowAgentSteps } from "../../agent-steps-preference";
import { isAttentionSoundEnabled, setAttentionSoundEnabled } from "../../attention-sound";
import {
  setShowAgentMessages,
  setShowAgentReasoning,
  useShowAgentMessages,
  useShowAgentReasoning,
} from "../../chat-visibility-preferences";
import { isCompletionSoundEnabled, setCompletionSoundEnabled } from "../../completion-sound";
import { webReportsEnabled } from "../../error-reports";
import { currentDevicePlatform, setSendShortcutMode, useSendShortcutMode } from "../../send-shortcut-preference";
import type { WebAccountCalls } from "./web-account";
import {
  WEB_ACCOUNT_SETTINGS_TABS as TABS,
  type WebAccountSettingsShortcut,
  type WebAccountSettingsTab,
} from "./web-account-settings-tabs";
import { setWebAnalyticsEnabled } from "./web-analytics";
import { isNotificationTextEnabled, setNotificationTextEnabled } from "./web-notification-text";
import type { WebPushAvailability, WebPushFailure } from "./web-push";

const SHORTCUTS = [
  { id: "agents", titleKey: "server.settings.group.agents", icon: Sparkles },
  { id: "money", titleKey: "server.settings.group.money", icon: CircleDollarSign },
  { id: "connections", titleKey: "server.settings.group.connections", icon: KeyRound },
  { id: "server", titleKey: "server.settings.group.server", icon: Archive },
] as const satisfies readonly { id: WebAccountSettingsShortcut; titleKey: AppTextKey; icon: typeof UserRound }[];

const TAB_ITEMS = {
  profile: {
    titleKey: "settings.tab.profile.title",
    descriptionKey: "settings.tab.profile.description",
    icon: UserRound,
  },
  appearance: {
    titleKey: "webClient.settings.appearance.title",
    descriptionKey: "webClient.settings.appearance.description",
    icon: Palette,
  },
  notifications: {
    titleKey: "webClient.settings.notifications.title",
    descriptionKey: "webClient.settings.notifications.description",
    icon: Bell,
  },
} as const satisfies Record<
  WebAccountSettingsTab,
  { titleKey: AppTextKey; descriptionKey: AppTextKey; icon: typeof UserRound }
>;

export interface AgentNoiseOptions {
  agents: readonly { id: string; name: string }[];
  level: (agentId: string) => WorkspaceAgentNoise;
  onChange: (agentId: string, level: WorkspaceAgentNoise) => void;
}

export interface WebAccountSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the settings page shows, or nothing while the page is not on screen. */
  page: SettingsPagePlacement | undefined;
  account: CentralAuthUser;
  calls: WebAccountCalls;
  language: AppLanguage;
  onChangeLanguage: (language: AppLanguage) => void;
  appearance: AppAppearance;
  onChangeAppearance: (appearance: AppAppearance) => void;
  /** Closes these settings and opens the plans and servers of the account. */
  onOpenBilling: () => void;
  onSignOut: () => Promise<void>;
  /** The tab to show, from the address. Profile shows when there is none. */
  section?: WebAccountSettingsTab | null;
  /** Called when the user picks another tab, so the address can name it. */
  onSectionChange?: (tab: WebAccountSettingsTab) => void;
  /** Opens a task that lives in the settings of the open server. Absent without one. */
  onOpenShortcut?: ((shortcut: WebAccountSettingsShortcut) => void) | undefined;
  /** Opens the quiet hours and focus of the open server, for its owner or an admin. */
  onOpenQuietHours?: (() => void) | undefined;
  /** How much each agent's updates push, on a host that keeps it (`agentNoise`). */
  agentNoise?: AgentNoiseOptions | undefined;
  /** Push notifications from the opened host. Absent in a build that has none. */
  push?: {
    availability: WebPushAvailability;
    hostName: string;
    enabled: boolean;
    busy: boolean;
    failure: WebPushFailure | null;
    onChange: (enabled: boolean) => void;
  };
}

/**
 * The account's own settings in the web client, where Settings opens the settings of a host. Profile
 * is the desktop tab and store; Preferences holds what this browser keeps. Sites are in the settings
 * of their server.
 */
export default function WebAccountSettings(props: WebAccountSettingsProps) {
  const [reportsEnabled, setReportsEnabled] = createSignal(webReportsEnabled());
  const { t } = useText();
  const [activeTab, setActiveTab] = createSignal<WebAccountSettingsTab>(untrack(() => props.section) ?? "profile");
  // An address that names another tab while the page shows moves to it.
  createEffect(
    () => props.section,
    (section) => {
      if (section) setActiveTab(section);
    },
  );
  const [completionSound, setCompletionSound] = createSignal(isCompletionSoundEnabled());
  const [attentionSound, setAttentionSound] = createSignal(isAttentionSoundEnabled());
  const [notificationText, setNotificationText] = createSignal(isNotificationTextEnabled());
  const sendShortcutMode = useSendShortcutMode();
  const showAgentSteps = useShowAgentSteps();
  const showAgentReasoning = useShowAgentReasoning();
  const showAgentMessages = useShowAgentMessages();
  // Playback reads the stored value on each event, so the switch follows a change from another tab.
  const [soundChoice, setSoundChoice] = createSignal(readActionSoundChoice());
  const readSoundSettings = () => {
    setCompletionSound(isCompletionSoundEnabled());
    setAttentionSound(isAttentionSoundEnabled());
    setNotificationText(isNotificationTextEnabled());
    setSoundChoice(readActionSoundChoice());
  };
  window.addEventListener("storage", readSoundSettings);
  onCleanup(() => window.removeEventListener("storage", readSoundSettings));
  let modalElement: HTMLElement | undefined;

  const profile = createSettingsProfileStore(
    {
      get open() {
        return props.open;
      },
      get account() {
        return props.account;
      },
      onUpdateAccountName: (name) => props.calls.updateName(name),
      onUpdateAccountAvatar: (image) => props.calls.updateAvatar(image),
      onListAccountSessions: () => props.calls.listSessions(),
      onRevokeAccountSession: (sessionId) => props.calls.revokeSession(sessionId),
    },
    () => activeTab() === "profile",
  );
  const navItem = () => TAB_ITEMS[activeTab()];

  return (
    <Tabs.Root
      value={activeTab()}
      onChange={(value: string) => {
        const tab = TABS.find((candidate) => candidate === value);
        if (!tab) return;
        setActiveTab(tab);
        props.onSectionChange?.(tab);
      }}
      orientation="vertical"
      activationMode="automatic"
      class="settings-modal-tabs-root"
    >
      <SettingsDialogShell
        class="app-settings-modal-shell"
        open={props.open}
        page={props.page}
        title={t(navItem().titleKey)}
        description={t(navItem().descriptionKey)}
        contentKey={activeTab()}
        onContentElement={(element) => (modalElement = element)}
        sidebar={
          <>
            <Tabs.List class="settings-modal-nav" aria-label={t("settings.sections.label")}>
              {TABS.map((tab) => {
                const item = TAB_ITEMS[tab];
                const NavIcon = item.icon;
                return (
                  <Tabs.Trigger
                    class="settings-modal-nav-item"
                    value={tab}
                    aria-current={activeTab() === tab ? "page" : undefined}
                  >
                    <NavIcon aria-hidden="true" />
                    <span>{t(item.titleKey)}</span>
                  </Tabs.Trigger>
                );
              })}
            </Tabs.List>
            <Show when={props.onOpenShortcut}>
              {(open) => (
                <nav class="settings-modal-nav" aria-label={t("server.settings.elsewhere")}>
                  <span class="settings-modal-nav-heading" aria-hidden="true">
                    {t("webClient.settings.workspaceHeading")}
                  </span>
                  {SHORTCUTS.map((item) => {
                    const NavIcon = item.icon;
                    return (
                      <Button
                        variant="ghost"
                        type="button"
                        class="settings-modal-nav-item"
                        onClick={() => open()(item.id)}
                      >
                        <NavIcon aria-hidden="true" />
                        <span>{t(item.titleKey)}</span>
                      </Button>
                    );
                  })}
                </nav>
              )}
            </Show>
            <div class="settings-modal-nav">
              <Button
                variant="ghost"
                type="button"
                class="settings-modal-nav-item"
                onClick={() => {
                  props.onOpenChange(false);
                  props.onOpenBilling();
                }}
              >
                <CreditCard aria-hidden="true" />
                <span>{t("account.menu.billing")}</span>
              </Button>
            </div>
          </>
        }
      >
        <Tabs.Content value="profile" class="settings-modal-tab-panel profile-panel" data-tab="profile">
          <SettingsProfileTab
            store={profile}
            account={props.account}
            canListSessions
            canRevokeSession
            onSignOut={props.onSignOut}
          />
        </Tabs.Content>

        <Tabs.Content value="appearance" class="settings-modal-tab-panel" data-tab="appearance">
          <SettingsSection title={t("settings.appBehavior.title")}>
            <ItemGroup class="settings-modal-card">
              {/* A phone has no Enter key to choose: Return adds a line and Send sends. */}
              <Show when={!usesTouchLayout()}>
                <Item class="settings-modal-row">
                  <ItemContent>
                    <ItemTitle>{t("settings.sendShortcut.title")}</ItemTitle>
                    <ItemDescription>{t("settings.sendShortcut.description")}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <SendShortcutSelect
                      value={sendShortcutMode()}
                      onChange={(mode) => setSendShortcutMode(mode)}
                      devicePlatform={currentDevicePlatform()}
                      {...(modalElement ? { mount: modalElement } : {})}
                    />
                  </ItemActions>
                </Item>
              </Show>
              <SwitchField
                checked={showAgentSteps()}
                onChange={(checked) => setShowAgentSteps(checked)}
                label={t("settings.showAgentSteps.title")}
                description={t("settings.showAgentSteps.description")}
              />
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>{t("settings.language.title")}</ItemTitle>
                  <ItemDescription>{t("settings.language.description")}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <LanguageSelect
                    value={props.language}
                    onChange={props.onChangeLanguage}
                    {...(modalElement ? { mount: modalElement } : {})}
                  />
                </ItemActions>
              </Item>
              <SwitchField
                checked={showAgentReasoning()}
                onChange={setShowAgentReasoning}
                label={t("settings.showAgentReasoning.title")}
                description={t("settings.showAgentReasoning.description")}
              />
              <SwitchField
                checked={showAgentMessages()}
                onChange={setShowAgentMessages}
                label={t("settings.showAgentMessages.title")}
                description={t("settings.showAgentMessages.description")}
              />
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>{t("settings.appearance.theme.title")}</ItemTitle>
                  <ItemDescription>{t("settings.appearance.theme.description")}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <AppearanceSelect
                    value={props.appearance}
                    onChange={props.onChangeAppearance}
                    {...(modalElement ? { mount: modalElement } : {})}
                  />
                </ItemActions>
              </Item>
            </ItemGroup>
          </SettingsSection>
          <SettingsSection title={t("settings.analytics.title")}>
            <ItemGroup class="settings-modal-card">
              <SwitchField
                checked={reportsEnabled()}
                onChange={(value) => {
                  setReportsEnabled(setWebAnalyticsEnabled(value));
                }}
                label={t("settings.analytics.title")}
                description={t("settings.analytics.webDescription")}
              />
            </ItemGroup>
          </SettingsSection>
        </Tabs.Content>

        <Tabs.Content value="notifications" class="settings-modal-tab-panel" data-tab="notifications">
          <SettingsSection title={t("settings.notifications.title")}>
            <ItemGroup class="settings-modal-card">
              <SwitchField
                checked={completionSound()}
                onChange={(checked) => {
                  setCompletionSound(checked);
                  setCompletionSoundEnabled(checked);
                }}
                label={t("settings.taskSound.title")}
                description={t("settings.taskSound.description")}
              />
              <SwitchField
                checked={attentionSound()}
                onChange={(checked) => {
                  setAttentionSound(checked);
                  setAttentionSoundEnabled(checked);
                }}
                label={t("settings.attentionSound.title")}
                description={t("settings.attentionSound.description")}
              />
              <Show when={props.push}>
                {(push) => (
                  <SwitchField
                    checked={push().enabled}
                    disabled={push().availability !== "ready" || push().busy}
                    onChange={(checked) => push().onChange(checked)}
                    label={t("webClient.push.title")}
                    description={
                      push().failure === "denied"
                        ? t("webClient.push.denied")
                        : push().failure === "failed"
                          ? t("webClient.push.failed")
                          : push().availability === "browser-unsupported"
                            ? t("webClient.push.browserUnsupported")
                            : push().availability === "no-host"
                              ? t("webClient.push.noHost")
                              : push().availability === "host-unsupported"
                                ? t("webClient.push.hostUnsupported")
                                : t("webClient.push.description", { host: push().hostName })
                    }
                  />
                )}
              </Show>
              <SwitchField
                checked={notificationText()}
                onChange={(checked) => {
                  setNotificationText(checked);
                  setNotificationTextEnabled(checked);
                }}
                label={t("settings.notificationPreview.title")}
                description={t("settings.notificationPreview.description")}
              />
              <Item class="settings-modal-row settings-sound-theme-row">
                <ItemContent>
                  <ItemTitle>{t("settings.soundFeedback.title")}</ItemTitle>
                  <ItemDescription>{t("settings.soundFeedback.description")}</ItemDescription>
                </ItemContent>
                <SoundThemePicker
                  value={soundChoice()}
                  onChange={(value) => {
                    setSoundChoice(value);
                    setActionSoundChoice(value);
                  }}
                  onReplay={replayActionSoundChoice}
                />
              </Item>
              <Show when={props.agentNoise?.agents.length ? props.agentNoise : undefined}>
                {(noise) => (
                  <Item class="settings-modal-row settings-agent-noise">
                    <ItemContent>
                      <ItemTitle>{t("webClient.settings.agentNoise.title")}</ItemTitle>
                      <ItemDescription>{t("webClient.settings.agentNoise.description")}</ItemDescription>
                      <ul class="settings-agent-noise-list">
                        <For each={noise().agents}>
                          {(agent) => (
                            <li class="settings-agent-noise-row">
                              <span>{agent.name}</span>
                              <NativeSelect
                                aria-label={t("webClient.settings.agentNoise.label", { name: agent.name })}
                                value={noise().level(agent.id)}
                                onChange={(event) => {
                                  const level = WORKSPACE_AGENT_NOISE_LEVELS.find(
                                    (value) => value === event.currentTarget.value,
                                  );
                                  if (level) noise().onChange(agent.id, level);
                                }}
                              >
                                <option value="all">{t("webClient.settings.agentNoise.all")}</option>
                                <option value="important">{t("webClient.settings.agentNoise.important")}</option>
                                <option value="digest">{t("webClient.settings.agentNoise.digest")}</option>
                              </NativeSelect>
                            </li>
                          )}
                        </For>
                      </ul>
                    </ItemContent>
                  </Item>
                )}
              </Show>
              <Show when={props.onOpenQuietHours}>
                {(open) => (
                  <Item class="settings-modal-row">
                    <ItemContent>
                      <ItemTitle>{t("workspace.away.settingsTitle")}</ItemTitle>
                      <ItemDescription>{t("workspace.away.quietNote")}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button type="button" variant="outline" size="sm" onClick={() => open()()}>
                        {t("webClient.settings.quietHours.open")}
                      </Button>
                    </ItemActions>
                  </Item>
                )}
              </Show>
            </ItemGroup>
          </SettingsSection>
        </Tabs.Content>
      </SettingsDialogShell>
    </Tabs.Root>
  );
}
