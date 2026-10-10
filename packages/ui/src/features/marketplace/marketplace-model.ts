import type {
  AgentSummary,
  InstalledSkill,
  MarketplaceAgentDetail,
  MarketplaceAgentSummary,
  MarketplaceSkillDetail,
  MarketplaceSkillSummary,
  McpServerConfig,
  SkillCategory,
} from "@openbot/contracts/ipc";
import type { BitwardenConnectorPanelProps } from "../settings/BitwardenConnectorPanel";
import type { GitHubConnectorPanelProps } from "../settings/GitHubConnectorPanel";
import type { MarketplacePluginDetail, MarketplacePluginPrompt } from "../settings/marketplace-plugins";
import type { OnePasswordConnectorPanelProps } from "../settings/OnePasswordConnectorPanel";
import type { MarketplaceEventChecks } from "./marketplace-event-checks";
import type { CatalogList, MarketplaceHomeCache } from "./marketplace-listing";

/** An agent of the user's that a skill can go to. */
export type MarketplaceAgent = Pick<AgentSummary, "id" | "name" | "avatarSeed" | "avatarHue" | "avatarUrl">;

/** What an agent listing offers the user. */
export type AgentListingState = "add" | "added" | "update";

/** How far the read of one agent's installed skills got. An empty list is an answer only when `loaded`. */
export type SkillRead = "idle" | "loading" | "loaded" | "failed";

/**
 * How far the read of the apps that the host holds got. Before `loaded`, an installed app reads as
 * not connected, so nothing may offer Connect: it would add a second account.
 */
export type AppsRead = "loading" | "loaded" | "failed";

/**
 * `disabled`: the host holds the app, and every account of it is turned off. No agent can use it.
 * `attention`: something is left from a partial install, or a check of an account failed.
 * `connecting`: a sign-in that the user started is waiting for the service.
 * `unknown`: this account cannot read what the host holds, so the app is neither connected nor not.
 */
export type MarketplaceAppStatus = "connected" | "attention" | "disabled" | "idle" | "connecting" | "unknown";

interface AppBase {
  id: string;
  name: string;
  /** The line under the name on the card. */
  tagline: string;
  status: MarketplaceAppStatus;
  /** How many accounts of the app the host holds. Absent for an app that has no accounts. */
  accountCount?: number;
}

/** What the last check of an account found. Nothing stores it: it describes the moment of the check. */
export type MarketplaceAccountCheck =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "ok"; toolCount: number }
  | { phase: "failed"; message: string };

/** One connection of an app to an account of the service, as the host holds it. */
export interface MarketplaceAccount {
  id: string;
  name: string;
  /** A disabled account offers no tool to any chat. */
  enabled: boolean;
  /** An account the user named. A row that the listing names by name keeps that name. */
  renamable: boolean;
  /** The row still reaches the server as an earlier release of the listing did. */
  outdated: boolean;
  /** How to get this account working again without a new connection: sign in again, or give a new key. */
  reconnect: "sign-in" | "key" | null;
  check: MarketplaceAccountCheck;
}

/** What a chat may do with an account. */
export type ChatAccessMode = "off" | "read" | "write";

/**
 * The per-chat permissions of the accounts, for each agent's chat. A host that cannot limit apps per
 * chat reports `supported` false, and the page shows no controls: every agent then has every account.
 * A grant is an authorization, so `setMode` runs only from a click on a mode.
 */
export interface MarketplaceChatAccess {
  supported: () => boolean;
  /** Reads the permissions of each agent that has no fresh answer. */
  read: () => void;
  readState: (agentId: string) => SkillRead;
  /** Why the last read of an agent failed, in the host's words. Empty when none failed. */
  readError: (agentId: string) => string;
  /** Whether the host offers the account to this agent's chat. False until the agent was read. */
  listed: (agentId: string, accountId: string) => boolean;
  mode: (agentId: string, accountId: string) => ChatAccessMode;
  /** Saves one change. The host then refreshes its agents, so the answer can take a while. */
  setMode: (agentId: string, accountId: string, mode: ChatAccessMode) => Promise<boolean>;
  /** The change that is being saved. Every control waits for it. */
  saving: () => { agentId: string; accountId: string; mode: ChatAccessMode } | null;
}

/**
 * One row of the Apps tab: a catalog app, the GitHub connector, or an MCP server that the host
 * holds and no catalog app claims.
 */
export type MarketplaceApp =
  | (AppBase & { kind: "plugin"; category: SkillCategory; plugin: MarketplacePluginDetail })
  | (AppBase & { kind: "github"; category: SkillCategory })
  | (AppBase & { kind: "onepassword"; category: SkillCategory })
  | (AppBase & { kind: "bitwarden"; category: SkillCategory })
  | (AppBase & { kind: "custom"; server: McpServerConfig });

/**
 * What the Marketplace view reads and asks for. The renderer builds it from its IPC calls, and a
 * story builds it from fixtures. Each action reports its own failure through `error`.
 */
