import type { AppTextKey } from "@openbot/i18n";
import {
  AppWindow,
  Archive,
  ArrowLeftRight,
  Bell,
  Blocks,
  Bot,
  CalendarClock,
  CircleArrowDown,
  CircleDollarSign,
  CreditCard,
  Download,
  Globe2,
  HardDrive,
  Hash,
  KeyRound,
  Mic,
  Monitor,
  MousePointer2,
  Palette,
  PanelTop,
  Plug,
  RefreshCw,
  Settings,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserRound,
  UsersRound,
} from "@openbot/ui";
import type { ServerSettingsSection } from "../servers/server-settings-target";
import type { SettingsTab } from "./settings-tabs";

/**
 * The one Settings page lists every setting in one navigation, grouped by what it affects rather
 * than by where it is kept: the account and this device first, then the workspace, the agents, the
 * connections, the server, and the money. An item is the account's (`personal`: a tab of the app or
 * web settings), the server's (`server`: a section of the server settings) or a way to a view that
 * lives elsewhere (`action`). Which items show depends on the role and on what the host offers: the
 * callers filter the list; this module only orders it.
 */
export type SettingsNavGroup = "you" | "workspace" | "agents" | "connections" | "server" | "money";

export const SETTINGS_NAV_GROUPS: readonly { id: SettingsNavGroup; titleKey: AppTextKey }[] = [
  { id: "you", titleKey: "settings.group.you" },
  { id: "workspace", titleKey: "settings.group.workspace" },
  { id: "agents", titleKey: "server.settings.group.agents" },
  { id: "connections", titleKey: "settings.group.connections" },
  { id: "server", titleKey: "settings.group.server" },
  { id: "money", titleKey: "server.settings.group.money" },
];

/** The web account tabs, which the desktop names differently (`general` holds the look there). */
export type WebAccountTab = "profile" | "appearance" | "notifications";

export type SettingsNavItem =
  | {
      kind: "personal";
      id: SettingsTab | WebAccountTab;
      group: SettingsNavGroup;
      titleKey: AppTextKey;
      icon: typeof Settings;
      deviceOnly?: boolean;
    }
  | { kind: "server"; id: ServerSettingsSection; group: SettingsNavGroup; titleKey: AppTextKey; icon: typeof Settings }
  | {
      kind: "action";
      id: SettingsActionId;
      group: SettingsNavGroup;
      titleKey: AppTextKey;
      icon: typeof Settings;
    };

/** The views outside the settings pages that the list leads to. */
export type SettingsActionId = "money" | "billing" | "secrets";

/** The account's and the device's items, in order. `deviceOnly` marks what only this computer or browser keeps. */
export const PERSONAL_NAV_ITEMS: readonly Extract<SettingsNavItem, { kind: "personal" }>[] = [
  { kind: "personal", id: "profile", group: "you", titleKey: "settings.tab.profile.title", icon: UserRound },
  {
    kind: "personal",
    id: "general",
    group: "you",
    titleKey: "settings.tab.general.title",
    icon: Settings,
    deviceOnly: true,
  },
  {
    kind: "personal",
    id: "appearance",
    group: "you",
    titleKey: "webClient.settings.appearance.title",
    icon: Palette,
    deviceOnly: true,
  },
  {
    kind: "personal",
    id: "notifications",
    group: "you",
    titleKey: "settings.tab.notifications.title",
    icon: Bell,
    deviceOnly: true,
  },
  { kind: "personal", id: "voice", group: "you", titleKey: "settings.tab.voice.title", icon: Mic, deviceOnly: true },
  {
    kind: "personal",
    id: "dynamic-island",
    group: "you",
    titleKey: "settings.tab.dynamicIsland.title",
    icon: PanelTop,
    deviceOnly: true,
  },
  {
    kind: "personal",
    id: "computer-use",
    group: "you",
    titleKey: "settings.tab.computerUse.title",
    icon: MousePointer2,
    deviceOnly: true,
  },
  {
    kind: "personal",
    id: "mobile-connect",
    group: "you",
    titleKey: "settings.tab.mobileConnect.title",
    icon: Smartphone,
    deviceOnly: true,
  },
  {
    kind: "personal",
    id: "updates",
    group: "you",
    titleKey: "settings.tab.updates.title",
    icon: CircleArrowDown,
    deviceOnly: true,
  },
  { kind: "personal", id: "billing", group: "money", titleKey: "settings.tab.billing.title", icon: CreditCard },
  {
    kind: "personal",
    id: "agents",
    group: "agents",
    titleKey: "settings.tab.agents.title",
    icon: Bot,
    deviceOnly: true,
  },
];

