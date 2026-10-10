import type {
  AddedAgent,
  AgentSummary,
  InstalledSkill,
  MarketplaceAgentDetail,
  MarketplaceAgentSummary,
  MarketplaceSkillDetail,
  MarketplaceSkillSummary,
  McpServerConfig,
} from "@openbot/contracts/ipc";
import { mcpConfigErrors } from "@openbot/contracts/ipc";
import { createPluginShareUrl } from "@openbot/contracts/plugin-links";
import type { McpChatSnapshot } from "@openbot/contracts/team-protocol/mcp-chat-v1";
import { safeBrowserUrl } from "@openbot/ui/features/conversation/RichMessageText";
import type {
  AgentListingState,
  AppsRead,
  ChatAccessMode,
  MarketplaceAccount,
  MarketplaceAccountCheck,
  MarketplaceApp,
  MarketplaceAppStatus,
  MarketplaceChatAccess,
  MarketplaceModel,
  SkillRead,
} from "@openbot/ui/features/marketplace/marketplace-model";
import { serverAddress } from "@openbot/ui/features/marketplace/marketplace-view";
import type { BitwardenConnectorPanelProps } from "@openbot/ui/features/settings/BitwardenConnectorPanel";
import type { McpConnectSubject } from "@openbot/ui/features/settings/McpConnectShell";
import {
  isOutdatedPluginAppConfig,
  isPluginAppConfig,
  type MarketplacePluginApp,
  type MarketplacePluginDetail,
  type MarketplacePluginPrompt,
  updatedPluginAppConfig,
} from "@openbot/ui/features/settings/marketplace-plugins";
import type { McpConnectFlow } from "@openbot/ui/features/settings/mcp-connect-auth";
import type { PluginUninstallPlan } from "@openbot/ui/features/settings/PluginUninstallDialog";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, createStore, onCleanup, untrack } from "solid-js";
import { desktopAnalytics } from "../../analytics";
import { writeClipboardText } from "../../clipboard";
import { type GitHubConnectorController, githubPanelProps } from "../connectors/github-connector";
import { type OnePasswordConnectorController, onePasswordPanelProps } from "../connectors/onepassword-connector";
import { desktopMarketplaceCalls, type MarketplaceCalls } from "./marketplace-calls";
import { createPluginAppConfig } from "./marketplace-plugin-catalog";
import { localizedPlugin } from "./marketplace-plugin-text";
import { agentHomeCache, marketplaceErrorMessage, skillHomeCache } from "./marketplace-shared";

const ACCESS_MODE_LABEL = {
  off: "mcp.chat.off",
  read: "mcp.chat.read",
  write: "mcp.chat.write",
} as const satisfies Record<ChatAccessMode, string>;

/** An agent of the server that the Marketplace is for. */
export type MarketplaceAgentRow = Pick<
  AgentSummary,
  "id" | "name" | "marketplaceSource" | "avatarSeed" | "avatarHue" | "avatarUrl"
>;

export interface MarketplaceControllerProps {
  open: boolean;
  /** The agents that a skill can go to. Empty for a member, who browses and installs nothing. */
  agents: readonly MarketplaceAgentRow[];
  activeAgentId: string;
  onOpenChange: (open: boolean) => void;
  onTrySkill?: ((agentId: string, skill: MarketplaceSkillDetail) => void) | undefined;
  /** Opens an agent that the Marketplace added. `serverId` is the joined server, or absent for this computer. */
  onAgentInstalled?: ((agent: AddedAgent, serverId?: string) => void | Promise<void>) | undefined;
  plugins?: readonly MarketplacePluginDetail[] | undefined;
  /** The server that holds the MCP servers of an app. Absent: apps show, but do not connect. */
  pluginServerId?: string | undefined;
  /** The joined server that keeps an app's credential. Absent when this computer keeps it. */
  pluginHostName?: string | undefined;
  /** The joined server whose agents `agents` lists, when this account manages it. Absent: this computer. */
  hostServerId?: string | undefined;
  /** The joined server that a marketplace agent is added to. Absent: this computer. */
  agentServerId?: string | undefined;
  /** The joined server in `hostServerId` when its host also updates an agent. */
  agentUpdateServerId?: string | undefined;
  onRunPluginPrompt?: ((agentId: string, prompt: MarketplacePluginPrompt) => void) | undefined;
  /** This computer's GitHub connection, when it can have one. */
  githubConnector?: GitHubConnectorController | undefined;
  /** This computer's 1Password connection. Absent on a joined server. */
  onePasswordConnector?: OnePasswordConnectorController | undefined;
  bitwardenConnector?: BitwardenConnectorPanelProps | undefined;
  /** What the Marketplace calls. Absent: this computer's bridge. */
  calls?: MarketplaceCalls | undefined;
  /**
   * The host whose event check templates the Marketplace offers: `serverId` is the joined server, or
   * absent for this computer. Absent here: the host has no templates, and the tab is not shown.
   */
  eventChecksHost?: { serverId: string | undefined } | undefined;
}

/** The connect step of one app. `settle(null)` is a closed dialog. */
export interface PendingConnect {
  subject: McpConnectSubject;
  flow: McpConnectFlow;
  settle: (config: McpServerConfig | null) => void;
}

/** An agent that the Marketplace added or updated while it was open. "Open chat" opens it. */
interface AddedRecord {
  agent: AddedAgent;
  serverId: string | undefined;
}

/**
 * The Marketplace model on the real IPC, and the dialogs that the window shows over itself. The
 * install, connect and uninstall flows are the flows of the previous Marketplace, with their
 * analytics.
 */
