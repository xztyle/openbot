import { EVENT_CHECKS_CAPABILITY } from "@openbot/contracts/team-protocol/event-checks-v1";
import type { AppTextKey } from "@openbot/i18n";
import {
  ArrowLeftRight,
  Bell,
  Blocks,
  BookMarked,
  Bot,
  CalendarClock,
  Download,
  Folder,
  Gauge,
  Globe2,
  HardDrive,
  Hash,
  KeyRound,
  Monitor,
  Plug,
  Puzzle,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Store,
  UsersRound,
} from "@openbot/ui";
import type {
  GlobalSearchAction,
  GlobalSearchFile,
  GlobalSearchPage,
  GlobalSearchRoutine,
} from "@openbot/ui/components/GlobalSearch";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal } from "solid-js";
import { formatMessageTime } from "./app-message-projection";
import { appPort } from "./app-port";
import { useAgents } from "./features/agents/agents-context";
import { useChannels } from "./features/channels/channels-context";
import { globalSearchChannels } from "./features/channels/global-search-channels";
import type { AgentSettingsPage } from "./features/conversation/conversation-types";
import { serverHasStorage } from "./features/files/storage-usage";
import type { ServerSettingsSection } from "./features/servers/ServerSettingsModal";
import { serverCanAdminister } from "./features/servers/server-capabilities";
import { useServerSettings } from "./features/servers/server-settings";
import { availableServerSettingsSections } from "./features/servers/server-settings-sections";
import { useServers } from "./features/servers/servers-context";
import { useSettings } from "./features/settings/settings-context";
import { dynamicIslandSettingsShown, navItems } from "./features/settings/settings-tabs";
import { useUsage } from "./features/usage/usage-context";
import { keyboardShortcuts } from "./global-search-shortcut";
import { useNavigation } from "./navigation";
import { usePlatform } from "./platform";
import { useProviders } from "./providers";
import { currentDevicePlatform } from "./send-shortcut-preference";

const FILE_SEARCH_LIMIT = 50;

/**
 * One search result for each server settings section. The keywords are words that a person types for
 * what the section holds, in English, which also finds the section from a translated interface.
 */
const SERVER_SECTION_RESULTS = {
  general: {
    title: "server.settings.generalTitle",
    keywords: "conversation.globalSearch.keywords.serverGeneral",
    icon: Settings,
  },
  vault: { title: "server.settings.vaultTitle", icon: KeyRound },
  roles: { title: "server.settings.rolesTitle", icon: ShieldCheck },
  members: {
    title: "server.settings.membersTitle",
    keywords: "conversation.globalSearch.keywords.serverMembers",
    icon: UsersRound,
  },
  desktop: {
    title: "server.settings.desktopTitle",
    keywords: "conversation.globalSearch.keywords.serverDesktop",
    icon: Monitor,
  },
  mcp: { title: "server.settings.mcpTitle", keywords: "conversation.globalSearch.keywords.serverMcp", icon: Blocks },
  storage: {
    title: "server.settings.storageTitle",
    keywords: "conversation.globalSearch.keywords.serverStorage",
    icon: HardDrive,
  },
  sites: {
    title: "server.settings.hostedSitesTitle",
    keywords: "conversation.globalSearch.keywords.serverSites",
    icon: Globe2,
  },
  providers: {
    title: "server.settings.providersTitle",
    keywords: "conversation.globalSearch.keywords.serverProviders",
    icon: Sparkles,
  },
  updates: {
    title: "server.settings.updatesTitle",
    keywords: "conversation.globalSearch.keywords.serverUpdates",
    icon: RefreshCw,
  },
  import: {
    title: "server.settings.importTitle",
    keywords: "conversation.globalSearch.keywords.serverImport",
    icon: Download,
  },
  transfer: { title: "server.settings.transferTitle", icon: ArrowLeftRight },
  routines: {
    title: "server.settings.routinesTitle",
    keywords: "conversation.globalSearch.keywords.serverRoutines",
    icon: CalendarClock,
  },
  "browser-profiles": { title: "browser.profiles.title", icon: Globe2 },
  connectors: {
    title: "server.settings.connectorsTitle",
    keywords: "conversation.globalSearch.keywords.serverConnectors",
    icon: Plug,
  },
} as const satisfies Record<ServerSettingsSection, { title: AppTextKey; keywords?: AppTextKey; icon: typeof Settings }>;

