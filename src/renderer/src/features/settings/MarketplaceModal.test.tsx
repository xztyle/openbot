import type {
  AgentSummary,
  InstalledSkill,
  MarketplaceAgentDetail,
  MarketplaceSkillPage,
  McpServerConfig,
  McpTestResult,
  OpenBotDesktopApi,
} from "@openbot/contracts/ipc";
import type { MarketplacePluginDetail } from "@openbot/ui/features/settings/marketplace-plugins";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { type ComponentProps, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AnalyticsEventName, type DesktopAnalyticsEvents, desktopAnalytics } from "../../analytics";
import { MarketplaceModal } from "./MarketplaceModal";
import { desktopMarketplaceCalls, type MarketplaceCalls } from "./marketplace-calls";
import type { MarketplaceAgentRow } from "./marketplace-controller";
import { MARKETPLACE_PLUGINS } from "./marketplace-plugin-catalog";

type MarketplaceProps = Partial<ComponentProps<typeof MarketplaceModal>>;

/**
 * The modal as the tests open it. A case that drives a prop from a signal passes a function, so the
 * read stays inside the render and the prop stays reactive.
 */
function renderMarketplace(props: MarketplaceProps | (() => MarketplaceProps) = {}) {
  const resolve = typeof props === "function" ? props : () => props;
  return render(() => (
    <MarketplaceModal open agents={[]} activeAgentId="" onOpenChange={() => undefined} {...resolve()} />
  ));
}

/** Opens the install menu of a skill and checks one item in it. A menu opens on the press. */
async function chooseInMenu(skill: string, item: string | RegExp) {
  fireEvent.pointerDown(await screen.findByRole("button", { name: `Install ${skill}` }), { button: 0 });
  fireEvent.pointerUp(await screen.findByRole("menuitemcheckbox", { name: item }), { button: 0 });
}

async function openSkillPage() {
  fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open Release Notes" }));
}

function installedSkill(skillId: string, name: string, overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    skillId,
    slug: skillId,
    name,
    installedVersion: 2,
    availableVersion: 2,
    state: "installed",
    enabled: true,
    ...overrides,
  };
}

function agentRow(id: string, name: string, overrides: Partial<MarketplaceAgentRow> = {}): MarketplaceAgentRow {
  return { id, name, avatarSeed: id, avatarHue: null, avatarUrl: null, ...overrides };
}

const trackMarketplaceAnalytics = vi.fn();

function trackScopedMarketplaceAnalytics<Name extends AnalyticsEventName>(
  name: Name,
  properties: DesktopAnalyticsEvents[Name],
) {
  trackMarketplaceAnalytics(name, properties);
}