export function createMarketplaceController(props: MarketplaceControllerProps) {
  const { t, format, sourceText } = useText();
  const calls = () => props.calls ?? desktopMarketplaceCalls();
  const skillCalls = () => calls().agentSkills(props.hostServerId);

  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal("");
  /** The actions in flight: `agent:<listing>`, `skill:<skill>` and `app:<app id>`. */
  const [busy, setBusy] = createStore<Record<string, true>>({});
  const mark = (key: string, on: boolean) =>
    setBusy((draft) => {
      if (on) draft[key] = true;
      else delete draft[key];
    });
  /** Awaits `work`. A rejection becomes the error sentence, and the answer is `undefined`. */
  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    try {
      return await work();
    } catch (cause) {
      setError(marketplaceErrorMessage(cause));
      return undefined;
    }
  }

  /* Agents. */

  const [added, setAdded] = createStore<Record<string, AddedRecord>>({});
  /** The user's copy of a listing: the one with an older version first. */
  function installation(listing: MarketplaceAgentSummary) {
    const copies = props.agents.filter((agent) => agent.marketplaceSource?.listingId === listing.id);
    return copies.find((agent) => (agent.marketplaceSource?.version ?? 0) < listing.version) ?? copies[0];
  }
  /* A joined server's agent is updated only when its host serves `agent-update-v1`. */
  const canUpdate = () => !props.hostServerId || props.agentUpdateServerId === props.hostServerId;
  function agentState(listing: MarketplaceAgentSummary): AgentListingState {
    if (added[listing.id]) return "added";
    const copy = installation(listing);
    if (!copy) return "add";
    return canUpdate() && (copy.marketplaceSource?.version ?? 0) < listing.version ? "update" : "added";
  }

  async function addAgent(listing: MarketplaceAgentDetail | MarketplaceAgentSummary, update = false) {
    const copy = update ? installation(listing) : undefined;
    if (copy && "versionId" in listing && copy.marketplaceSource?.versionId === listing.versionId) return true;
    const key = `agent:${listing.id}`;
    if (busy[key]) return false;
    const serverId = copy ? (props.hostServerId ? props.agentUpdateServerId : undefined) : props.agentServerId;
    const analytics = desktopAnalytics.scope();
    mark(key, true);
    const agent = await run(() =>
      calls().addAgent(
        {
          listingId: listing.id,
          ...(copy ? { agentId: copy.id } : {}),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          receiptId: crypto.randomUUID(),
        },
        serverId,
      ),
    );
    analytics.track("marketplace_action", {
      entity: "agent",
      action: copy ? "update" : "install",
      listing_slug: listing.id,
      result: agent ? "succeeded" : "failed",
      ...(agent ? {} : { failure_code: copy ? "update_failed" : "install_failed" }),
    });
    mark(key, false);
    if (!agent) return false;
    setAdded((draft) => {
      draft[listing.id] = { agent, serverId };
    });
    setNotice(t(copy ? "marketplace.notice.agentUpdated" : "marketplace.notice.agentAdded", { name: agent.name }));
    return true;
  }

  function openChat(listingId: string) {
    const record = added[listingId];
    const copy = props.agents.find((agent) => agent.marketplaceSource?.listingId === listingId);
    const target: AddedRecord | undefined =
      record ?? (copy ? { agent: { id: copy.id, name: copy.name }, serverId: props.hostServerId } : undefined);
    props.onOpenChange(false);
    if (target) void props.onAgentInstalled?.(target.agent, target.serverId);
  }

  async function loadAgent(id: string) {
    const analytics = desktopAnalytics.scope();
    const value = await run(() => calls().agents.get(id));
    analytics.track("marketplace_action", {
      entity: "agent",
      action: "view",
      listing_slug: id,
      result: value ? "succeeded" : "failed",
      ...(value ? {} : { failure_code: "load_failed" }),
    });
    return value;
  }

  /* Skills. Each agent's installed skills are read once, and again when its host reports a change. */

  const [skills, setSkills] = createStore<{
    read: Record<string, SkillRead>;
    installed: Record<string, InstalledSkill[]>;
  }>({ read: {}, installed: {} });
  /** The newest read of each agent, so a slow answer never replaces a newer one. */
  const skillReads = new Map<string, number>();
  const installedSkill = (agentId: string, skillId: string) =>
    skills.installed[agentId]?.find((skill) => skill.skillId === skillId);
  const agentName = (agentId: string) =>
    props.agents.find((agent) => agent.id === agentId)?.name ?? t("marketplace.thisAgent");

  async function readInstalled(agentId: string) {
    const request = (skillReads.get(agentId) ?? 0) + 1;
    skillReads.set(agentId, request);
    setSkills((draft) => {
      draft.read[agentId] = "loading";
    });
    try {
      const list = await skillCalls().listInstalled(agentId);
      if (skillReads.get(agentId) !== request) return;
      setSkills((draft) => {
        draft.installed[agentId] = list;
        draft.read[agentId] = "loaded";
      });
    } catch (cause) {
      if (skillReads.get(agentId) !== request) return;
      // A failed read is not an empty list: Try then names the failure, and install offers nothing.
      setSkills((draft) => {
        draft.read[agentId] = "failed";
      });
      setError(marketplaceErrorMessage(cause));
    }
  }

  function readSkills() {
    untrack(() => {
      for (const agent of props.agents) {
        const state = skills.read[agent.id] ?? "idle";
        if (state === "idle" || state === "failed") void readInstalled(agent.id);
      }
    });
  }

  /* The answers belong to one host. Another host starts again, and each read of the old one is dropped. */
  let skillHost = untrack(() => props.hostServerId);
  createEffect(
    () => [props.open, props.hostServerId, skillCalls()] as const,
    ([open, host, current]) => {
      if (host !== skillHost) {
        skillHost = host;
        for (const agentId of skillReads.keys()) skillReads.set(agentId, (skillReads.get(agentId) ?? 0) + 1);
        setSkills((draft) => {
          draft.read = {};
          draft.installed = {};
        });
      }
      if (!open || !current.onChanged) return;
      return current.onChanged((agentId) => {
        if ((skills.read[agentId] ?? "idle") !== "idle") void readInstalled(agentId);
      });
    },
  );

  /**
   * Installs the skill on each agent, or removes it, one agent at a time. A failure does not stop
   * the loop: each agent gets its try, and one sentence names the agents that did not change.
   */
  async function setSkill(
    skill: Pick<MarketplaceSkillSummary, "id" | "name">,
    agentIds: readonly string[],
    on: boolean,
  ) {
    const key = `skill:${skill.id}`;
    if (agentIds.length === 0 || busy[key]) return false;
    mark(key, true);
    setError(null);
    const failed: string[] = [];
    let reason = "";
    for (const agentId of agentIds) {
      const action = on ? (installedSkill(agentId, skill.id) ? "update" : "install") : "uninstall";
      const analytics = desktopAnalytics.scope();
      try {
        if (on) await skillCalls().install({ agentId, skillId: skill.id, replaceModified: false });
        else await skillCalls().uninstall({ agentId, skillId: skill.id });
        analytics.track("marketplace_action", {
          entity: "skill",
          action,
          listing_slug: skill.id,
          result: "succeeded",
        });
      } catch (cause) {
        failed.push(agentName(agentId));
        reason = marketplaceErrorMessage(cause);
        analytics.track("marketplace_action", {
          entity: "skill",
          action,
          listing_slug: skill.id,
          result: "failed",
          failure_code: `${action}_failed`,
        });
      }
      await readInstalled(agentId);
    }
    mark(key, false);
    const changed = agentIds.length - failed.length;
    if (changed > 0)
      setNotice(
        t(on ? "marketplace.notice.skillInstalled" : "marketplace.notice.skillRemoved", {
          name: skill.name,
          count: changed,
        }),
      );
    if (failed.length === 1 && agentIds.length === 1) setError(reason);
    else if (failed.length > 0)
      setError(t("marketplace.error.skillPartial", { name: skill.name, agents: format.list(failed), reason }));
    return failed.length === 0;
  }

  /** The installed skills with a newer version. A modified skill never has the state, so it is never counted. */
  const outdatedSkills = createMemo(() => {
    const found = new Map<string, { id: string; name: string; agentIds: string[] }>();
    for (const agent of props.agents)
      for (const skill of skills.installed[agent.id] ?? []) {
        if (skill.state !== "update-available" || (skill.origin !== undefined && skill.origin !== "marketplace"))
          continue;
        const entry = found.get(skill.skillId) ?? { id: skill.skillId, name: skill.name, agentIds: [] };
        entry.agentIds.push(agent.id);
        found.set(skill.skillId, entry);
      }
    return [...found.values()];
  });
  const [skillsUpdating, setSkillsUpdating] = createSignal(false);
  async function updateAllSkills() {
    const todo = outdatedSkills();
    if (todo.length === 0 || skillsUpdating()) return;
    setSkillsUpdating(true);
    const failed: string[] = [];
    for (const skill of todo) if (!(await setSkill(skill, skill.agentIds, true))) failed.push(skill.name);
    setSkillsUpdating(false);
    if (failed.length > 0) setError(t("marketplace.error.updateAllPartial", { skills: format.list(failed) }));
    else setNotice(t("marketplace.notice.skillsUpdated", { count: todo.length }));
  }

  async function loadSkill(id: string) {
    const analytics = desktopAnalytics.scope();
    const value = await run(() => calls().skills.get(id));
    analytics.track("marketplace_action", {
      entity: "skill",
      action: "view",
      listing_slug: id,
      result: value ? "succeeded" : "failed",
      ...(value ? {} : { failure_code: "load_failed" }),
    });
    return value;
  }

  /* Apps. */

  /**
   * The MCP servers the host holds, whole rather than by name: an uninstall removes a row by id, and
   * a name alone cannot say which row an app's name belongs to.
   */
  const [servers, setServers] = createSignal<readonly McpServerConfig[]>([]);
  /** The row this app installed as, or nothing: a name on its own is not enough to claim a row. */
  const heldApp = (app: MarketplacePluginApp) => servers().find((held) => isPluginAppConfig(held, app));
  /** The agent that a plugin's skills go to: the open conversation, else the first agent. */
  const pluginAgentId = () => props.activeAgentId || props.agents[0]?.id || "";
  const pluginSkillHeld = (skillId: string) => Boolean(installedSkill(pluginAgentId(), skillId));
  /** The rows of the host that are accounts of the plugin's apps. */
  const pluginRows = (plugin: MarketplacePluginDetail) =>
    servers().filter((row) => plugin.apps.some((app) => isPluginAppConfig(row, app)));
  /**
   * Connected when every app and skill is here and some account is turned on. An app whose accounts
   * are all off is disabled: no agent can use it, and "Connected" would say it can. Something left
   * from a partial install, or an account whose check failed, needs attention.
   */
  function pluginStatus(plugin: MarketplacePluginDetail): MarketplaceAppStatus {
    const parts = [
      ...plugin.apps.map((app) => Boolean(heldApp(app))),
      ...plugin.skills.map((skill) => pluginSkillHeld(skill.id)),
    ];
    if (parts.length === 0 || !parts.every(Boolean)) return parts.some(Boolean) ? "attention" : "idle";
    const rows = pluginRows(plugin);
    if (rows.length > 0 && rows.every((row) => !row.enabled)) return "disabled";
    if (rows.some((row) => row.enabled && checks[row.id]?.phase === "failed")) return "attention";
    return "connected";
  }

  /* Accounts. What the user can do with one account, without making a new connection. */

  /** The last check of each account. It describes the moment of the check, so nothing stores it. */
  const [checks, setChecks] = createStore<Record<string, MarketplaceAccountCheck>>({});
  const [justConnected, setJustConnected] = createSignal<{ appId: string; accountId: string } | null>(null);
  const listingAppOf = (plugin: MarketplacePluginDetail, row: McpServerConfig) =>
    plugin.apps.find((app) => isPluginAppConfig(row, app));
  /** A sign-in needs a host that can run one in a browser; a key needs only the host. */
  function reconnectKind(app: MarketplacePluginApp): MarketplaceAccount["reconnect"] {
    const flow = app.server.auth?.[0];
    if (flow?.kind === "key") return "key";
    if (flow?.kind !== "link") return null;
    return !props.hostServerId || calls().mcp.supportsRemoteSignIn?.() ? "sign-in" : null;
  }
  function accountsOf(plugin: MarketplacePluginDetail): MarketplaceAccount[] {
    return pluginRows(plugin).map((row) => {
      const listing = listingAppOf(plugin, row);
      return {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        renamable: row.id.startsWith("mcpacct-"),
        outdated: listing ? isOutdatedPluginAppConfig(row, listing) : false,
        reconnect: listing ? reconnectKind(listing) : null,
        check: checks[row.id] ?? { phase: "idle" },
      };
    });
  }

  const githubPanel = createMemo(() => {
    const connector = props.githubConnector;
    return connector ? githubPanelProps(connector) : undefined;
  });
  const onePasswordPanel = createMemo(() => {
    const connector = props.onePasswordConnector;
    return connector ? onePasswordPanelProps(connector) : undefined;
  });

  /** The catalog listings in the reader's language. Made once per language, not on each status change. */
  const localPlugins = createMemo(() => (props.plugins ?? []).map((plugin) => localizedPlugin(plugin, t)));

  const apps = createMemo((): MarketplaceApp[] => {
    const plugins = localPlugins();
    const github = props.githubConnector;
    const githubState = github?.status().state;
    return [
      ...(github
        ? [
            {
              kind: "github",
              id: "github",
              name: t("connector.github.title"),
              tagline: t("marketplace.app.githubTagline"),
              category: "coding",
              status:
                githubState === "connected"
                  ? "connected"
                  : githubState === "expired"
                    ? "attention"
                    : githubState === "pending"
                      ? "connecting"
                      : "idle",
            } satisfies MarketplaceApp,
          ]
        : []),
      ...(props.onePasswordConnector
        ? [
            {
              kind: "onepassword",
              id: "onepassword",
              name: t("connector.onePassword.title"),
              tagline: t("marketplace.app.onePasswordTagline"),
              category: "productivity",
              status: props.onePasswordConnector.status().state === "connected" ? "connected" : "idle",
            } satisfies MarketplaceApp,
          ]
        : []),
      ...(props.bitwardenConnector
        ? [
            {
              kind: "bitwarden",
              id: "bitwarden",
              name: t("connector.bitwarden.title"),
              tagline: t("connector.bitwarden.description"),
              category: "productivity",
              status: props.bitwardenConnector.status.connected ? "connected" : "idle",
            } satisfies MarketplaceApp,
          ]
        : []),
      ...plugins.map(
        (plugin): MarketplaceApp => ({
          kind: "plugin",
          id: plugin.slug,
          name: plugin.name,
          tagline: plugin.tagline,
          category: plugin.category,
          status: pluginStatus(plugin),
          accountCount: pluginRows(plugin).length,
          plugin,
        }),
      ),
      // A row that no catalog app claims is a server the user added, a token plugin's row among them.
      ...servers()
        .filter((server) => !plugins.some((plugin) => plugin.apps.some((app) => isPluginAppConfig(server, app))))
        .map(
          (server): MarketplaceApp => ({
            kind: "custom",
            id: `custom:${server.id}`,
            name: server.name,
            tagline: serverAddress(server),
            status: server.enabled ? "connected" : "disabled",
            server,
          }),
        ),
    ];
  });

  let serversRead = 0;
  /** The server whose MCP servers `servers` holds. Null before the first read ends. */
  const [serversReadFor, setServersReadFor] = createSignal<string | null>(null);
  /** The server whose first read failed. A later read that works clears it. */
  const [serversFailedFor, setServersFailedFor] = createSignal<string | null>(null);
  async function readServers(serverId: string) {
    const request = ++serversRead;
    if (untrack(serversReadFor) !== serverId) {
      // Another host starts again: the rows of the old one must not show as this host's apps.
      setServersReadFor(null);
      setServers([]);
    }
    setServersFailedFor(null);
    try {
      const configs = await calls().mcp.listMcpServers(serverId);
      if (request !== serversRead) return;
      setServers(configs);
      setServersReadFor(serverId);
    } catch (cause) {
      if (request !== serversRead) return;
      // A first read that fails is not an empty list: the apps say so and offer Retry. Rows that
      // were read before stay, and the failure of a later read is the banner.
      if (untrack(serversReadFor) === serverId) setError(marketplaceErrorMessage(cause));
      else setServersFailedFor(serverId);
    }
  }
  /**
   * How far the read of what the host holds got: its MCP servers and, for a plugin with skills, the
   * agent's skills. Before `loaded` an installed app reads as not connected, so Connect waits.
   */
  const appsRead = (): AppsRead => {
    const serverId = props.pluginServerId;
    if (!serverId) return "loaded";
    if (serversFailedFor() === serverId) return "failed";
    if (serversReadFor() !== serverId) return "loading";
    const agentId = pluginAgentId();
    if (!agentId || !props.plugins?.some((plugin) => plugin.skills.length > 0)) return "loaded";
    const skillsRead = skills.read[agentId];
    if (skillsRead === "failed") return "failed";
    return skillsRead === "loaded" ? "loaded" : "loading";
  };
  const appStatesRead = () => appsRead() === "loaded";
  function retryApps() {
    const serverId = props.pluginServerId;
    if (!serverId) return;
    void readServers(serverId);
    const agentId = pluginAgentId();
    if (agentId && skills.read[agentId] === "failed") void readInstalled(agentId);
  }
  /* The apps read the host's MCP servers while the window is open, and again for another host. */
  createEffect(
    () => (props.open ? props.pluginServerId : undefined),
    (serverId) => {
      if (serverId) void readServers(serverId);
    },
  );
  /* A plugin's status also reads the skills of the agent they go to. */
  createEffect(
    () => (props.open && props.plugins?.some((plugin) => plugin.skills.length > 0) ? pluginAgentId() : ""),
    (agentId) => {
      if (agentId && !untrack(() => skills.read[agentId])) void readInstalled(agentId);
    },
  );

  const [connecting, setConnecting] = createSignal<PendingConnect | null>(null);
  let signInController: AbortController | null = null;
  /** The listing the user asked to disconnect, held while the confirmation is on screen. */
  const [uninstalling, setUninstalling] = createSignal<MarketplacePluginDetail | null>(null);

  function connectStep(app: MarketplacePluginApp, config: McpServerConfig): Promise<McpServerConfig | null> {
    const flow = (app.server.auth ?? [])[0];
    if (!flow) return Promise.resolve(config);
    return new Promise((resolve) => {
      setConnecting({
        subject: { name: app.name, iconUrl: app.iconUrl, config },
        flow,
        settle: (answer) => {
          signInController?.abort();
          signInController = null;
          setConnecting(null);
          resolve(answer);
        },
      });
    });
  }

  function pluginAppServer(config: McpServerConfig): string {
    const invalid = Object.values(mcpConfigErrors(config))[0];
    if (invalid) throw new Error(invalid);
    if (servers().some((held) => held.id !== config.id && held.name === config.name))
      throw new Error(t("error.backend.mcpServerNameTaken", { name: config.name }));
    const serverId = props.pluginServerId;
    if (!serverId) throw new Error(t("marketplace.error.connectNoServer"));
    return serverId;
  }

  /** Test connects with the dialog-built config; nothing is saved by asking. */
  async function testPluginApp(config: McpServerConfig) {
    const serverId = pluginAppServer(config);
    return calls().mcp.testMcpServer({ config }, serverId);
  }

  /** A browser sign-in for a "link" listing: opens the browser when the server asks for one. */
  async function signInPluginApp(config: McpServerConfig) {
    const serverId = pluginAppServer(config);
    if (props.hostServerId && calls().mcp.supportsRemoteSignIn?.()) {
      signInController?.abort();
      signInController = new AbortController();
      return calls().mcp.signInMcpServer({ config }, serverId, signInController.signal);
    }
    return calls().mcp.signInMcpServer({ config }, serverId);
  }

  /** Takes back only what this attempt installed. A skill the agent already had is the user's. */
  async function undoSkills(agentId: string, skillIds: readonly string[]) {
    for (const skillId of skillIds)
      await skillCalls()
        .uninstall({ agentId, skillId })
        .catch(() => undefined);
  }

  /**
   * One install, both halves: the plugin's skills go to the agent, and its apps become MCP servers
   * on the host. The skills go first, so a failure never leaves a server standing that nothing
   * knows how to drive. If a later step fails, the skills this attempt installed are removed again.
   * False when nothing was installed, also when the user closed the connect step.
   */
  async function installPlugin(plugin: MarketplacePluginDetail): Promise<boolean> {
    const serverId = props.pluginServerId;
    if (!serverId) {
      setError(t("marketplace.error.installNoServer"));
      return false;
    }
    const agentId = pluginAgentId();
    if (plugin.skills.length > 0 && !agentId) {
      setError(t("marketplace.error.installNoAgent"));
      return false;
    }
    const hostOnly = plugin.apps.find(
      (app) =>
        app.server.auth?.[0]?.kind === "local" ||
        (app.server.auth?.[0]?.kind === "link" && !calls().mcp.supportsRemoteSignIn?.()),
    );
    if (props.hostServerId && hostOnly) {
      const key =
        hostOnly.server.auth?.[0]?.kind === "local"
          ? "marketplace.error.installLocalOnHost"
          : "marketplace.error.installOnHost";
      setError(t(key, { name: plugin.name }));
      return false;
    }
    const key = `app:${plugin.slug}`;
    if (busy[key]) return false;
    mark(key, true);
    const analytics = desktopAnalytics.scope();
    let connectedAccount: { appId: string; accountId: string } | null = null;
    const installed = await run(async () => {
      const addedSkills: string[] = [];
      try {
        for (const skill of plugin.skills) {
          const held = pluginSkillHeld(skill.id);
          await skillCalls().install({ agentId, skillId: skill.id, versionId: skill.versionId });
          if (!held) addedSkills.push(skill.id);
        }
        for (const app of plugin.apps) {
          const config = createPluginAppConfig(app);
          config.id = `mcpacct-${crypto.randomUUID()}`;
          let accountNumber = 1;
          while (servers().some((held) => held.name === `${app.name} — ${accountNumber}`)) accountNumber += 1;
          config.name = `${app.name} — ${accountNumber}`;
          const invalid = Object.values(mcpConfigErrors(config))[0];
          if (invalid) throw new Error(t("marketplace.error.appInvalid", { name: app.name, reason: invalid }));
          /* What is saved is the configuration that connected, not the one the listing describes:
             the credential the user typed, or the grant the sign-in returned, is part of it. */
          const connected = await connectStep(app, config);
          if (!connected) {
            // Closing the connect dialog is a decision, not a failure: it stops without a sentence.
            await undoSkills(agentId, addedSkills);
            return false;
          }
          setServers(await calls().mcp.saveMcpServer({ config: connected }, serverId));
          connectedAccount = { appId: plugin.slug, accountId: connected.id };
        }
      } catch (cause) {
        await undoSkills(agentId, addedSkills);
        throw cause;
      }
      return true;
    });
    // `false` is a closed connect dialog: the user's decision, not an install.
    if (installed !== false) {
      analytics.track("marketplace_action", {
        entity: "plugin",
        action: "install",
        result: installed ? "succeeded" : "failed",
        listing_slug: plugin.slug,
        ...(installed ? {} : { failure_code: "install_failed" }),
      });
    }
    /* Only on success: a read clears the error, which would take the failure off the screen before
       the reader saw it. */
    if (installed && plugin.skills.length > 0) await readInstalled(agentId);
    mark(key, false);
    if (installed) {
      setNotice(t("marketplace.notice.appConnected", { name: plugin.name }));
      /* The new account starts Off for every chat. The page offers one explicit step to allow it. */
      setJustConnected(connectedAccount);
      void chatAccess.refresh();
    }
    return installed === true;
  }

  /**
   * What a disconnect would really take, read from the host rather than from the listing. A plugin
   * can name two apps while the host holds one.
   */
  function uninstallPlan(plugin: MarketplacePluginDetail): PluginUninstallPlan {
    return {
      pluginName: plugin.name,
      appNames: plugin.apps.flatMap((app) =>
        servers()
          .filter((config) => isPluginAppConfig(config, app))
          .map((config) => config.name),
      ),
      skillSlugs: plugin.skills.filter((skill) => pluginSkillHeld(skill.id)).map((skill) => skill.slug),
      agentName: agentName(pluginAgentId()),
    };
  }

  /**
   * The install, undone: the apps first and the skills after. Every step is attempted, even after
   * one fails, and each failure is reported by name. The lists are read again either way, so the
   * page shows what the host and the agent really hold.
   */
  async function uninstallPlugin(plugin: MarketplacePluginDetail) {
    const serverId = props.pluginServerId;
    if (!serverId) {
      setError(t("marketplace.error.uninstallNoServer"));
      setUninstalling(null);
      return;
    }
    const agentId = pluginAgentId();
    const key = `app:${plugin.slug}`;
    mark(key, true);
    setError(null);
    const analytics = desktopAnalytics.scope();
    const failures: string[] = [];
    for (const app of plugin.apps) {
      for (const config of servers().filter((held) => isPluginAppConfig(held, app))) {
        try {
          setServers(await calls().mcp.removeMcpServer({ mcpServerId: config.id }, serverId));
        } catch (cause) {
          failures.push(`${config.name}: ${marketplaceErrorMessage(cause)}`);
        }
      }
    }
    if (agentId) {
      for (const skill of plugin.skills) {
        if (!pluginSkillHeld(skill.id)) continue;
        try {
          await skillCalls().uninstall({ agentId, skillId: skill.id });
        } catch (cause) {
          failures.push(`${skill.slug}: ${marketplaceErrorMessage(cause)}`);
        }
      }
    }
    setUninstalling(null);
    analytics.track("marketplace_action", {
      entity: "plugin",
      action: "uninstall",
      result: failures.length > 0 ? "failed" : "succeeded",
      listing_slug: plugin.slug,
      ...(failures.length > 0 ? { failure_code: "uninstall_failed" } : {}),
    });
    /* Read back before the failure is written: the reads clear the error, and a message set first
       would be taken off screen by the read that follows it. */
    await readServers(serverId);
    if (agentId && plugin.skills.length > 0) await readInstalled(agentId);
    mark(key, false);
    if (failures.length > 0)
      setError(t("marketplace.error.uninstallPartial", { name: plugin.name, failures: failures.join(" ") }));
    else setNotice(t("marketplace.notice.appDisconnected", { name: plugin.name }));
  }

  async function removeServer(id: string) {
    const serverId = props.pluginServerId;
    if (!serverId) {
      setError(t("marketplace.error.uninstallNoServer"));
      return false;
    }
    const name = servers().find((server) => server.id === id)?.name ?? "";
    const next = await run(() => calls().mcp.removeMcpServer({ mcpServerId: id }, serverId));
    if (!next) return false;
    setServers(next);
    setNotice(t("marketplace.notice.serverRemoved", { name }));
    return true;
  }

  /** The agents that hold every skill the plugin pins. A plugin without skills has none. */
  const pluginSkillAgents = (plugin: MarketplacePluginDetail) =>
    plugin.skills.length === 0
      ? []
      : props.agents
          .filter((agent) => plugin.skills.every((skill) => installedSkill(agent.id, skill.id)))
          .map((agent) => agent.id);

  /**
   * Installs the plugin's pinned skills on each chosen agent, or removes them, one agent at a time.
   * The app is host-global and its skills are per agent, so this is how a second agent gets the
   * instructions for an app that is already connected. A failure on one agent does not stop the rest.
   */
  async function setPluginSkills(app: MarketplaceApp, agentIds: readonly string[], on: boolean) {
    if (app.kind !== "plugin" || agentIds.length === 0) return false;
    const plugin = app.plugin;
    const key = `app:${plugin.slug}`;
    if (busy[key]) return false;
    mark(key, true);
    setError(null);
    const failed: string[] = [];
    let reason = "";
    for (const agentId of agentIds) {
      try {
        for (const skill of plugin.skills) {
          if (on) await skillCalls().install({ agentId, skillId: skill.id, versionId: skill.versionId });
          else if (installedSkill(agentId, skill.id)) await skillCalls().uninstall({ agentId, skillId: skill.id });
        }
      } catch (cause) {
        failed.push(agentName(agentId));
        reason = marketplaceErrorMessage(cause);
      }
      await readInstalled(agentId);
    }
    mark(key, false);
    const changed = agentIds.length - failed.length;
    if (changed > 0)
      setNotice(
        t(on ? "marketplace.notice.skillInstalled" : "marketplace.notice.skillRemoved", {
          name: plugin.name,
          count: changed,
        }),
      );
    if (failed.length > 0)
      setError(t("marketplace.error.skillPartial", { name: plugin.name, agents: format.list(failed), reason }));
    return failed.length === 0;
  }

  /* Account actions. Each acts on one row by its id, so the grants and the sign-in of the row stay. */

  const accountKey = (id: string) => `account:${id}`;
  /** The server that holds the accounts, or a sentence for why there is none. */
  function accountServer(): string | undefined {
    const serverId = props.pluginServerId;
    if (!serverId) setError(t("marketplace.error.accountNoServer"));
    return serverId;
  }
  const accountRow = (id: string) => servers().find((row) => row.id === id);
  const pluginOfRow = (row: McpServerConfig) =>
    localPlugins().find((plugin) => plugin.apps.some((app) => isPluginAppConfig(row, app)));
  const clearCheck = (id: string) =>
    setChecks((draft) => {
      delete draft[id];
    });

  async function setAccountEnabled(id: string, enabled: boolean) {
    const serverId = accountServer();
    const row = accountRow(id);
    const key = accountKey(id);
    if (!serverId || !row || busy[key]) return false;
    mark(key, true);
    const analytics = desktopAnalytics.scope();
    const next = await run(() => calls().mcp.setMcpServerEnabled({ mcpServerId: id, enabled }, serverId));
    const plugin = pluginOfRow(row);
    if (plugin)
      analytics.track("marketplace_action", {
        entity: "plugin",
        action: enabled ? "enable" : "disable",
        result: next ? "succeeded" : "failed",
        listing_slug: plugin.slug,
        ...(next ? {} : { failure_code: `${enabled ? "enable" : "disable"}_failed` }),
      });
    if (next) {
      setServers(next);
      clearCheck(id);
      setNotice(
        t(enabled ? "marketplace.notice.accountEnabled" : "marketplace.notice.accountDisabled", { name: row.name }),
      );
      /* The host drops the grants of a disabled account the next time it saves a chat's choices. */
      await chatAccess.refresh();
    }
    mark(key, false);
    return Boolean(next);
  }

  async function renameAccount(id: string, name: string) {
    const row = accountRow(id);
    const next = name.trim();
    const key = accountKey(id);
    if (!row || busy[key]) return false;
    if (next === row.name) return true;
    mark(key, true);
    const saved = await run(async () => {
      const config = { ...row, name: next };
      const serverId = pluginAppServer(config);
      return calls().mcp.saveMcpServer({ config }, serverId);
    });
    mark(key, false);
    if (!saved) return false;
    setServers(saved);
    setNotice(t("marketplace.notice.accountRenamed", { name: next }));
    await chatAccess.refresh();
    return true;
  }

  async function checkAccount(id: string) {
    const serverId = accountServer();
    const row = accountRow(id);
    if (!serverId || !row || checks[id]?.phase === "checking") return;
    setChecks((draft) => {
      draft[id] = { phase: "checking" };
    });
    let found: MarketplaceAccountCheck;
    try {
      const result = await calls().mcp.testMcpServer({ config: row }, serverId);
      found = result.error
        ? { phase: "failed", message: sourceText(result.error) }
        : { phase: "ok", toolCount: result.toolCount };
    } catch (cause) {
      found = { phase: "failed", message: marketplaceErrorMessage(cause) };
    }
    setChecks((draft) => {
      draft[id] = found;
    });
    setNotice(
      found.phase === "ok"
        ? t("marketplace.notice.accountChecked", { name: row.name, count: found.toolCount })
        : t("marketplace.notice.accountCheckFailed", { name: row.name }),
    );
  }

  /**
   * Signs in again, or takes a new key, for a row that already exists. The row keeps its id, so the
   * grants of its chats stay: a dead token does not mean "disconnect and add again".
   */
  async function reconnectAccount(app: MarketplaceApp, id: string) {
    const serverId = accountServer();
    const row = accountRow(id);
    const listing = app.kind === "plugin" && row ? listingAppOf(app.plugin, row) : undefined;
    const key = accountKey(id);
    if (!serverId || !row || !listing || busy[key]) return false;
    mark(key, true);
    const done = await run(async () => {
      const connected = await connectStep(listing, row);
      if (!connected) return false;
      /* A sign-in saves nothing but a new name; a new key is part of the row. */
      if (listing.server.auth?.[0]?.kind === "key" || connected.name !== row.name)
        setServers(await calls().mcp.saveMcpServer({ config: { ...connected, id: row.id } }, serverId));
      return true;
    });
    mark(key, false);
    if (done) {
      clearCheck(id);
      setNotice(t("marketplace.notice.accountReconnected", { name: row.name }));
    }
    return done === true;
  }

  /**
   * Moves every row of an earlier release of the app to the current listing, in place. A command is
   * tested first with the new words: a version that does not start would take the app away from
   * every agent. Nothing is saved after a failed test. A new address is not tested, because a sign-in
   * belongs to the old address and the test would only ask for one: the account then says so, and
   * "Sign in again" keeps its connection.
   */
  async function updateApp(app: MarketplaceApp) {
    const serverId = props.pluginServerId;
    if (app.kind !== "plugin" || !serverId) return false;
    const key = `app:${app.plugin.slug}`;
    if (busy[key]) return false;
    mark(key, true);
    const analytics = desktopAnalytics.scope();
    const updated = await run(async () => {
      let moved = 0;
      let signIn = false;
      for (const row of pluginRows(app.plugin)) {
        const listing = listingAppOf(app.plugin, row);
        if (!listing || !isOutdatedPluginAppConfig(row, listing)) continue;
        const config = updatedPluginAppConfig(row, listing);
        if (listing.server.transport === "stdio") {
          const result = await calls().mcp.testMcpServer({ config }, serverId);
          if (result.error)
            throw new Error(t("marketplace.error.updateFailed", { name: row.name, reason: sourceText(result.error) }));
        } else signIn = true;
        setServers(await calls().mcp.saveMcpServer({ config }, serverId));
        clearCheck(row.id);
        moved += 1;
      }
      return { moved, signIn };
    });
    analytics.track("marketplace_action", {
      entity: "plugin",
      action: "update",
      result: updated === undefined ? "failed" : "succeeded",
      listing_slug: app.plugin.slug,
      ...(updated === undefined ? { failure_code: "update_failed" } : {}),
    });
    mark(key, false);
    if (updated !== undefined)
      setNotice(
        t(updated.signIn ? "marketplace.notice.appUpdatedSignIn" : "marketplace.notice.appUpdated", {
          name: app.plugin.name,
          count: updated.moved,
        }),
      );
    return updated !== undefined;
  }

  /* Chat access. Which agent's chat may use which account. */

  const [grants, setGrants] = createStore<{
    snapshots: Record<string, McpChatSnapshot>;
    read: Record<string, SkillRead>;
    errors: Record<string, string>;
    saving: { agentId: string; accountId: string; mode: ChatAccessMode } | null;
  }>({ snapshots: {}, read: {}, errors: {}, saving: null });
  /** The newest read of each agent, so a slow answer never replaces a newer one. */
  const grantReads = new Map<string, number>();
  const chatApi = () => (props.pluginServerId ? calls().chatApps?.(props.pluginServerId) : undefined);

  async function readGrants(agentId: string) {
    const api = chatApi();
    if (!api) return;
    const request = (grantReads.get(agentId) ?? 0) + 1;
    grantReads.set(agentId, request);
    setGrants((draft) => {
      draft.read[agentId] = "loading";
    });
    try {
      const snapshot = await api.get({ kind: "agent", id: agentId });
      if (grantReads.get(agentId) !== request) return;
      setGrants((draft) => {
        draft.snapshots[agentId] = snapshot;
        draft.read[agentId] = "loaded";
        delete draft.errors[agentId];
      });
    } catch (cause) {
      if (grantReads.get(agentId) !== request) return;
      // A failed read is not "Off for everything": the controls stay away, and the section names the
      // failure with Retry. A host without chat permissions answers every read with a refusal, so it
      // is not a banner on every app page.
      setGrants((draft) => {
        draft.read[agentId] = "failed";
        draft.errors[agentId] = marketplaceErrorMessage(cause);
      });
    }
  }

  const chatAccess = {
    supported: () => chatApi() !== undefined && props.agents.length > 0,
    read() {
      untrack(() => {
        for (const agent of props.agents) {
          const state = grants.read[agent.id] ?? "idle";
          if (state === "idle" || state === "failed") void readGrants(agent.id);
        }
      });
    },
    /** Reads each agent again, such as after an account was turned off or renamed. */
    async refresh() {
      if (!chatApi()) return;
      await Promise.all(
        untrack(() => props.agents)
          .filter((agent) => untrack(() => grants.read[agent.id]) !== undefined)
          .map((agent) => readGrants(agent.id)),
      );
    },
    readState: (agentId: string): SkillRead => grants.read[agentId] ?? "idle",
    readError: (agentId: string) => grants.errors[agentId] ?? "",
    listed: (agentId: string, accountId: string) =>
      grants.snapshots[agentId]?.connections.some((connection) => connection.id === accountId) === true,
    mode: (agentId: string, accountId: string): ChatAccessMode =>
      grants.snapshots[agentId]?.grants.find((grant) => grant.connectionId === accountId)?.mode ?? "off",
    saving: () => grants.saving,
    /**
     * Sets what one agent's chat may do with one account. The chat's whole policy is replaced on the
     * host, so the current policy is read again first: another window may have changed it. The host
     * then refreshes every agent runtime, which is why the controls wait and the page says so.
     */
    async setMode(agentId: string, accountId: string, mode: ChatAccessMode) {
      const api = chatApi();
      if (!api || grants.saving) return false;
      const name = accountRow(accountId)?.name ?? "";
      setGrants((draft) => {
        draft.saving = { agentId, accountId, mode };
      });
      const next = await run(async () => {
        const target = { kind: "agent", id: agentId } as const;
        const current = await api.get(target);
        if (!current.connections.some((connection) => connection.id === accountId))
          throw new Error(t("marketplace.error.accessGone", { name }));
        const kept = current.grants.filter((grant) => grant.connectionId !== accountId);
        return api.save(target, mode === "off" ? kept : [...kept, { connectionId: accountId, mode }]);
      });
      setGrants((draft) => {
        draft.saving = null;
        if (next) {
          grantReads.set(agentId, (grantReads.get(agentId) ?? 0) + 1);
          draft.snapshots[agentId] = next;
          draft.read[agentId] = "loaded";
        }
      });
      if (next)
        setNotice(
          t("marketplace.notice.accessSet", {
            agent: agentName(agentId),
            account: name,
            mode: t(ACCESS_MODE_LABEL[mode]),
          }),
        );
      return Boolean(next);
    },
  } satisfies MarketplaceChatAccess & { refresh: () => Promise<void> };

  /* The grants belong to one host. Another host starts again, and each read of the old one is dropped. */
  let grantHost = untrack(() => props.pluginServerId);
  createEffect(
    () => props.pluginServerId,
    (host) => {
      if (host === grantHost) return;
      grantHost = host;
      for (const agentId of grantReads.keys()) grantReads.set(agentId, (grantReads.get(agentId) ?? 0) + 1);
      setGrants((draft) => {
        draft.snapshots = {};
        draft.read = {};
        draft.errors = {};
        draft.saving = null;
      });
    },
  );

  function openPluginUrl(url: string) {
    const safe = safeBrowserUrl(url);
    if (!safe) return;
    void calls()
      .openUrl(safe)
      .catch(() => setError(t("marketplace.error.openLink")));
  }

  /* The address is built from the slug rather than read from `shareUrl`, so what is copied is what the route answers. */
  function copyLink(slug: string) {
    void Promise.resolve()
      .then(() => writeClipboardText(createPluginShareUrl(slug)))
      .catch(() => setError(t("marketplace.error.copyLink")));
  }

  /* The connect step and the confirmation are siblings of the window. Closing the window stops them. */
  const stopDialogs = () => {
    untrack(connecting)?.settle(null);
    setUninstalling(null);
    setJustConnected(null);
  };
  createEffect(
    () => props.open,
    (open) => {
      if (!open) stopDialogs();
    },
  );
  onCleanup(() => untrack(connecting)?.settle(null));

  /* One object for as long as the host stays, because a page keys what it reads on it. */
  const eventChecks = createMemo(() => {
    const host = props.eventChecksHost;
    return host ? calls().eventChecks?.(host.serverId) : undefined;
  });

  const model: MarketplaceModel = {
    listAgents: async (query) => {
      const page = await calls().agents.list(query);
      return { items: page.agents, nextCursor: page.nextCursor };
    },
    get agentHomeCache() {
      return agentHomeCache(calls());
    },
    loadAgent,
    agentState,
    agentBusy: (listingId) => Boolean(busy[`agent:${listingId}`]),
    addAgent,
    openChat,

    listSkills: async (query) => {
      const page = await calls().skills.list(query);
      return { items: page.skills, nextCursor: page.nextCursor };
    },
    get skillHomeCache() {
      return skillHomeCache(calls());
    },
    loadSkill,
    agents: () => props.agents,
    activeAgentId: () => props.activeAgentId,
    readSkills,
    skillRead: (agentId) => skills.read[agentId] ?? "idle",
    installedSkill,
    skillBusy: (skillId) => Boolean(busy[`skill:${skillId}`]),
    setSkill,
    outdatedSkills,
    updateAllSkills,
    skillsUpdating,
    get trySkill() {
      return props.onTrySkill;
    },

    apps,
    canConnectApps: () => Boolean(props.pluginServerId),
    appsRead,
    retryApps,
    appBusy: (id) => Boolean(busy[`app:${id}`]),
    pluginSkillAgents: (app) => (app.kind === "plugin" ? pluginSkillAgents(app.plugin) : []),
    setPluginSkills,
    connectApp: async (app) => {
      if (app.kind === "plugin") return installPlugin(app.plugin);
      if (app.kind === "github") props.githubConnector?.connect();
      return false;
    },
    appConnections: (app) =>
      app.kind === "plugin" ? accountsOf(localPlugins().find((plugin) => plugin.slug === app.id) ?? app.plugin) : [],
    accountBusy: (id) => Boolean(busy[accountKey(id)]),
    setAccountEnabled,
    renameAccount,
    checkAccount,
    reconnectAccount,
    updateApp,
    justConnected,
    dismissJustConnected: () => setJustConnected(null),
    chatAccess,
    disconnectApp: (app) => {
      if (app.kind === "plugin") setUninstalling(app.plugin);
      if (app.kind === "github") props.githubConnector?.disconnect();
      if (app.kind === "bitwarden") props.bitwardenConnector?.onDisconnect();
      if (app.kind === "onepassword") props.onePasswordConnector?.disconnect();
    },
    removeServer,
    get runPrompt() {
      const run = props.onRunPluginPrompt;
      const agentId = pluginAgentId();
      return run && agentId ? (prompt: MarketplacePluginPrompt) => run(agentId, prompt) : undefined;
    },
    copyLink,
    openUrl: openPluginUrl,
    get github() {
      const panel = githubPanel();
      return panel ? () => panel : undefined;
    },
    get bitwarden() {
      const panel = props.bitwardenConnector;
      return panel ? () => panel : undefined;
    },
    get onePassword() {
      const panel = onePasswordPanel();
      return panel ? () => panel : undefined;
    },

    get eventChecks() {
      return eventChecks();
    },

    error,
    clearError: () => setError(null),
    notice,
  };

  return {
    model,
    appStatesRead,
    connecting,
    uninstalling,
    uninstallPlan,
    uninstallPlugin,
    uninstallBusy: (plugin: MarketplacePluginDetail) => Boolean(busy[`app:${plugin.slug}`]),
    cancelUninstall: () => setUninstalling(null),
    testPluginApp,
    signInPluginApp,
    openPluginUrl,
  };
}
