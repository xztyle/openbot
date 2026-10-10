import {
  Badge,
  Button,
  Heading,
  Input,
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
  Switch,
  Text,
} from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { useText } from "@openbot/ui/text";
import { Switch as Branch, createSignal, For, Match, Show } from "solid-js";
import type { ChatAccessMode, MarketplaceAccount, MarketplaceAgent, MarketplaceApp } from "./marketplace-model";
import type { MarketplaceScope } from "./marketplace-view";

type PluginApp = Extract<MarketplaceApp, { kind: "plugin" }>;

const MODES = ["off", "read", "write"] as const satisfies readonly ChatAccessMode[];
const MODE_LABEL = { off: "mcp.chat.off", read: "mcp.chat.read", write: "mcp.chat.write" } as const;

/**
 * What one chat may do with one account: Off, Read only, or Allow changes. Each button is one
 * decision. A grant is an authorization, so nothing here sets a mode except a press on it.
 */
function AccessModes(props: {
  label: string;
  mode: ChatAccessMode;
  /** The press that is being saved, which shows progress. Every other press waits for it. */
  pending: ChatAccessMode | null;
  waiting: boolean;
  disabled?: boolean;
  onSelect: (mode: ChatAccessMode) => void;
}) {
  const { t } = useText();
  return (
    <fieldset class="marketplace-access-modes">
      <legend class="marketplace-visually-hidden">{props.label}</legend>
      <For each={MODES}>
        {(value) => (
          <Button
            type="button"
            size="sm"
            variant={props.mode === value ? "default" : "outline"}
            aria-pressed={props.mode === value ? "true" : "false"}
            loading={props.pending === value}
            disabled={props.disabled || props.waiting}
            onClick={() => {
              if (props.mode !== value) props.onSelect(value);
            }}
          >
            {t(MODE_LABEL[value])}
          </Button>
        )}
      </For>
    </fieldset>
  );
}

function AgentName(props: { agent: MarketplaceAgent; here: boolean }) {
  const { t } = useText();
  return (
    <span class="marketplace-access-agent">
      <span class="marketplace-avatar" data-size="xs">
        <AgentAvatar agent={props.agent} motion="idle" />
      </span>
      <span class="marketplace-access-agent-name">{props.agent.name}</span>
      <Show when={props.here}>
        <Badge variant="secondary">{t("marketplace.access.thisChat")}</Badge>
      </Show>
    </span>
  );
}

/** The accounts of an app that the host offers to chats: the ones that are turned on. */
function chatAccounts(scope: MarketplaceScope, app: PluginApp) {
  return scope.model.appConnections(app).filter((account) => account.enabled);
}

/**
 * The one explicit step after a connect. The new account starts Off for every chat, so the page
 * asks what the open chat's agent may do with it. Off stays the answer until the user presses a mode.
 */
export function AllowForAgent(props: { scope: MarketplaceScope; app: PluginApp }) {
  const { t } = useText();
  const model = () => props.scope.model;
  const access = () => model().chatAccess;
  const connected = () => {
    const step = model().justConnected();
    return step?.appId === props.app.id ? step : null;
  };
  const account = () =>
    model()
      .appConnections(props.app)
      .find((entry) => entry.id === connected()?.accountId);
  const agent = () =>
    model()
      .agents()
      .find((entry) => entry.id === model().activeAgentId());
  const visible = () => {
    const current = account();
    const target = agent();
    if (!current?.enabled || !target || !access().supported() || !model().canConnectApps()) return null;
    return access().listed(target.id, current.id) && access().mode(target.id, current.id) === "off"
      ? { account: current, agent: target }
      : null;
  };
  return (
    <Show when={visible()}>
      {(step) => (
        <section class="marketplace-allow" aria-label={t("marketplace.access.allowFor", { agent: step().agent.name })}>
          <div class="marketplace-allow-copy">
            <Heading as="h4" size="sm">
              {t("marketplace.access.allowFor", { agent: step().agent.name })}
            </Heading>
            <Text as="p" variant="body-sm" tone="muted">
              {t("marketplace.access.allowDescription", { account: step().account.name, agent: step().agent.name })}
            </Text>
          </div>
          <AccessModes
            label={t("marketplace.access.groupLabel", { agent: step().agent.name, account: step().account.name })}
            mode="off"
            pending={access().saving()?.accountId === step().account.id ? (access().saving()?.mode ?? null) : null}
            waiting={access().saving() !== null}
            onSelect={(mode) => void access().setMode(step().agent.id, step().account.id, mode)}
          />
          <Button type="button" variant="ghost" size="sm" onClick={model().dismissJustConnected}>
            {t("marketplace.access.notNow")}
          </Button>
        </section>
      )}
    </Show>
  );
}

