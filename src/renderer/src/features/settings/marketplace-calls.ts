import type {
  AddedAgent,
  InstallMarketplaceAgentInput,
  McpTestResult,
  TestMcpServerInput,
} from "@openbot/contracts/ipc";
import type { MarketplaceEventChecks } from "@openbot/ui/features/marketplace/marketplace-event-checks";
import { appPort } from "../../app-port";
import { type AgentSkillCalls, agentSkillCalls, type SkillsPort, skillsPort } from "../../skills-port";

/**
 * What the marketplace calls. The desktop app reads the catalog and changes agents through main. The
 * browser client reads the catalog on its own origin and changes its host over the Team API.
 */
export interface MarketplaceCalls {
  skills: Pick<SkillsPort["skills"], "get" | "list">;
  agents: Pick<SkillsPort["marketplaceAgents"], "get" | "list">;
  agentSkills: (hostServerId?: string) => AgentSkillCalls;
  mcp: Pick<SkillsPort["agent"], "listMcpServers" | "removeMcpServer" | "saveMcpServer" | "testMcpServer"> & {
    supportsRemoteSignIn?: () => boolean;
    signInMcpServer: (input: TestMcpServerInput, serverId: string, signal?: AbortSignal) => Promise<McpTestResult>;
  };
  /** `serverId` absent: this computer, which is also the only place an installed agent is updated. */
  addAgent: (input: InstallMarketplaceAgentInput, serverId: string | undefined) => Promise<AddedAgent>;
  openUrl: (url: string) => Promise<void>;
  /**
   * The event check templates and checks of a host. `serverId` absent: this computer. Absent here: the
   * client has none, and the Event checks tab is not shown.
   */
  eventChecks?: ((serverId?: string) => MarketplaceEventChecks) | undefined;
}

/** Read on each call, as `skillsPort` is: tests and stories replace `window.openbot` per case. */
export function desktopMarketplaceCalls(): MarketplaceCalls {
  const port = skillsPort();
  return {
    skills: port.skills,
    agents: port.marketplaceAgents,
    agentSkills: agentSkillCalls,
    mcp: port.agent,
    addAgent: async (input, serverId) =>
      serverId ? port.agent.addMarketplaceAgent(input, serverId) : (await port.marketplaceAgents.install(input)).agent,
    openUrl: (url) => appPort().openUrl(url),
    eventChecks: desktopEventChecks,
  };
}

/**
 * The event check calls of this computer, or of the joined server `serverId`. The bridge scopes each
 * call to a server by the argument that comes last, and to the selected server when it is left out.
 */
function desktopEventChecks(serverId?: string): MarketplaceEventChecks {
  // Read on each call, as `skillsPort` is: tests and stories replace `window.openbot` per case.
  const templates = () => window.openbot.eventCheckTemplates;
  const checks = () => window.openbot.eventChecks;
  return {
    templates: {
      list: () => templates().list(serverId),
      install: (input) => templates().install(input, serverId),
      update: (input) => templates().update(input, serverId),
      adopt: (input) => templates().adopt(input, serverId),
    },
    checks: {
      environment: (input) => checks().environment(input, serverId),
      setEnvironment: (input) => checks().setEnvironment(input, serverId),
      test: (input) => checks().test(input, serverId),
      list: (input) => checks().list(input, serverId),
      save: (input) => checks().save(input, serverId),
      remove: (input) => checks().remove(input, serverId),
      checkNow: (input) => checks().checkNow(input, serverId),
      history: (input) => checks().history(input, serverId),
      accounts: (input) => checks().accounts(input, serverId),
      tools: (input) => checks().tools(input, serverId),
    },
  };
}