/** The server's sections, each in the group of what it affects. */
export const SERVER_NAV_ITEMS: readonly Extract<SettingsNavItem, { kind: "server" }>[] = [
  { kind: "server", id: "general", group: "workspace", titleKey: "server.settings.generalTitle", icon: Settings },
  { kind: "server", id: "members", group: "workspace", titleKey: "server.settings.membersTitle", icon: UsersRound },
  { kind: "server", id: "roles", group: "workspace", titleKey: "server.settings.rolesTitle", icon: ShieldCheck },
  { kind: "server", id: "workspace", group: "workspace", titleKey: "server.settings.workspaceTitle", icon: Hash },
  { kind: "server", id: "providers", group: "agents", titleKey: "server.settings.providersTitle", icon: Sparkles },
  { kind: "server", id: "routines", group: "agents", titleKey: "server.settings.routinesTitle", icon: CalendarClock },
  { kind: "server", id: "import", group: "agents", titleKey: "server.settings.importTitle", icon: Download },
  { kind: "server", id: "browser-profiles", group: "agents", titleKey: "browser.profiles.title", icon: AppWindow },
  { kind: "server", id: "vault", group: "connections", titleKey: "server.settings.vaultTitle", icon: KeyRound },
  { kind: "server", id: "connectors", group: "connections", titleKey: "server.settings.connectorsTitle", icon: Plug },
  { kind: "server", id: "mcp", group: "connections", titleKey: "server.settings.mcpTitle", icon: Blocks },
  { kind: "server", id: "desktop", group: "connections", titleKey: "server.settings.desktopTitle", icon: Monitor },
  { kind: "server", id: "sites", group: "server", titleKey: "server.settings.hostedSitesTitle", icon: Globe2 },
  { kind: "server", id: "storage", group: "server", titleKey: "server.settings.storageTitle", icon: HardDrive },
  { kind: "server", id: "updates", group: "server", titleKey: "server.settings.updatesTitle", icon: RefreshCw },
  { kind: "server", id: "backups", group: "server", titleKey: "backups.sectionTitle", icon: Archive },
  { kind: "server", id: "transfer", group: "server", titleKey: "server.settings.transferTitle", icon: ArrowLeftRight },
];

/** The ways to views that live outside the settings pages. */
export const ACTION_NAV_ITEMS: readonly Extract<SettingsNavItem, { kind: "action" }>[] = [
  // The keys and passwords screen of the host, for the owner and the admins.
  { kind: "action", id: "secrets", group: "connections", titleKey: "workspace.view.secrets", icon: KeyRound },
  { kind: "action", id: "money", group: "money", titleKey: "server.settings.shortcut.money", icon: CircleDollarSign },
  { kind: "action", id: "billing", group: "money", titleKey: "account.menu.billing", icon: CreditCard },
];

/** The same item, by kind and id. */
export function sameNavItem(
  a: Pick<SettingsNavItem, "kind" | "id"> | null,
  b: Pick<SettingsNavItem, "kind" | "id">,
): boolean {
  return a !== null && a.kind === b.kind && a.id === b.id;
}

/**
 * The items a page shows, in the order of the groups, from the personal tabs it has, the server
 * sections the host offers, and the actions it can run. The order inside a group follows the lists above.
 */
export function settingsNavItems(options: {
  personal: ReadonlyArray<SettingsTab | WebAccountTab>;
  server: ReadonlyArray<ServerSettingsSection>;
  actions: ReadonlyArray<SettingsActionId>;
}): SettingsNavItem[] {
  const items: SettingsNavItem[] = [
    ...PERSONAL_NAV_ITEMS.filter((item) => options.personal.includes(item.id)),
    ...SERVER_NAV_ITEMS.filter((item) => options.server.includes(item.id)),
    ...ACTION_NAV_ITEMS.filter((item) => options.actions.includes(item.id)),
  ];
  const order = SETTINGS_NAV_GROUPS.map((group) => group.id);
  return items.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}