/**
 * Which agent's chat may use which account, in one place. Choosing a mode saves at once. The host
 * then refreshes the app connections of its agents, so the controls wait and the page says so.
 */
export function ChatAccessSection(props: { scope: MarketplaceScope; app: PluginApp }) {
  const { t } = useText();
  const model = () => props.scope.model;
  const access = () => model().chatAccess;
  const accounts = () => chatAccounts(props.scope, props.app);
  const anyDisabled = () =>
    model()
      .appConnections(props.app)
      .some((account) => !account.enabled);
  const unread = () =>
    model()
      .agents()
      .filter((agent) => access().readState(agent.id) === "failed");
  const reading = () =>
    model()
      .agents()
      .some((agent) => access().readState(agent.id) === "loading");
  /* The press that is being saved: the host answers only when every agent runtime was refreshed. */
  const saving = () => access().saving();
  const savingAgent = () =>
    model()
      .agents()
      .find((agent) => agent.id === saving()?.agentId)?.name ?? "";
  return (
    <Show when={access().supported() && model().canConnectApps()}>
      <SettingsSection title={t("marketplace.access.title")} description={t("marketplace.access.description")}>
        <div class="marketplace-access">
          <Show when={reading()}>
            <Text as="p" variant="body-sm" tone="muted" role="status">
              {t("marketplace.access.loading")}
            </Text>
          </Show>
          <Show when={unread().length > 0}>
            <div class="marketplace-access-failed" role="alert">
              <Text as="p" variant="body-sm" tone="muted">
                {t("marketplace.access.readFailed", {
                  agents: unread()
                    .map((agent) => agent.name)
                    .join(", "),
                })}
              </Text>
              <Button type="button" variant="outline" size="sm" onClick={() => access().read()}>
                {t("common.retry")}
              </Button>
            </div>
          </Show>
          <Show when={saving()}>
            <Text as="p" variant="body-sm" tone="muted" role="status">
              {t("marketplace.access.saving", { agent: savingAgent() })}
            </Text>
          </Show>
          <For each={accounts()} keyed={(account) => account.id}>
            {(accountOf) => (
              <section class="marketplace-access-account" aria-labelledby={`marketplace-access-${accountOf().id}`}>
                <Heading as="h4" size="sm" id={`marketplace-access-${accountOf().id}`}>
                  {accountOf().name}
                </Heading>
                <ItemGroup class="settings-modal-card">
                  <For each={model().agents()} keyed={(agent) => agent.id}>
                    {(agentOf) => (
                      <Item class="settings-modal-row marketplace-access-row">
                        <AgentName agent={agentOf()} here={agentOf().id === model().activeAgentId()} />
                        <Show
                          when={access().listed(agentOf().id, accountOf().id)}
                          fallback={
                            <Text as="span" variant="caption" tone="muted">
                              {access().readState(agentOf().id) === "failed"
                                ? t("marketplace.access.unreadable")
                                : t("common.loading")}
                            </Text>
                          }
                        >
                          <AccessModes
                            label={t("marketplace.access.groupLabel", {
                              agent: agentOf().name,
                              account: accountOf().name,
                            })}
                            mode={access().mode(agentOf().id, accountOf().id)}
                            pending={
                              saving()?.agentId === agentOf().id && saving()?.accountId === accountOf().id
                                ? (saving()?.mode ?? null)
                                : null
                            }
                            waiting={saving() !== null}
                            onSelect={(mode) => void access().setMode(agentOf().id, accountOf().id, mode)}
                          />
                        </Show>
                      </Item>
                    )}
                  </For>
                </ItemGroup>
              </section>
            )}
          </For>
          <Show when={accounts().length === 0}>
            <Text as="p" variant="body-sm" tone="muted">
              {t("marketplace.access.noAccounts")}
            </Text>
          </Show>
          <Show when={anyDisabled() && accounts().length > 0}>
            <Text as="p" variant="caption" tone="muted">
              {t("marketplace.access.disabledNote")}
            </Text>
          </Show>
          <Text as="p" variant="caption" tone="muted">
            {t("mcp.chat.readHint")} {t("marketplace.access.groups")}
          </Text>
        </div>
      </SettingsSection>
    </Show>
  );
}

