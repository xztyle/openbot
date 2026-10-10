import type { MarketplaceAgentSummary, MarketplaceSkillSummary } from "@openbot/contracts/ipc";
import { Badge, Button, Heading, Plus, Text } from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { useText } from "@openbot/ui/text";
import { For, Match, Show, Switch } from "solid-js";
import { InstallSkill, outdatedAgentIds } from "./MarketplaceInstallSkill";
import { AppLogo, Done, SkillMark } from "./MarketplaceParts";
import { CATEGORY_LABELS } from "./marketplace-listing";
import type { MarketplaceApp } from "./marketplace-model";
import type { MarketplaceScope } from "./marketplace-view";

/** "1,204 installs", in the reader's number format. */
export function useInstalls() {
  const { t, format } = useText();
  return (count: number) => t("marketplace.installs", { count, installs: format.number(count) });
}

/**
 * "Add", then "Added", or "Update available" when the user has an older version. Add keeps the
 * Marketplace open. The button is then gone, so `onAdded` gives the focus a new place.
 */
function AgentState(props: { scope: MarketplaceScope; listing: MarketplaceAgentSummary; onAdded: () => void }) {
  const { t } = useText();
  const model = () => props.scope.model;
  return (
    <Switch>
      <Match when={model().agentState(props.listing) === "add"}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={model().agentBusy(props.listing.id)}
          aria-label={t("marketplace.agent.addNamed", { name: props.listing.name })}
          onClick={() =>
            void model()
              .addAgent(props.listing)
              .then((added) => {
                if (added) props.onAdded();
              })
          }
        >
          <Plus aria-hidden="true" />
          {t("marketplace.agent.add")}
        </Button>
      </Match>
      <Match when={model().agentState(props.listing) === "added"}>
        <Done>{t("marketplace.agent.added")}</Done>
      </Match>
      <Match when={model().agentState(props.listing) === "update"}>
        <Badge variant="info-light">{t("marketplace.agent.updateAvailable")}</Badge>
      </Match>
    </Switch>
  );
}

/** The whole card opens the agent page. "Add" sits above the hit area and adds at once. */
function AgentCard(props: { scope: MarketplaceScope; listing: MarketplaceAgentSummary }) {
  const { t } = useText();
  const installs = useInstalls();
  const id = () => `marketplace-agent-${props.listing.id}`;
  let hit: HTMLButtonElement | undefined;
  return (
    <article class="marketplace-card" aria-labelledby={id()}>
      <Button
        type="button"
        variant="ghost"
        class="marketplace-hitarea"
        data-cuelume-tap="navigate"
        ref={(element) => (hit = element)}
        aria-label={t("marketplace.open", { name: props.listing.name })}
        onClick={() => props.scope.nav.go({ kind: "agent", listing: props.listing })}
      />
      <div class="marketplace-card-head">
        <span class="marketplace-avatar" data-size="md">
          <AgentAvatar agent={props.listing} motion="hover" />
        </span>
        <Heading as="h3" size="sm" class="marketplace-card-name" id={id()}>
          {props.listing.name}
        </Heading>
        <div class="marketplace-card-action">
          <AgentState scope={props.scope} listing={props.listing} onAdded={() => hit?.focus()} />
        </div>
      </div>
      <Text as="p" variant="body-sm" class="marketplace-card-body">
        {props.listing.description}
      </Text>
      <div class="marketplace-card-foot">
        <Text as="span" variant="caption" tone="muted">
          {[props.listing.creatorName, installs(props.listing.installs)].join(" · ")}
        </Text>
      </div>
    </article>
  );
}