export interface MarketplaceModel {
  listAgents: CatalogList<MarketplaceAgentSummary>;
  agentHomeCache?: MarketplaceHomeCache<MarketplaceAgentSummary> | undefined;
  loadAgent: (id: string) => Promise<MarketplaceAgentDetail | undefined>;
  /** Null when this user cannot add agents. */
  agentState: (listing: MarketplaceAgentSummary) => AgentListingState | null;
  agentBusy: (listingId: string) => boolean;
  /** Adds the agent, or updates the one the user has when `update` is set. The Marketplace stays open. */
  addAgent: (listing: MarketplaceAgentDetail | MarketplaceAgentSummary, update?: boolean) => Promise<boolean>;
  /** Opens the conversation of the agent that the listing added, and closes the Marketplace. */
  openChat: (listingId: string) => void;

  listSkills: CatalogList<MarketplaceSkillSummary>;
  skillHomeCache?: MarketplaceHomeCache<MarketplaceSkillSummary> | undefined;
  loadSkill: (id: string) => Promise<MarketplaceSkillDetail | undefined>;
  /** The agents a skill can go to. Empty when this user cannot install skills. */
  agents: () => readonly MarketplaceAgent[];
  /** The agent whose conversation is open. */
  activeAgentId: () => string;
  /** Reads the installed skills of each agent that has no fresh answer. */
  readSkills: () => void;
  skillRead: (agentId: string) => SkillRead;
  installedSkill: (agentId: string, skillId: string) => InstalledSkill | undefined;
  skillBusy: (skillId: string) => boolean;
  /** Installs the skill on each agent, or removes it, one agent at a time. True when every agent changed. */
  setSkill: (
    skill: Pick<MarketplaceSkillSummary, "id" | "name">,
    agentIds: readonly string[],
    on: boolean,
  ) => Promise<boolean>;
  /**
   * The installed skills that have a newer version, with the agents that hold the old one. It reads
   * what the agents hold, whichever page of the catalog is loaded. A modified skill is left out.
   */
  outdatedSkills: () => readonly { id: string; name: string; agentIds: readonly string[] }[];
  /** Updates each of them. A failure on one does not stop the others. */
  updateAllSkills: () => Promise<void>;
  skillsUpdating: () => boolean;
  /** Absent while no composer can take the example. */
  trySkill?: ((agentId: string, skill: MarketplaceSkillDetail) => void) | undefined;

  apps: () => readonly MarketplaceApp[];
  /** The accounts of an app on the host. Empty for an app that has none. */
  appConnections: (app: MarketplaceApp) => readonly MarketplaceAccount[];
  /** The agents that hold every skill that the plugin pins. */
  pluginSkillAgents: (app: MarketplaceApp) => readonly string[];
  /** Installs the plugin's pinned skills on each agent, or removes them. True when every agent changed. */
  setPluginSkills: (app: MarketplaceApp, agentIds: readonly string[], on: boolean) => Promise<boolean>;
  /** Whether an action on the account is running. */
  accountBusy: (accountId: string) => boolean;
  /** Turns an account on or off for every agent. */
  setAccountEnabled: (accountId: string, enabled: boolean) => Promise<boolean>;
  /** Renames an account. The id stays, so the grants of the account stay. */
  renameAccount: (accountId: string, name: string) => Promise<boolean>;
  /** Connects once with the stored credentials and keeps what it found. */
  checkAccount: (accountId: string) => Promise<void>;
  /** Signs in again, or takes a new key, for the same account. Its id and grants stay. */
  reconnectAccount: (app: MarketplaceApp, accountId: string) => Promise<boolean>;
  /** Moves each account that reaches an earlier release of the app to the current one. */
  updateApp: (app: MarketplaceApp) => Promise<boolean>;
  /** The account that was just connected in this window, until the user has chosen what the agent may do with it. */
  justConnected: () => { appId: string; accountId: string } | null;
  dismissJustConnected: () => void;
  chatAccess: MarketplaceChatAccess;
  /** False for a member of a joined server, who browses and connects nothing. */
  canConnectApps: () => boolean;
  /**
   * Whether the list of apps that the host holds was read. Connect waits for `loaded`, so an app
   * that is already connected is not connected a second time.
   */
  appsRead: () => AppsRead;
  /** Reads the apps of the host again after a failed read. */
  retryApps: () => void;
  /** The name of the server that holds the apps, for a sentence. Absent when this computer holds them. */
  appsHostName?: (() => string | undefined) | undefined;
  appBusy: (id: string) => boolean;
  /** Runs the connect step of the app. False when the user closed it. */
  connectApp: (app: MarketplaceApp) => Promise<boolean>;
  /** Asks for a confirmation, then removes what the app installed. */
  disconnectApp: (app: MarketplaceApp) => void;
  /** Removes a custom MCP server. */
  removeServer: (id: string) => Promise<boolean>;
  runPrompt?: ((prompt: MarketplacePluginPrompt) => void) | undefined;
  copyLink: (slug: string) => void;
  openUrl: (url: string) => void;
  /** The GitHub connector page, when this computer has one. */
  github?: (() => GitHubConnectorPanelProps) | undefined;
  /** The 1Password connector page, on the computer that runs OpenBot. */
  onePassword?: (() => OnePasswordConnectorPanelProps) | undefined;
  bitwarden?: (() => BitwardenConnectorPanelProps) | undefined;

  /**
   * The event check templates and checks of the host. Absent when the host has none: the
   * Event checks tab is then not shown.
   */
  eventChecks?: MarketplaceEventChecks | undefined;

  /** The last failure, as a sentence. */
  error: () => string | null;
  clearError: () => void;
  /** The last result, for a screen reader. */
  notice: () => string;
}