function CheckLine(props: { account: MarketplaceAccount }) {
  const { t } = useText();
  return (
    <Branch>
      <Match when={props.account.check.phase === "checking"}>
        <ItemDescription role="status">{t("marketplace.account.checking")}</ItemDescription>
      </Match>
      <Match when={props.account.check.phase === "ok" && props.account.check}>
        {(check) => (
          <ItemDescription>
            {t("marketplace.account.working", { count: check().phase === "ok" ? check().toolCount : 0 })}
          </ItemDescription>
        )}
      </Match>
      <Match when={props.account.check.phase === "idle" && props.account.signedOut}>
        <ItemDescription class="marketplace-account-failed">{t("marketplace.account.signedOut")}</ItemDescription>
      </Match>
      <Match when={props.account.check.phase === "failed" && props.account.check}>
        {(check) => (
          <ItemDescription class="marketplace-account-failed">
            {t("marketplace.account.failed", { reason: check().phase === "failed" ? check().message : "" })}
          </ItemDescription>
        )}
      </Match>
    </Branch>
  );
}

function RenameAccount(props: {
  account: MarketplaceAccount;
  busy: boolean;
  onSave: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useText();
  const [name, setName] = createSignal(props.account.name);
  return (
    <form
      class="marketplace-account-rename"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSave(name()).then((saved) => {
          if (saved) props.onCancel();
        });
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onCancel();
      }}
    >
      <Input
        aria-label={t("mcp.connection.name")}
        value={name()}
        disabled={props.busy}
        ref={(element: HTMLInputElement) => queueMicrotask(() => element.focus())}
        onValueChange={setName}
      />
      <Button type="submit" size="sm" loading={props.busy} disabled={name().trim().length === 0}>
        {t("common.save")}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
        {t("common.cancel")}
      </Button>
    </form>
  );
}

/**
 * One connection of the app to an account. Turning it off, renaming it, checking it and signing in
 * again all act on this row, so its id and the chat access of its id stay. Disconnecting removes it.
 */