function SkillCard(props: { scope: MarketplaceScope; skill: MarketplaceSkillSummary }) {
  const { t } = useText();
  const installs = useInstalls();
  const outdated = () => outdatedAgentIds(props.scope, props.skill).length > 0;
  const id = () => `marketplace-skill-${props.skill.id}`;
  return (
    <article class="marketplace-card" aria-labelledby={id()}>
      <Button
        type="button"
        variant="ghost"
        class="marketplace-hitarea"
        data-cuelume-tap="navigate"
        aria-label={t("marketplace.open", { name: props.skill.name })}
        onClick={() => props.scope.nav.go({ kind: "skill", listing: props.skill })}
      />
      <div class="marketplace-card-head">
        <SkillMark skill={props.skill} size="md" />
        <Heading as="h3" size="sm" class="marketplace-card-name" id={id()}>
          {props.skill.name}
        </Heading>
        <Show when={props.scope.model.agents().length > 0}>
          <div class="marketplace-card-action">
            <InstallSkill scope={props.scope} skill={props.skill} />
          </div>
        </Show>
      </div>
      <Text as="p" variant="body-sm" class="marketplace-card-body">
        {props.skill.description}
      </Text>
      <div class="marketplace-card-foot">
        <Text as="span" variant="caption" tone="muted">
          {[props.skill.creatorName, installs(props.skill.installs)].join(" · ")}
        </Text>
        <Show when={outdated()}>
          <Badge variant="info-light">{t("marketplace.skill.updateAvailable")}</Badge>
        </Show>
      </div>
    </article>
  );
}

/**
 * "Connect", or "Reconnect" for an app that needs attention. A connected app shows "Connected" in a
 * list; its page shows the status in the header instead. A connect removes this button, so
 * `onConnected` gives the focus a new place.
 */
export function AppAction(props: {
  scope: MarketplaceScope;
  app: MarketplaceApp;
  size?: "sm";
  /** A small button is outline in a list. The app page header uses the filled one. */
  variant?: "default";
  /** Outside the app's own page the button says which app: "Connect Linear". */
  named?: boolean;
  onConnected?: () => void;
}) {
  const { t } = useText();
  const model = () => props.scope.model;
  const attention = () => props.app.status === "attention";
  const label = () =>
    attention()
      ? t("marketplace.app.reconnectNamed", { name: props.app.name })
      : t("marketplace.app.connectNamed", { name: props.app.name });
  const connect = () => {
    const app = props.app;
    /* GitHub signs in with a device code. Its page owns that dialog, and opens it while the sign-in waits. */
    if (app.kind === "github") {
      const view = props.scope.nav.state.stack.at(-1);
      if (view?.kind !== "app" || view.id !== app.id) props.scope.nav.go({ kind: "app", id: app.id });
      model().github?.().onConnect();
      return;
    }
    /* Password managers need setup input. Their pages own those choices. */
    if (app.kind === "onepassword" || app.kind === "bitwarden") {
      props.scope.nav.go({ kind: "app", id: app.id });
      return;
    }
    void model()
      .connectApp(app)
      .then((connected) => {
        if (connected) props.onConnected?.();
      });
  };
  /* The host's list of apps is not read yet, or could not be. An app that is connected already reads
   * as not connected until then, and Connect would add a second account of it. A sign-in that is
   * running waits for its answer. */
  const unread = () => props.app.kind === "plugin" && model().appsRead() !== "loaded";
  const waiting = () => unread() || props.app.status === "connecting";
  /** What the disabled button says: the wait, or Connect itself after a failed read. */
  const waitingText = () => {
    if (props.app.status === "connecting") return t("marketplace.app.connecting");
    if (unread() && model().appsRead() === "loading") return t("marketplace.app.checking");
    return null;
  };
  /* An app whose accounts are off is not offered again: Connect would add an account. Its page turns
   * them on. */
  const held = () => props.app.status === "connected" || props.app.status === "disabled";
  /* An app with accounts that needs attention is reviewed on its page: Reconnect would add one more
   * account, with a new connection id and none of the chat access of the others. */
  const review = () => attention() && props.app.kind === "plugin" && model().appConnections(props.app).length > 0;
  return (
    <Show
      when={!waiting()}
      fallback={
        <Show when={model().canConnectApps()}>
          <Button
            type="button"
            variant={props.variant ?? (props.size ? "outline" : "default")}
            size={props.size}
            disabled
            aria-label={waitingText() ?? label()}
          >
            {waitingText() ?? (props.named ? label() : t("marketplace.app.connect"))}
          </Button>
        </Show>
      }
    >
      <Show
        when={!review()}
        fallback={
          <Show when={props.size}>
            <Button
              type="button"
              variant="outline"
              size={props.size}
              aria-label={t("marketplace.app.reviewNamed", { name: props.app.name })}
              onClick={() => props.scope.nav.go({ kind: "app", id: props.app.id })}
            >
              {t("marketplace.app.review")}
            </Button>
          </Show>
        }
      >
        <Show
          when={!held()}
          fallback={
            <Show when={props.size}>
              <Show
                when={props.app.status === "connected"}
                fallback={<Badge variant="outline">{t("marketplace.app.disabled")}</Badge>}
              >
                <Done>{t("marketplace.app.connected")}</Done>
              </Show>
            </Show>
          }
        >
          {/* A custom server is turned on in Server settings › MCP, not here. */}
          <Show when={model().canConnectApps() && props.app.kind !== "custom"}>
            <Button
              type="button"
              variant={props.variant ?? (props.size ? "outline" : "default")}
              size={props.size}
              loading={model().appBusy(props.app.id)}
              aria-label={label()}
              onClick={connect}
            >
              {props.named ? label() : attention() ? t("marketplace.app.reconnect") : t("marketplace.app.connect")}
            </Button>
          </Show>
        </Show>
      </Show>
    </Show>
  );
}