/** One search result for each page of an agent's settings that opens from a link row. */
const AGENT_PAGE_RESULTS = {
  eventChecks: {
    title: "agentSettings.links.eventChecks",
    keywords: "conversation.globalSearch.keywords.pageEventChecks",
    icon: Bell,
  },
  routines: {
    title: "agentSettings.links.routines",
    keywords: "conversation.globalSearch.keywords.pageRoutines",
    icon: CalendarClock,
  },
  skills: {
    title: "agentSettings.links.skills",
    keywords: "conversation.globalSearch.keywords.pageSkills",
    icon: Puzzle,
  },
  memories: {
    title: "agentSettings.links.memories",
    keywords: "conversation.globalSearch.keywords.pageMemories",
    icon: BookMarked,
  },
  files: {
    title: "agentSettings.links.files",
    keywords: "conversation.globalSearch.keywords.pageFiles",
    icon: Folder,
  },
} as const satisfies Record<AgentSettingsPage, { title: AppTextKey; keywords: AppTextKey; icon: typeof Settings }>;

/**
 * What global search finds besides agents and messages: channels, routines, files, commands and
 * settings pages. Routines load each time the search opens, as no store keeps every agent's list.
 * Files come from this computer's database, so a joined server shows no Files filter.
 */
export function useGlobalSearchSources(open: () => boolean) {
  const { t } = useText();
  const platform = usePlatform();
  const channels = useChannels();
  const { agentList, agentSetupOpen, creatingAgent, openAgentSetup, setSettingsRequest } = useAgents();
  const { selectAgent, globalSearchOpener } = useNavigation();
  const { activeServer } = useServers();
  const { openServerSettings } = useServerSettings();
  const { openAppSettings, setSkillsMarketplaceOpen } = useSettings();
  const { openSchedule, openUsage } = useUsage();
  const { providerAdminServerId } = useProviders();
  const [routines, setRoutines] = createSignal<GlobalSearchRoutine[]>([]);
  const [routinesLoading, setRoutinesLoading] = createSignal(false);
  let routineRequest = 0;

  const local = () => activeServer()?.kind === "local";

  // Lazy: the overlay reads these only while the search is open.
  const searchChannels = createMemo(
    () => (channels.supported() ? globalSearchChannels(channels.state.channels) : undefined),
    { lazy: true },
  );

  createEffect(
    () => (open() ? agentList() : null),
    (agents) => {
      const request = ++routineRequest;
      if (!agents) {
        setRoutinesLoading(false);
        return;
      }
      setRoutinesLoading(true);
      const names = new Map(agents.map((agent) => [agent.id, agent.name]));
      void Promise.all(
        agents.map((agent) =>
          appPort()
            .agent.listRoutines(agent.id)
            .catch(() => []),
        ),
      ).then((lists) => {
        if (request !== routineRequest) return;
        setRoutines(() =>
          lists.flat().map((routine) => ({
            id: routine.id,
            name: routine.name,
            agentId: routine.agentId,
            detail: names.get(routine.agentId) ?? "",
          })),
        );
        setRoutinesLoading(false);
      });
    },
  );

  async function searchFiles(query: string, cursor?: string): Promise<GlobalSearchPage<GlobalSearchFile>> {
    const page = await appPort().agent.searchConversationFiles({
      query,
      ...(cursor === undefined ? {} : { cursor }),
      limit: FILE_SEARCH_LIMIT,
    });
    return {
      results: page.results.map((result) => ({
        id: result.attachment.id,
        name: result.attachment.name,
        agentId: result.agentId,
        messageId: result.messageId,
        time: formatMessageTime(result.createdAt),
      })),
      nextCursor: page.nextCursor,
    };
  }

  function selectRoutine(routine: GlobalSearchRoutine): void {
    const agentId = routine.agentId;
    // As in `editAgent`: the agent cannot change while a new agent is being created.
    if (!agentId || (agentSetupOpen() && creatingAgent())) return;
    selectAgent(agentId);
    setSettingsRequest({ agentId, nonce: Date.now(), routine: { routineId: routine.id, name: routine.name } });
  }

  function openAgentPage(agentId: string, page: AgentSettingsPage): void {
    // As in `selectRoutine`: the agent cannot change while a new agent is being created.
    if (agentSetupOpen() && creatingAgent()) return;
    selectAgent(agentId);
    setSettingsRequest({ agentId, nonce: Date.now(), page });
  }

  const actions = createMemo<GlobalSearchAction[]>(
    () => {
      const server = activeServer();
      const dynamicIslandShown = dynamicIslandSettingsShown(platform.appInfo()?.platform, platform.chatWindow !== null);
      const list: GlobalSearchAction[] = [
        {
          id: "new-agent",
          label: t("sidebar.new.agent"),
          group: "actions",
          icon: Bot,
          run: () => {
            channels.close();
            openAgentSetup();
          },
        },
      ];
      if (channels.supported()) {
        list.push({
          id: "new-channel",
          label: t("sidebar.new.channel"),
          group: "actions",
          icon: Hash,
          run: channels.create,
        });
      }
      list.push({
        id: "marketplace",
        label: t("sidebar.topbar.openMarketplace"),
        group: "actions",
        icon: Store,
        run: () => setSkillsMarketplaceOpen(true),
      });
      if (server) {
        list.push({
          id: "schedule",
          label: t("routine.calendar.open"),
          group: "actions",
          icon: CalendarClock,
          run: () => openSchedule(server.id, globalSearchOpener()),
        });
      }
      for (const item of navItems) {
        // Hosted servers shows only for an account with hosting, which the dialog checks when it opens.
        if (item.value === "hosted-servers" || (item.value === "dynamic-island" && !dynamicIslandShown)) continue;
        list.push({
          id: `settings:${item.value}`,
          label: t(item.titleKey),
          detail: t("conversation.globalSearch.appSettings"),
          group: "settings",
          icon: item.icon,
          run: () => openAppSettings(globalSearchOpener(), item.value),
        });
      }
      if (server) {
        const sections = availableServerSettingsSections(server, {
          platform: platform.appInfo()?.platform,
          // This computer's providers, or those of the joined host that this account administers.
          providers: server.kind === "local" || server.id === providerAdminServerId(),
        });
        for (const section of sections) {
          const result: { title: AppTextKey; keywords?: AppTextKey; icon: typeof Settings } =
            SERVER_SECTION_RESULTS[section];
          list.push({
            id: `server:${section}`,
            label: t(result.title),
            detail: server.name,
            ...(result.keywords ? { keywords: t(result.keywords) } : {}),
            group: "settings",
            icon: result.icon,
            run: () => openServerSettings(server.id, globalSearchOpener(), section),
          });
        }
        list.push({
          id: "usage",
          label: t("conversation.globalSearch.usage"),
          keywords: t("conversation.globalSearch.keywords.usage"),
          group: "settings",
          icon: Gauge,
          run: () => openUsage(server.id, globalSearchOpener()),
        });
        // The pages of an agent's settings. The panel has the same rows as these gates, for this computer
        // and for a joined server of the desktop client.
        const pages: AgentSettingsPage[] = ["skills", "memories", "routines"];
        if (serverCanAdminister(server, EVENT_CHECKS_CAPABILITY)) pages.push("eventChecks");
        if (serverHasStorage(server)) pages.push("files");
        for (const agent of agentList()) {
          for (const page of pages) {
            const result = AGENT_PAGE_RESULTS[page];
            list.push({
              id: `agent:${agent.id}:${page}`,
              label: t("conversation.globalSearch.agentPage", { agent: agent.name, page: t(result.title) }),
              detail: t("conversation.globalSearch.agentSettings"),
              keywords: t(result.keywords),
              group: "settings",
              icon: result.icon,
              run: () => openAgentPage(agent.id, page),
            });
          }
        }
        // General shows the memory limit only to an admin of a host that can set it, and only while it is online.
        if (
          serverCanAdminister(server, "agent-memory-limit-v1") &&
          (server.kind === "local" || server.state === "online")
        ) {
          list.push({
            id: "server:memory-limit",
            label: t("server.settings.memoryLimit"),
            detail: server.name,
            group: "settings",
            icon: BookMarked,
            run: () => openServerSettings(server.id, globalSearchOpener(), "general"),
          });
        }
      }
      return list;
    },
    { lazy: true },
  );

  const shortcuts = createMemo(() =>
    keyboardShortcuts(t, platform.appInfo()?.platform ?? currentDevicePlatform(), "desktop"),
  );

  return {
    shortcuts,
    channels: searchChannels,
    routines,
    routinesLoading,
    actions,
    searchFiles: () => (local() ? searchFiles : undefined),
    openChannel: (channelId: string) => void channels.open(channelId),
    selectRoutine,
  };
}