function AccountRow(props: {
  scope: MarketplaceScope;
  app: PluginApp;
  account: MarketplaceAccount;
  onDisconnect: (account: MarketplaceAccount) => void;
}) {
  const { t } = useText();
  const model = () => props.scope.model;
  const account = () => props.account;
  const [renaming, setRenaming] = createSignal(false);
  const busy = () => model().accountBusy(account().id) || model().appBusy(props.app.id);
  /** A check that failed, or a sign-in that is gone: the way back in is the main action of the row. */
  const failed = () => account().check.phase === "failed" || account().signedOut;
  return (
    <Item class="settings-modal-row marketplace-account" role="group" aria-label={account().name}>
      <ItemContent>
        <Show
          when={!renaming()}
          fallback={
            <RenameAccount
              account={account()}
              busy={busy()}
              onSave={(name) => model().renameAccount(account().id, name)}
              onCancel={() => setRenaming(false)}
            />
          }
        >
          <ItemTitle>
            {account().name}
            <Show when={!account().enabled}>
              <Badge variant="outline" class="marketplace-account-badge">
                {t("marketplace.account.disabled")}
              </Badge>
            </Show>
            <Show when={account().outdated}>
              <Badge variant="info-light" class="marketplace-account-badge">
                {t("marketplace.account.outdated")}
              </Badge>
            </Show>
          </ItemTitle>
          <CheckLine account={account()} />
        </Show>
      </ItemContent>
      <Show when={model().canConnectApps()}>
        <Switch
          aria-label={t("mcp.panel.enable", { name: account().name })}
          checked={account().enabled}
          disabled={busy()}
          onChange={(enabled) => void model().setAccountEnabled(account().id, enabled)}
        />
        <div class="marketplace-account-actions">
          <Show when={account().renamable && !renaming()}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy()}
              aria-label={t("marketplace.account.renameNamed", { name: account().name })}
              onClick={() => setRenaming(true)}
            >
              {t("marketplace.account.rename")}
            </Button>
          </Show>
          <Show when={account().enabled}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy() || account().check.phase === "checking"}
              aria-label={t("marketplace.account.checkNamed", { name: account().name })}
              onClick={() => void model().checkAccount(account().id)}
            >
              {t("marketplace.account.check")}
            </Button>
          </Show>
          <Show when={account().reconnect}>
            {(kind) => (
              <Button
                type="button"
                variant={failed() ? "default" : "outline"}
                size="sm"
                disabled={busy()}
                aria-label={t(
                  kind() === "sign-in" ? "marketplace.account.signInNamed" : "marketplace.account.changeKeyNamed",
                  { name: account().name },
                )}
                onClick={() => void model().reconnectAccount(props.app, account().id)}
              >
                {t(kind() === "sign-in" ? "marketplace.account.signIn" : "marketplace.account.changeKey")}
              </Button>
            )}
          </Show>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy()}
            onClick={() => props.onDisconnect(account())}
          >
            {t("mcp.connection.remove")}
          </Button>
        </div>
      </Show>
    </Item>
  );
}

/** The accounts of an app, the update the app offers them, and what the user can do with each. */
export function AccountsSection(props: {
  scope: MarketplaceScope;
  app: PluginApp;
  /** The id of the section, so that an action in the page header can bring the user to it. */
  anchorId?: string;
  onDisconnect: (account: MarketplaceAccount) => void;
}) {
  const { t } = useText();
  const model = () => props.scope.model;
  const accounts = () => model().appConnections(props.app);
  const outdated = () => accounts().filter((account) => account.outdated);
  return (
    <Show when={accounts().length > 0}>
      <SettingsSection id={props.anchorId} tabindex={-1} title={t("mcp.connection.accounts")}>
        <Show when={outdated().length > 0 && model().canConnectApps()}>
          <section
            class="marketplace-update"
            aria-label={t("marketplace.account.updateTitle", { name: props.app.name })}
          >
            <Text as="p" variant="body-sm">
              {t("marketplace.account.updateDescription", { name: props.app.name, count: outdated().length })}
            </Text>
            <Button
              type="button"
              size="sm"
              loading={model().appBusy(props.app.id)}
              aria-label={t("marketplace.account.updateNamed", { name: props.app.name })}
              onClick={() => void model().updateApp(props.app)}
            >
              {t("marketplace.account.update")}
            </Button>
          </section>
        </Show>
        <ItemGroup class="settings-modal-card">
          <For each={accounts()} keyed={(account) => account.id}>
            {(account) => (
              <AccountRow scope={props.scope} app={props.app} account={account()} onDisconnect={props.onDisconnect} />
            )}
          </For>
        </ItemGroup>
      </SettingsSection>
    </Show>
  );
}