/**
 * Says that the apps of the host could not be read, and offers Retry. Connect stays off until a
 * read works: the list that failed may hold the app that the user is about to connect again.
 */
export function AppsReadNotice(props: { scope: MarketplaceScope }) {
  const { t } = useText();
  const model = () => props.scope.model;
  return (
    <Show when={model().appsRead() === "failed"}>
      <div class="marketplace-apps-failed" role="alert">
        <Text as="p" variant="body-sm" tone="muted">
          {t("marketplace.app.readFailed", {
            host: model().appsHostName?.() ?? t("mcp.connect.thisComputer"),
          })}
        </Text>
        <Button type="button" variant="outline" size="sm" onClick={model().retryApps}>
          {t("common.retry")}
        </Button>
      </div>
    </Show>
  );
}

/** The line under an app card: its category, or "MCP server" for a server that the user added. */
function appKind(app: MarketplaceApp) {
  return app.kind === "custom" ? ("marketplace.app.custom" as const) : CATEGORY_LABELS[app.category];
}

/** A connect moves the app to the apps that the user has, where its card is a new element. */
function focusCard(label: string) {
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(`.skills-marketplace .marketplace-hitarea[aria-label="${CSS.escape(label)}"]`)
      ?.focus(),
  );
}

/** An app card, as on the Agents and Skills tabs. The card opens the app page; Connect sits above it. */
export function AppCard(props: { scope: MarketplaceScope; app: MarketplaceApp }) {
  const { t } = useText();
  /** "2 accounts" for an app the host holds, so a card says how many connections an agent could use. */
  const accounts = () => {
    const count = props.app.accountCount ?? 0;
    return count > 0 ? t("marketplace.app.accounts", { count }) : "";
  };
  const id = () => `marketplace-app-${props.app.id}`;
  const open = () => t("marketplace.open", { name: props.app.name });
  return (
    <article class="marketplace-card" aria-labelledby={id()}>
      <Button
        type="button"
        variant="ghost"
        class="marketplace-hitarea"
        data-cuelume-tap="navigate"
        aria-label={open()}
        onClick={() => props.scope.nav.go({ kind: "app", id: props.app.id })}
      />
      <div class="marketplace-card-head">
        <AppLogo app={props.app} />
        <Heading as="h4" size="sm" class="marketplace-card-name" id={id()}>
          {props.app.name}
        </Heading>
        <div class="marketplace-card-action">
          <AppAction scope={props.scope} app={props.app} size="sm" onConnected={() => focusCard(open())} />
        </div>
      </div>
      <Text as="p" variant="body-sm" class="marketplace-card-body">
        {props.app.tagline}
      </Text>
      <div class="marketplace-card-foot">
        <Text as="span" variant="caption" tone="muted">
          {[t(appKind(props.app)), accounts()].filter(Boolean).join(" · ")}
        </Text>
      </div>
    </article>
  );
}

export function AgentGrid(props: { scope: MarketplaceScope; items: readonly MarketplaceAgentSummary[] }) {
  return (
    <div class="marketplace-grid">
      <For each={props.items}>{(listing) => <AgentCard scope={props.scope} listing={listing} />}</For>
    </div>
  );
}

export function SkillGrid(props: { scope: MarketplaceScope; items: readonly MarketplaceSkillSummary[] }) {
  return (
    <div class="marketplace-grid">
      <For each={props.items}>{(skill) => <SkillCard scope={props.scope} skill={skill} />}</For>
    </div>
  );
}