describe("MarketplaceModal", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    trackMarketplaceAnalytics.mockClear();
    vi.spyOn(desktopAnalytics, "scope").mockImplementation(() => ({ track: trackScopedMarketplaceAnalytics }));
    const page: MarketplaceSkillPage = {
      skills: [
        {
          id: "release-notes",
          slug: "release-notes",
          name: "Release Notes",
          description: "Turns merged work into clear release notes.",
          category: "documents",
          creatorName: "Ada",
          version: 2,
          installs: 1280,
          featured: true,
          iconUrl: null,
          updatedAt: "2026-08-25T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    const skills: OpenBotDesktopApi["skills"] = {
      localList: vi.fn(async () => []),
      localGet: vi.fn(),
      localCreate: vi.fn(),
      localRevise: vi.fn(),
      localInstall: vi.fn(),
      list: vi.fn(async () => page),
      get: vi.fn(async () => {
        const skill = page.skills[0];
        if (!skill) throw new Error("Missing test skill.");
        return {
          ...skill,
          versionId: "release-notes-v2",
          bundleSha256: "abc123",
          files: ["SKILL.md", "references/template.md"],
          instructions: "Group changes by customer impact and call out breaking changes.",
        };
      }),
      listMine: vi.fn(async () => []),
      choosePackage: vi.fn(),
      submit: vi.fn(),
      listInstalled: vi.fn(async () => []),
      install: vi.fn(),
      uninstall: vi.fn(),
      setEnabled: vi.fn(),
    };
    window.openbot = { ...window.openbot, skills };
    // The controller hears `skills-changed` on the agent event stream.
    window.openbot.agent = { ...window.openbot.agent, onEvent: vi.fn(() => () => undefined) };
    window.openbot.marketplaceAgents = {
      list: vi.fn(async () => ({ agents: [], nextCursor: null })),
      get: vi.fn(),
      listMine: vi.fn(async () => []),
      preview: vi.fn(),
      submit: vi.fn(),
      install: vi.fn(),
    };
  });

  describe("skills", () => {
    it.each([1, 2])("tries only an installed version %s that matches the listing", async (version) => {
      vi.spyOn(window.openbot.skills, "listInstalled").mockImplementation(async (agentId) =>
        agentId === "writer" ? [installedSkill("release-notes", "Release Notes", { installedVersion: version })] : [],
      );
      const onTrySkill = vi.fn();
      renderMarketplace({
        agents: [agentRow("research", "Research"), agentRow("writer", "Writer")],
        activeAgentId: "research",
        onTrySkill,
      });
      await openSkillPage();

      if (version !== 2) {
        expect(await screen.findByText("Update this skill to try this version.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try skill" })).toBeDisabled();
        return;
      }
      // The open conversation does not have the skill, so Try goes to the agent that has it.
      fireEvent.click(await screen.findByRole("button", { name: "Try in Writer" }));
      expect(onTrySkill).toHaveBeenCalledWith("writer", expect.objectContaining({ id: "release-notes" }));
    });

    it("names an unread skills list instead of asking for an install that may exist", async () => {
      vi.spyOn(window.openbot.skills, "listInstalled").mockRejectedValue(new Error("Skill list unavailable."));
      renderMarketplace({ agents: [agentRow("writer", "Writer")], activeAgentId: "writer", onTrySkill: vi.fn() });
      await openSkillPage();

      // A list that could not be read looks exactly like an empty one. Naming a missing skill here
      // sends the user to install what the agent may already have.
      expect(await screen.findByText("OpenBot could not read this agent's skills. Try again.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try skill" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("Skill list unavailable.");
    });

    it("keeps a failed skills read after an install instead of offering the install again", async () => {
      let reads = 0;
      vi.spyOn(window.openbot.skills, "listInstalled").mockImplementation(async () => {
        reads += 1;
        if (reads === 1) return [];
        throw new Error("Skill list unavailable.");
      });
      const install = vi
        .spyOn(window.openbot.skills, "install")
        .mockResolvedValue(installedSkill("release-notes", "Release Notes"));
      renderMarketplace({ agents: [agentRow("writer", "Writer")], activeAgentId: "writer", onTrySkill: vi.fn() });
      await openSkillPage();
      await waitFor(() => expect(reads).toBe(1));
      // The open conversation's agent has "You're here" in its name.
      await chooseInMenu("Release Notes", /^Writer/u);

      await waitFor(() => expect(install).toHaveBeenCalledWith(expect.objectContaining({ agentId: "writer" })));
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      // The skill is installed, but the list on screen is older than the install.
      expect(await screen.findByText("OpenBot could not read this agent's skills. Try again.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try skill" })).toBeDisabled();
    });

    it("shows the approved skill instructions and goes back to the list", async () => {
      renderMarketplace({ agents: [agentRow("writer", "Writer")], activeAgentId: "writer" });
      await openSkillPage();

      expect(await screen.findByText(/Group changes by customer impact/u)).toBeInTheDocument();
      expect(trackMarketplaceAnalytics).toHaveBeenCalledWith("marketplace_action", {
        entity: "skill",
        action: "view",
        listing_slug: "release-notes",
        result: "succeeded",
      });
      fireEvent.click(screen.getByRole("button", { name: "Marketplace" }));
      await waitFor(() => expect(screen.queryByText(/Group changes by customer impact/u)).toBeNull());
    });

    /**
     * "All agents" is a loop over the agents, not one call. One agent that refuses must not stop the
     * others, and the user must learn which agents did not get the skill.
     */
    it("installs on each agent for All agents and names the agents that failed", async () => {
      const install = vi.spyOn(window.openbot.skills, "install").mockImplementation(async (input) => {
        if (input.agentId !== "writer") throw new Error("The agent workspace is read-only.");
        return installedSkill("release-notes", "Release Notes");
      });
      renderMarketplace({
        agents: [agentRow("writer", "Writer"), agentRow("research", "Research"), agentRow("coder", "Coder")],
        activeAgentId: "writer",
      });
      fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
      await chooseInMenu("Release Notes", "All agents");

      await waitFor(() => expect(install).toHaveBeenCalledTimes(3));
      expect(install.mock.calls.map(([input]) => input.agentId)).toEqual(["writer", "research", "coder"]);
      // The menu stays open for more changes, and a screen reader still hears the results.
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Release Notes did not change on these agents: Research and Coder. The agent workspace is read-only.",
      );
      expect(screen.getByRole("status")).toHaveTextContent("Release Notes installed on 1 agent.");
    });
  });

  describe("agents", () => {
    const detail: MarketplaceAgentDetail = {
      id: "research-agent",
      versionId: "research-agent-v2",
      name: "Research Agent",
      title: "Finds evidence quickly",
      description: "Searches sources and produces concise cited findings.",
      creatorName: "Ada",
      version: 2,
      installs: 42,
      featured: true,
      avatarSeed: "research-agent",
      avatarHue: 215,
      avatarUrl: null,
      skillCount: 1,
      routineCount: 1,
      activeRoutineCount: 1,
      updatedAt: "2026-08-25T00:00:00.000Z",
      skills: [{ skillId: "research", versionId: "research-v1", slug: "research", name: "Research", version: 1 }],
      routines: [
        {
          name: "Daily brief",
          instruction: "Prepare a brief.",
          active: true,
          schedule: { kind: "daily", time: "09:00" },
        },
      ],
    };
    const addedAgent = {
      id: "agent-added",
      name: detail.name,
      title: detail.title,
      description: detail.description,
      notifications: true,
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: null,
      workspacePath: "/tmp/agent-added",
      preview: "No messages yet",
      updatedAt: null,
      avatarSeed: detail.avatarSeed,
      avatarHue: detail.avatarHue,
      avatarUrl: detail.avatarUrl,
    } satisfies AgentSummary;

    beforeEach(() => {
      window.openbot.marketplaceAgents.list = vi.fn(async () => ({ agents: [detail], nextCursor: null }));
      window.openbot.marketplaceAgents.get = vi.fn(async () => detail);
      window.openbot.marketplaceAgents.install = vi.fn(async () => ({ agent: addedAgent }));
    });

    it("adds an agent without closing the Marketplace, then opens its chat on request", async () => {
      const onOpenChange = vi.fn();
      const onAgentInstalled = vi.fn();
      renderMarketplace({ onOpenChange, onAgentInstalled });
      fireEvent.click(await screen.findByRole("button", { name: "Add Research Agent" }));

      await waitFor(() => expect(window.openbot.marketplaceAgents.install).toHaveBeenCalled());
      const input = vi.mocked(window.openbot.marketplaceAgents.install).mock.lastCall?.[0];
      // A new agent, not an update of one the user has.
      expect(input).toMatchObject({ listingId: detail.id });
      expect(input).not.toHaveProperty("agentId");
      expect(await screen.findByText("Added")).toBeInTheDocument();
      expect(trackMarketplaceAnalytics).toHaveBeenCalledWith("marketplace_action", {
        entity: "agent",
        action: "install",
        listing_slug: detail.id,
        result: "succeeded",
      });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onAgentInstalled).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Open Research Agent" }));
      fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onAgentInstalled).toHaveBeenCalledWith(addedAgent, undefined);
    });

    it("updates the user's older copy in place", async () => {
      renderMarketplace({
        agents: [
          agentRow("existing-research-agent", detail.name, {
            marketplaceSource: {
              listingId: detail.id,
              versionId: "research-agent-v1",
              version: 1,
              skillIds: [],
              routineIds: [],
            },
          }),
        ],
      });
      expect(await screen.findByText("Update available")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Open Research Agent" }));
      fireEvent.click(await screen.findByRole("button", { name: "Update" }));

      await waitFor(() =>
        expect(window.openbot.marketplaceAgents.install).toHaveBeenCalledWith(
          expect.objectContaining({ listingId: detail.id, agentId: "existing-research-agent" }),
        ),
      );
      await waitFor(() => expect(screen.queryByRole("button", { name: "Update" })).toBeNull());
      expect(screen.getByRole("button", { name: "Open chat" })).toBeInTheDocument();
    });
  });

  describe("apps", () => {
    const plugin: MarketplacePluginDetail = {
      id: "plugin-aave",
      slug: "aave",
      name: "Aave",
      tagline: "Aave data and transactions",
      description: "Live markets, positions and prepared transactions.",
      category: "data-analytics",
      creatorName: "avara.xyz",
      creatorAvatarUrl: null,
      iconUrl: null,
      version: "1.0.0",
      installs: 0,
      featured: true,
      updatedAt: "2026-09-18T00:00:00.000Z",
      shareUrl: "https://openbot.run/plugins/aave",
      prompts: [],
      apps: [
        {
          id: "app-aave-mcp",
          name: "Aave",
          description: "Markets and prepared transactions, over one MCP server.",
          iconUrl: null,
          server: { name: "aave", transport: "http", url: "https://mcp.aave.com/mcp" },
        },
      ],
      skills: [],
      websiteUrl: null,
      privacyPolicyUrl: null,
      termsUrl: null,
    };
    const installedYield = installedSkill("skill-yield", "Yield analysis", {
      slug: "yield-analysis",
      installedVersion: 3,
      availableVersion: 3,
    });
    const app = plugin.apps[0];
    if (app?.server.transport !== "http") throw new Error("The plugin under test must publish one http app.");
    const appUrl = app.server.url;
    const appName = app.server.name;
    const withSkill: MarketplacePluginDetail = {
      ...plugin,
      skills: [
        {
          id: "skill-yield",
          versionId: "skill-yield-v3",
          slug: "yield-analysis",
          description: "Compare Aave yields and rates.",
        },
      ],
    };
    /**
     * A listing that declares a way in is connected before it is installed, and what is saved is
     * what connected.
     */
    const withKey: MarketplacePluginDetail = {
      ...plugin,
      apps: [
        {
          ...app,
          server: {
            ...app.server,
            auth: [
              {
                id: "api-key",
                kind: "key",
                label: "API key",
                fields: [{ id: "token", label: "API key", header: "Authorization", prefix: "Bearer " }],
              },
            ],
          },
        },
      ],
    };
    const writer = { agents: [agentRow("writer", "Writer")], activeAgentId: "writer", pluginServerId: "local" };
    const withLink: MarketplacePluginDetail = {
      ...plugin,
      apps: [{ ...app, server: { ...app.server, auth: [{ id: "sign-in", kind: "link", label: "Sign in" }] } }],
    };

    /** The host row an installed app leaves behind, as `listMcpServers` answers it. */
    function hostApp(): McpServerConfig {
      return {
        id: "mcp-1",
        name: appName,
        transport: "http" as const,
        enabled: true,
        command: "",
        args: [],
        env: [],
        envPassthrough: [],
        workingDirectory: "",
        url: appUrl,
        headers: [],
      };
    }

    async function openAppPage(name = "Aave") {
      fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
      fireEvent.click(await screen.findByRole("button", { name: `Open ${name}` }));
      // The card has a Connect button too, so the next step waits for the page.
      await screen.findByRole("heading", { name, level: 3 });
    }

    /**
     * The host's list arrives after the window opens. Until then an installed app reads as not
     * connected, and a press on Connect would save "Aave — 2" beside the account that is there.
     */
    it("keeps Connect off until the host's list of apps is read", async () => {
      let answer: (rows: McpServerConfig[]) => void = () => undefined;
      const saveMcpServer: OpenBotDesktopApi["agent"]["saveMcpServer"] = vi.fn(async (input) => [input.config]);
      window.openbot.agent = {
        ...window.openbot.agent,
        listMcpServers: vi.fn(() => new Promise<McpServerConfig[]>((resolve) => (answer = resolve))),
        saveMcpServer,
      };
      renderMarketplace({ ...writer, plugins: [plugin] });
      fireEvent.click(screen.getByRole("tab", { name: "Apps" }));

      const checking = await screen.findByRole("button", { name: "Checking…" });
      expect(checking).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Connect Aave" })).toBeNull();
      fireEvent.click(checking);
      expect(saveMcpServer).not.toHaveBeenCalled();

      answer([hostApp()]);
      expect(await screen.findByText("Connected")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Connect Aave" })).toBeNull();
      expect(saveMcpServer).not.toHaveBeenCalled();
    });

    it("names a failed read of the apps, keeps Connect off and reads again on Retry", async () => {
      const listMcpServers = vi
        .fn<OpenBotDesktopApi["agent"]["listMcpServers"]>()
        .mockRejectedValueOnce(new Error("The host did not answer."))
        .mockResolvedValue([hostApp()]);
      window.openbot.agent = { ...window.openbot.agent, listMcpServers, saveMcpServer: vi.fn() };
      renderMarketplace({ ...writer, plugins: [plugin] });
      fireEvent.click(screen.getByRole("tab", { name: "Apps" }));

      expect(await screen.findByText("Could not read apps on this computer.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Connect Aave" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      expect(await screen.findByText("Connected")).toBeInTheDocument();
      expect(screen.queryByText("Could not read apps on this computer.")).toBeNull();
      expect(listMcpServers).toHaveBeenCalledTimes(2);
      expect(window.openbot.agent.saveMcpServer).not.toHaveBeenCalled();
    });

    it("does not connect from a chat card when the app is already held but needs attention", async () => {
      // The app row is here and its skill is not: a partial install, which its page repairs.
      const saveMcpServer: OpenBotDesktopApi["agent"]["saveMcpServer"] = vi.fn(async (input) => [input.config]);
      window.openbot.agent = {
        ...window.openbot.agent,
        listMcpServers: vi.fn(async () => [hostApp()]),
        saveMcpServer,
      };
      window.openbot.skills = { ...window.openbot.skills, listInstalled: vi.fn(async () => []), install: vi.fn() };
      renderMarketplace({ ...writer, plugins: [withSkill], initialPluginSlug: "aave", initialPluginConnect: true });

      expect(await screen.findByText("Needs attention")).toBeInTheDocument();
      expect(saveMcpServer).not.toHaveBeenCalled();
      expect(window.openbot.skills.install).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Connect Aave" })).toBeNull();
    });

    it("connects the app on the host it was given", async () => {
      const saved: McpServerConfig[] = [];
      const saveMcpServer: OpenBotDesktopApi["agent"]["saveMcpServer"] = vi.fn(async (input) => {
        saved.push(input.config);
        return saved;
      });
      window.openbot.agent = { ...window.openbot.agent, listMcpServers: vi.fn(async () => []), saveMcpServer };
      renderMarketplace({ ...writer, plugins: [plugin] });
      await openAppPage();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Aave" }));

      await waitFor(() => expect(saveMcpServer).toHaveBeenCalled());
      // Each connection has its own account ID and numbered name.
      expect(saveMcpServer).toHaveBeenCalledWith(
        {
          config: expect.objectContaining({
            id: expect.stringMatching(/^mcpacct-[a-f0-9-]{36}$/),
            name: `${app.name} — 1`,
            transport: "http",
            url: appUrl,
          }),
        },
        "local",
      );
      expect(await screen.findByRole("button", { name: "Disconnect" })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Aave connected."));
    });

    it("saves the configuration the connect dialog proved", async () => {
      const saveMcpServer: OpenBotDesktopApi["agent"]["saveMcpServer"] = vi.fn(async (input) => [input.config]);
      const testMcpServer: OpenBotDesktopApi["agent"]["testMcpServer"] = vi.fn(async () => ({
        toolCount: 4,
        error: null,
      }));
      window.openbot.agent = {
        ...window.openbot.agent,
        listMcpServers: vi.fn(async () => []),
        saveMcpServer,
        testMcpServer,
      };
      renderMarketplace({ ...writer, plugins: [withKey] });
      await openAppPage();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Aave" }));

      fireEvent.input(await screen.findByLabelText(/API key/), { target: { value: "live-key" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => expect(saveMcpServer).toHaveBeenCalled());
      const sent = { key: "Authorization", value: "Bearer live-key" };
      expect(testMcpServer).toHaveBeenCalledWith({ config: expect.objectContaining({ headers: [sent] }) }, "local");
      expect(saveMcpServer).toHaveBeenCalledWith({ config: expect.objectContaining({ headers: [sent] }) }, "local");
    });

    it("connects to the user's own Composio link and refuses a link from another host", async () => {
      const composio = MARKETPLACE_PLUGINS.find((listing) => listing.slug === "composio");
      if (!composio) throw new Error("The catalog has no Composio listing.");
      const saveMcpServer: OpenBotDesktopApi["agent"]["saveMcpServer"] = vi.fn(async (input) => [input.config]);
      const testMcpServer: OpenBotDesktopApi["agent"]["testMcpServer"] = vi.fn(async () => ({
        toolCount: 12,
        error: null,
      }));
      window.openbot.agent = {
        ...window.openbot.agent,
        listMcpServers: vi.fn(async () => []),
        saveMcpServer,
        testMcpServer,
      };
      renderMarketplace({ ...writer, plugins: [composio] });
      await openAppPage("Composio");
      fireEvent.click(await screen.findByRole("button", { name: "Connect Composio" }));

      const link = await screen.findByLabelText(/MCP URL/);
      fireEvent.input(link, { target: { value: "https://example.com/mcp" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      expect(await screen.findByText("Enter an https link from composio.dev.")).toBeInTheDocument();
      expect(testMcpServer).not.toHaveBeenCalled();

      const url = "https://backend.composio.dev/v3/mcp/server-id?user_id=me";
      fireEvent.input(link, { target: { value: url } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => expect(saveMcpServer).toHaveBeenCalled());
      expect(saveMcpServer).toHaveBeenCalledWith(
        { config: expect.objectContaining({ name: "Composio — 1", url, headers: [] }) },
        "local",
      );
    });

    it.each([undefined, "remote"])("signs in on %s before saving the account", async (hostServerId) => {
      const serverId = hostServerId ?? "local";
      const signInMcpServer = vi.fn<MarketplaceCalls["mcp"]["signInMcpServer"]>(async () => ({
        toolCount: 4,
        error: null,
      }));
      const saveMcpServer = vi.fn<MarketplaceCalls["mcp"]["saveMcpServer"]>(async ({ config }) => [config]);
      const calls = desktopMarketplaceCalls();
      calls.mcp = {
        ...calls.mcp,
        supportsRemoteSignIn: () => true,
        listMcpServers: async () => [],
        signInMcpServer,
        saveMcpServer,
      };
      renderMarketplace({ ...writer, pluginServerId: serverId, hostServerId, plugins: [withLink], calls });
      await openAppPage();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Aave" }));
      fireEvent.click(await screen.findByRole("button", { name: "Continue to Aave" }));

      await waitFor(() => expect(saveMcpServer).toHaveBeenCalled());
      const attempt = signInMcpServer.mock.lastCall;
      expect(attempt?.[0].config.url).toBe(appUrl);
      expect(attempt?.[1]).toBe(serverId);
      expect(attempt?.[2]).toEqual(hostServerId ? expect.any(AbortSignal) : undefined);
      expect(saveMcpServer.mock.lastCall?.[0]).toEqual(attempt?.[0]);
    });

    it("cancels remote sign-in without saving its account", async () => {
      const signInMcpServer = vi.fn<MarketplaceCalls["mcp"]["signInMcpServer"]>(
        async (_input, _serverId, signal) =>
          new Promise<McpTestResult>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
          }),
      );
      const calls = desktopMarketplaceCalls();
      const saveMcpServer = vi.fn<MarketplaceCalls["mcp"]["saveMcpServer"]>(async ({ config }) => [config]);
      calls.mcp = {
        ...calls.mcp,
        supportsRemoteSignIn: () => true,
        listMcpServers: async () => [],
        signInMcpServer,
        saveMcpServer,
      };
      renderMarketplace({ ...writer, pluginServerId: "remote", hostServerId: "remote", plugins: [withLink], calls });
      await openAppPage();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Aave" }));
      fireEvent.click(await screen.findByRole("button", { name: "Continue to Aave" }));
      await waitFor(() => expect(signInMcpServer).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Close connect Aave" }));

      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect Aave" })).toBeNull());
      expect(signInMcpServer.mock.lastCall?.[2]?.aborted).toBe(true);
      expect(saveMcpServer).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByRole("button", { name: "Connect Aave" })).toBeEnabled());
    });

    /**
     * The browser of this computer is outside the window, and the main process waits for it for five
     * minutes. A user who closed that tab must be able to leave, and the wait must stop with it.
     */
    it("cancels a browser sign-in on this computer and stops the wait in the main process", async () => {
      const signInMcpServer = vi.fn<MarketplaceCalls["mcp"]["signInMcpServer"]>(
        () => new Promise<McpTestResult>(() => undefined),
      );
      const cancelMcpSignIn = vi.fn<OpenBotDesktopApi["agent"]["cancelMcpSignIn"]>(async () => undefined);
      const saveMcpServer = vi.fn<MarketplaceCalls["mcp"]["saveMcpServer"]>(async ({ config }) => [config]);
      const calls = desktopMarketplaceCalls();
      calls.mcp = { ...calls.mcp, listMcpServers: async () => [], signInMcpServer, cancelMcpSignIn, saveMcpServer };
      renderMarketplace({ ...writer, plugins: [withLink], calls });
      await openAppPage();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Aave" }));
      fireEvent.click(await screen.findByRole("button", { name: "Continue to Aave" }));
      await waitFor(() => expect(signInMcpServer).toHaveBeenCalled());

      expect(await screen.findByText("Closed the browser tab? Cancel and try again.")).toBeInTheDocument();
      const dialog = screen.getByRole("dialog", { name: "Connect Aave" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect Aave" })).toBeNull());
      expect(cancelMcpSignIn).toHaveBeenCalledExactlyOnceWith({ url: appUrl }, "local");
      expect(saveMcpServer).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByRole("button", { name: "Connect Aave" })).toBeEnabled());
    });

    it("saves nothing when the connect dialog is closed", async () => {
      const saveMcpServer: OpenBotDesktopApi["agent"]["saveMcpServer"] = vi.fn(async (input) => [input.config]);
      window.openbot.agent = { ...window.openbot.agent, listMcpServers: vi.fn(async () => []), saveMcpServer };
      renderMarketplace({ ...writer, plugins: [withKey] });
      await openAppPage();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Aave" }));
      fireEvent.click(await screen.findByRole("button", { name: "Close connect Aave" }));

      // Closing the dialog is a decision, not a failure: the connect stops and can start again.
      await waitFor(() => expect(screen.getByRole("button", { name: "Connect Aave" })).toBeEnabled());
      expect(saveMcpServer).not.toHaveBeenCalled();
    });

    it("stops the connect step when the Marketplace itself is closed", async () => {
      const saveMcpServer: OpenBotDesktopApi["agent"]["saveMcpServer"] = vi.fn(async (input) => [input.config]);
      window.openbot.agent = { ...window.openbot.agent, listMcpServers: vi.fn(async () => []), saveMcpServer };
      const [open, setOpen] = createSignal(true);
      renderMarketplace(() => ({ ...writer, open: open(), onOpenChange: setOpen, plugins: [withKey] }));
      await openAppPage();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Aave" }));
      await screen.findByRole("dialog", { name: "Connect Aave" });

      // The connect dialog is beside the Marketplace, so it must learn that its page is gone.
      setOpen(false);

      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect Aave" })).toBeNull());
      expect(saveMcpServer).not.toHaveBeenCalled();
    });

    it("installs the pinned skill into the agent before the app reaches the host", async () => {
      const order: string[] = [];
      const install = vi.fn(async () => {
        order.push("skill");
        return installedYield;
      });
      const saveMcpServer: OpenBotDesktopApi["agent"]["saveMcpServer"] = vi.fn(async (input) => {
        order.push("app");
        return [input.config];
      });
      window.openbot.skills = { ...window.openbot.skills, install };
      window.openbot.agent = { ...window.openbot.agent, listMcpServers: vi.fn(async () => []), saveMcpServer };
      renderMarketplace({ ...writer, plugins: [withSkill] });
      await openAppPage();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Aave" }));

      await waitFor(() => expect(saveMcpServer).toHaveBeenCalled());
      expect(install).toHaveBeenCalledWith({ agentId: "writer", skillId: "skill-yield", versionId: "skill-yield-v3" });
      // The skills go first, so a failure never leaves a server that nothing knows how to drive.
      expect(order).toEqual(["skill", "app"]);
    });

    it("removes the skill it installed when the app cannot be saved", async () => {
      const install = vi.fn(async () => installedYield);
      const uninstall = vi.fn(async () => undefined);
      window.openbot.skills = { ...window.openbot.skills, install, uninstall };
      window.openbot.agent = {
        ...window.openbot.agent,
        listMcpServers: vi.fn(async () => []),
        saveMcpServer: vi.fn(async () => {
          throw new Error("This MCP server no longer exists.");
        }),
      };
      renderMarketplace({ ...writer, plugins: [withSkill] });
      await openAppPage();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Aave" }));

      await waitFor(() => expect(uninstall).toHaveBeenCalledWith({ agentId: "writer", skillId: "skill-yield" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This MCP server no longer exists.");
      expect(screen.getByRole("button", { name: "Connect Aave" })).toBeEnabled();
    });

    /** Opens the page of a connected app and presses Disconnect, stopping at the confirmation. */
    async function askToDisconnect() {
      await openAppPage();
      fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
      return screen.findByRole("alertdialog");
    }

    it("names the app and the skill it is about to remove before removing either", async () => {
      window.openbot.skills = { ...window.openbot.skills, listInstalled: vi.fn(async () => [installedYield]) };
      window.openbot.agent = {
        ...window.openbot.agent,
        listMcpServers: vi.fn(async () => [hostApp()]),
        removeMcpServer: vi.fn(async () => []),
      };
      renderMarketplace({ ...writer, plugins: [withSkill] });
      const confirm = await askToDisconnect();

      expect(within(confirm).getByRole("heading", { name: "Disconnect Aave?" })).toBeInTheDocument();
      expect(within(confirm).getByText(appName)).toBeInTheDocument();
      expect(within(confirm).getByText("yield-analysis")).toBeInTheDocument();
      expect(window.openbot.agent.removeMcpServer).not.toHaveBeenCalled();
      expect(window.openbot.skills.uninstall).not.toHaveBeenCalled();
    });

    it("removes all app accounts before the agent's skill when the disconnect is confirmed", async () => {
      const order: string[] = [];
      let hostRows: McpServerConfig[] = [hostApp(), { ...hostApp(), id: "mcpacct-account-two", name: "Aave — 2" }];
      const removeMcpServer: OpenBotDesktopApi["agent"]["removeMcpServer"] = vi.fn(async ({ mcpServerId }) => {
        order.push(mcpServerId);
        hostRows = hostRows.filter((row) => row.id !== mcpServerId);
        return hostRows;
      });
      const uninstall = vi.fn(async () => {
        order.push("skill");
      });
      let held: InstalledSkill[] = [installedYield];
      window.openbot.skills = { ...window.openbot.skills, listInstalled: vi.fn(async () => held), uninstall };
      window.openbot.agent = { ...window.openbot.agent, listMcpServers: vi.fn(async () => hostRows), removeMcpServer };
      renderMarketplace({ ...writer, plugins: [withSkill] });
      const confirm = await askToDisconnect();
      held = [];
      fireEvent.click(within(confirm).getByRole("button", { name: "Disconnect" }));

      await waitFor(() => expect(uninstall).toHaveBeenCalledWith({ agentId: "writer", skillId: "skill-yield" }));
      expect(removeMcpServer).toHaveBeenCalledWith({ mcpServerId: "mcp-1" }, "local");
      expect(removeMcpServer).toHaveBeenCalledWith({ mcpServerId: "mcpacct-account-two" }, "local");
      // The app stops answering before the instructions that drive it are taken away.
      expect(order).toEqual(["mcp-1", "mcpacct-account-two", "skill"]);
      expect(await screen.findByRole("button", { name: "Connect Aave" })).toBeInTheDocument();
    });

    it("removes nothing when the confirmation is cancelled", async () => {
      window.openbot.skills = { ...window.openbot.skills, listInstalled: vi.fn(async () => [installedYield]) };
      window.openbot.agent = {
        ...window.openbot.agent,
        listMcpServers: vi.fn(async () => [hostApp()]),
        removeMcpServer: vi.fn(async () => []),
      };
      renderMarketplace({ ...writer, plugins: [withSkill] });
      const confirm = await askToDisconnect();
      fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(window.openbot.agent.removeMcpServer).not.toHaveBeenCalled();
      expect(window.openbot.skills.uninstall).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    });

    it.each([false, true])(
      "confirms one account's removal and keeps the other accounts and skills: %s",
      async (remove) => {
        const accountTwo = { ...hostApp(), id: "mcpacct-account-two", name: "Aave — 2" };
        let hostRows: McpServerConfig[] = [hostApp(), accountTwo];
        const removeMcpServer: OpenBotDesktopApi["agent"]["removeMcpServer"] = vi.fn(async ({ mcpServerId }) => {
          hostRows = hostRows.filter((row) => row.id !== mcpServerId);
          return hostRows;
        });
        const uninstall = vi.fn(async () => undefined);
        window.openbot.skills = {
          ...window.openbot.skills,
          listInstalled: vi.fn(async () => [installedYield]),
          uninstall,
        };
        window.openbot.agent = {
          ...window.openbot.agent,
          listMcpServers: vi.fn(async () => hostRows),
          removeMcpServer,
        };
        renderMarketplace({ ...writer, plugins: [withSkill] });
        await openAppPage();
        const account = await screen.findByRole("group", { name: appName });
        fireEvent.click(within(account).getByRole("button", { name: "Disconnect account" }));
        const confirm = await screen.findByRole("alertdialog", { name: `Remove ${appName}?` });
        expect(removeMcpServer).not.toHaveBeenCalled();
        fireEvent.click(within(confirm).getByRole("button", { name: remove ? "Disconnect account" : "Cancel" }));

        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        if (remove) {
          expect(removeMcpServer).toHaveBeenCalledExactlyOnceWith({ mcpServerId: "mcp-1" }, "local");
          expect(screen.queryByRole("group", { name: appName })).toBeNull();
        } else expect(removeMcpServer).not.toHaveBeenCalled();
        expect(screen.getByRole("group", { name: accountTwo.name })).toBeInTheDocument();
        expect(uninstall).not.toHaveBeenCalled();
      },
    );

    /**
     * A cleanup that half works. The skill must still go even though the app row refused, and the
     * failure must name what stayed.
     */
    it("reports what could not be removed and still removes the rest", async () => {
      const uninstall = vi.fn(async () => undefined);
      let held: InstalledSkill[] = [installedYield];
      window.openbot.skills = { ...window.openbot.skills, listInstalled: vi.fn(async () => held), uninstall };
      window.openbot.agent = {
        ...window.openbot.agent,
        listMcpServers: vi.fn(async () => [hostApp()]),
        removeMcpServer: vi.fn(async () => {
          throw new Error("This MCP server no longer exists.");
        }),
      };
      renderMarketplace({ ...writer, plugins: [withSkill] });
      const confirm = await askToDisconnect();
      held = [];
      fireEvent.click(within(confirm).getByRole("button", { name: "Disconnect" }));

      await waitFor(() => expect(uninstall).toHaveBeenCalledWith({ agentId: "writer", skillId: "skill-yield" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This MCP server no longer exists."));
      // What stayed still has a way out: the retry.
      expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    });

    /**
     * Names are unique on a host, so a server that the user wrote can own a catalog name and point
     * somewhere else. That row is not the plugin's: it shows as the user's own server, and its page
     * shows the address without the query, where a token can be.
     */
    it("keeps a server that only shares the app's name as the user's own", async () => {
      const mine = { ...hostApp(), id: "mcp-mine", url: "https://mcp.example.test/mine?token=secret-value" };
      const removeMcpServer: OpenBotDesktopApi["agent"]["removeMcpServer"] = vi.fn(async () => []);
      window.openbot.agent = { ...window.openbot.agent, listMcpServers: vi.fn(async () => [mine]), removeMcpServer };
      renderMarketplace({ ...writer, plugins: [plugin] });
      await openAppPage();

      expect(await screen.findByRole("button", { name: "Connect Aave" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Marketplace" }));
      fireEvent.click(await screen.findByRole("button", { name: `Open ${appName}` }));
      await screen.findByRole("heading", { name: appName, level: 3 });
      expect(screen.getByText("https://mcp.example.test/mine")).toBeInTheDocument();
      expect(screen.queryByText(/secret-value/u)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      const confirm = await screen.findByRole("dialog", { name: `Remove ${appName}?` });
      fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(removeMcpServer).toHaveBeenCalledWith({ mcpServerId: "mcp-mine" }, "local"));
    });

    /**
     * The deep link. A web page can name a listing, and that is all it can do: the page it opens
     * still asks the user to connect.
     */
    it("opens the listing a link names without connecting it", async () => {
      window.openbot.agent = { ...window.openbot.agent, listMcpServers: vi.fn(async () => []), saveMcpServer: vi.fn() };
      renderMarketplace({ ...writer, plugins: [plugin], initialPluginSlug: "aave" });

      expect(await screen.findByRole("button", { name: "Connect Aave" })).toBeInTheDocument();
      expect(screen.getByText(plugin.description)).toBeInTheDocument();
      expect(window.openbot.agent.saveMcpServer).not.toHaveBeenCalled();
    });

    it("says a link names no listing this catalog holds, and shows the apps", async () => {
      renderMarketplace({ ...writer, plugins: [plugin], initialPluginSlug: "not-a-plugin" });

      expect(await screen.findByText("This plugin is not in the OpenBot catalog.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open Aave" })).toBeInTheDocument();
    });

    it("reopens the same listing when its link arrives again after leaving it", async () => {
      window.openbot.agent = { ...window.openbot.agent, listMcpServers: vi.fn(async () => []), saveMcpServer: vi.fn() };
      const [slug, setSlug] = createSignal<string | null>("aave");
      const consumed = vi.fn();
      renderMarketplace(() => ({
        ...writer,
        plugins: [plugin],
        initialPluginSlug: slug() ?? undefined,
        onInitialPluginSlugConsumed: () => {
          consumed();
          setSlug(null);
        },
      }));

      expect(await screen.findByText(plugin.description)).toBeInTheDocument();
      await waitFor(() => expect(consumed).toHaveBeenCalled());
      await waitFor(() => expect(slug()).toBeNull());

      fireEvent.click(screen.getByRole("button", { name: "Marketplace" }));
      expect(await screen.findByRole("button", { name: "Open Aave" })).toBeInTheDocument();

      setSlug("aave");
      expect(await screen.findByText(plugin.description)).toBeInTheDocument();
    });

    it("forgets the open page when a link names no listing", async () => {
      window.openbot.agent = { ...window.openbot.agent, listMcpServers: vi.fn(async () => []), saveMcpServer: vi.fn() };
      const [slug, setSlug] = createSignal<string | null>("aave");
      renderMarketplace(() => ({
        ...writer,
        plugins: [plugin],
        initialPluginSlug: slug() ?? undefined,
        onInitialPluginSlugConsumed: () => setSlug(null),
      }));

      expect(await screen.findByText(plugin.description)).toBeInTheDocument();

      setSlug("not-a-plugin");
      expect(await screen.findByText("This plugin is not in the OpenBot catalog.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open Aave" })).toBeInTheDocument();
      expect(screen.queryByText(plugin.description)).toBeNull();
      expect(screen.queryByRole("button", { name: "Marketplace" })).toBeNull();
    });

    it("copies the address the public page answers on", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      renderMarketplace({ ...writer, plugins: [plugin] });
      await openAppPage();
      fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://openbot.run/plugins/aave"));
    });

    it("reports a link copy that the clipboard refuses", async () => {
      const writeText = vi.fn().mockRejectedValue(new DOMException("Document is not focused.", "NotAllowedError"));
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
      try {
        renderMarketplace({ ...writer, plugins: [plugin] });
        await openAppPage();
        fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));

        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not copy the link."));
      } finally {
        Reflect.deleteProperty(document, "execCommand");
      }
    });
  });
});
