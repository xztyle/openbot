import type { McpServerConfig } from "@openbot/contracts/ipc";
import type { McpChatGrant, McpChatSnapshot } from "@openbot/contracts/team-protocol/mcp-chat-v1";
import type { MarketplacePluginDetail } from "@openbot/ui/features/settings/marketplace-plugins";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import type { ComponentProps } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopAnalytics } from "../../analytics";
import { createMockEventCheckTemplates, PREVIEW_EVENT_CHECK_TEMPLATE } from "../../preview/mock-event-check-templates";
import { createMockEventChecks } from "../../preview/mock-event-checks";
import { MarketplaceModal } from "./MarketplaceModal";
import type { MarketplaceCalls } from "./marketplace-calls";
import { MARKETPLACE_PLUGINS } from "./marketplace-plugin-catalog";

const found = MARKETPLACE_PLUGINS.find((plugin) => plugin.slug === "linear");
if (!found) throw new Error("The catalog has no Linear listing.");
const linear: MarketplacePluginDetail = found;
const listing = linear.apps[0];
if (listing?.server.transport !== "http") throw new Error("The Linear listing must be an http app.");
const LINEAR_URL = listing.server.url;

const agents = [
  { id: "alpha", name: "Alpha", avatarSeed: "alpha", avatarHue: null, avatarUrl: null },
  { id: "beta", name: "Beta", avatarSeed: "beta", avatarHue: null, avatarUrl: null },
];

function account(id: string, name: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id,
    name,
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: LINEAR_URL,
    headers: [],
    ...overrides,
  };
}

const ONE = "mcpacct-00000000-0000-4000-8000-000000000001";
const TWO = "mcpacct-00000000-0000-4000-8000-000000000002";

/** The host, as far as the Marketplace asks: its MCP rows, and the chat grants of each agent. */
function host(initial: McpServerConfig[], grants: Record<string, McpChatGrant[]> = {}) {
  let rows = initial;
  const policy = { ...grants };
  const snapshot = (agentId: string): McpChatSnapshot => ({
    grants: (policy[agentId] ?? []).filter((grant) => rows.some((row) => row.id === grant.connectionId && row.enabled)),
    connections: rows.filter((row) => row.enabled).map(({ id, name }) => ({ id, name })),
  });
  const get = vi.fn(async (target: { kind: string; id: string }) => snapshot(target.id));
  const save = vi.fn(async (target: { kind: string; id: string }, next: McpChatGrant[]) => {
    policy[target.id] = next;
    return snapshot(target.id);
  });
  const mcp = {
    listMcpServers: vi.fn(async () => rows),
    saveMcpServer: vi.fn(async ({ config }: { config: McpServerConfig }) => {
      rows = rows.some((row) => row.id === config.id)
        ? rows.map((row) => (row.id === config.id ? config : row))
        : [...rows, config];
      return rows;
    }),
    setMcpServerEnabled: vi.fn(async ({ mcpServerId, enabled }: { mcpServerId: string; enabled: boolean }) => {
      rows = rows.map((row) => (row.id === mcpServerId ? { ...row, enabled } : row));
      return rows;
    }),
    removeMcpServer: vi.fn(async ({ mcpServerId }: { mcpServerId: string }) => {
      rows = rows.filter((row) => row.id !== mcpServerId);
      return rows;
    }),
    testMcpServer: vi.fn<MarketplaceCalls["mcp"]["testMcpServer"]>(async () => ({ toolCount: 7, error: null })),
    signInMcpServer: vi.fn<MarketplaceCalls["mcp"]["signInMcpServer"]>(async () => ({ toolCount: 7, error: null })),
  };
  return { mcp, get, save, policy, rows: () => rows };
}

function renderMarketplace(
  hostCalls: ReturnType<typeof host>,
  props: Partial<ComponentProps<typeof MarketplaceModal>> = {},
  options: { chatApps?: boolean; eventChecks?: MarketplaceCalls["eventChecks"] } = {},
) {
  const calls: MarketplaceCalls = {
    skills: { list: async () => ({ skills: [], nextCursor: null }), get: vi.fn() },
    agents: { list: async () => ({ agents: [], nextCursor: null }), get: vi.fn() },
    agentSkills: () => ({
      listInstalled: async () => [],
      install: vi.fn(),
      uninstall: vi.fn(),
      setEnabled: vi.fn(),
    }),
    mcp: { ...hostCalls.mcp, supportsRemoteSignIn: () => false },
    addAgent: vi.fn(),
    openUrl: async () => undefined,
    chatApps: options.chatApps === false ? undefined : () => ({ get: hostCalls.get, save: hostCalls.save }),
    eventChecks: options.eventChecks,
  };
  return render(() => (
    <MarketplaceModal
      open
      calls={calls}
      agents={agents}
      activeAgentId="alpha"
      pluginServerId="local"
      plugins={[linear]}
      onOpenChange={() => undefined}
      {...props}
    />
  ));
}

async function openLinear() {
  await openApp("Linear");
}

async function openApp(name: string) {
  fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
  /* The card moves to another group when the host's rows arrive, and a press on the old card is lost.
     So the press repeats until the page is there. */
  await waitFor(() => {
    const open = screen.queryByRole("button", { name: `Open ${name}` });
    if (open) fireEvent.click(open);
    expect(screen.getByRole("heading", { name, level: 3 })).toBeInTheDocument();
  });
}

/** The three choices of one agent for one account. */
async function choices(agent: string, accountName: string) {
  return within(await screen.findByRole("group", { name: `${agent}, ${accountName}` }));
}

describe("Marketplace app accounts", () => {
  beforeEach(() => {
    vi.spyOn(desktopAnalytics, "scope").mockImplementation(() => ({ track: vi.fn() }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("status and controls", () => {
    it("reads an app whose accounts are all off as disabled, and turns the account back on", async () => {
      const calls = host([account(ONE, "Linear — 1", { enabled: false })]);
      renderMarketplace(calls);
      await openLinear();

      expect(screen.getByText("Disabled", { selector: ".integration-status" })).toBeInTheDocument();
      expect(screen.queryByText("Connected", { selector: ".integration-status" })).toBeNull();
      fireEvent.click(screen.getByRole("switch", { name: "Enable Linear — 1" }));

      await waitFor(() =>
        expect(calls.mcp.setMcpServerEnabled).toHaveBeenCalledExactlyOnceWith(
          { mcpServerId: ONE, enabled: true },
          "local",
        ),
      );
      expect(await screen.findByText("Connected", { selector: ".integration-status" })).toBeInTheDocument();
    });

    it("signs in again with the id of the row it already has", async () => {
      const calls = host([account(ONE, "Linear — 1")]);
      renderMarketplace(calls);
      await openLinear();
      fireEvent.click(screen.getByRole("button", { name: "Sign in again to Linear — 1" }));
      fireEvent.click(await screen.findByRole("button", { name: "Continue to Linear" }));

      await waitFor(() => expect(calls.mcp.signInMcpServer).toHaveBeenCalled());
      expect(calls.mcp.signInMcpServer.mock.lastCall?.[0].config).toMatchObject({ id: ONE, name: "Linear — 1" });
      // The row is the same one, so nothing is saved and no new connection exists.
      expect(calls.mcp.saveMcpServer).not.toHaveBeenCalled();
      expect(calls.rows().map((row) => row.id)).toEqual([ONE]);
    });

    it("renames an account in place", async () => {
      const calls = host([account(ONE, "Linear — 1")]);
      renderMarketplace(calls);
      await openLinear();
      fireEvent.click(screen.getByRole("button", { name: "Rename Linear — 1" }));
      fireEvent.input(await screen.findByRole("textbox", { name: "Connection name" }), {
        target: { value: "Linear — Work" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(calls.mcp.saveMcpServer).toHaveBeenCalled());
      expect(calls.mcp.saveMcpServer.mock.lastCall?.[0].config).toMatchObject({ id: ONE, name: "Linear — Work" });
      expect(await screen.findByRole("group", { name: "Linear — Work" })).toBeInTheDocument();
    });

    it("says what a check of an account found", async () => {
      const calls = host([account(ONE, "Linear — 1")]);
      calls.mcp.testMcpServer.mockResolvedValueOnce({ toolCount: 0, error: "The token was refused." });
      renderMarketplace(calls);
      await openLinear();
      fireEvent.click(screen.getByRole("button", { name: "Check the connection of Linear — 1" }));

      expect(await screen.findByText("Does not work. The token was refused.")).toBeInTheDocument();
      expect(screen.getByText("Needs attention", { selector: ".integration-status" })).toBeInTheDocument();

      // Back on the list the app is reviewed, not connected again: a second connection would be a new
      // account with none of the chat access of this one.
      fireEvent.click(screen.getByRole("button", { name: "Marketplace" }));
      expect(await screen.findByRole("button", { name: "Review Linear" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reconnect Linear" })).toBeNull();
    });
  });

  describe("update to the current listing", () => {
    const OLD_URL = "https://mcp.linear.app/sse";
    const bumped: MarketplacePluginDetail = {
      ...linear,
      apps: linear.apps.map((app) =>
        app.server.transport === "http" ? { ...app, server: { ...app.server, supersedes: [{ url: OLD_URL }] } } : app,
      ),
    };
    const slack = MARKETPLACE_PLUGINS.find((plugin) => plugin.slug === "slack");
    const slackApp = slack?.apps[0];
    if (!slack || slackApp?.server.transport !== "stdio") throw new Error("The Slack listing must run a command.");
    const CURRENT = { command: slackApp.server.command, args: slackApp.server.args };
    const OLD = { command: "npx", args: ["-y", "slack-mcp-server@1.2.0", "--transport", "stdio"] };
    const slackBumped: MarketplacePluginDetail = {
      ...slack,
      apps: [{ ...slackApp, server: { ...slackApp.server, supersedes: [OLD] } }],
    };
    const token = [{ key: "SLACK_MCP_XOXP_TOKEN", value: "xoxp-keep-me" }];
    const slackRow = (overrides: Partial<McpServerConfig> = {}) =>
      account(ONE, "Slack — Job A", {
        transport: "stdio",
        url: "",
        command: OLD.command,
        args: OLD.args,
        env: token,
        ...overrides,
      });

    it("tests the new words, then moves a command in place and keeps the account as it is", async () => {
      const calls = host([slackRow()]);
      renderMarketplace(calls, { plugins: [slackBumped] });
      await openApp("Slack");

      expect(screen.getByText("Update available", { selector: ".z-badge" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Update the connection of Slack" }));

      await waitFor(() => expect(calls.mcp.saveMcpServer).toHaveBeenCalled());
      expect(calls.mcp.testMcpServer.mock.lastCall?.[0].config).toMatchObject({ args: CURRENT.args });
      // The id, the name and the credential stay, so the chat access of the row stays too.
      expect(calls.mcp.saveMcpServer.mock.lastCall?.[0].config).toEqual(slackRow(CURRENT));
    });

    it("saves nothing when the new version does not start", async () => {
      const calls = host([slackRow()]);
      calls.mcp.testMcpServer.mockResolvedValueOnce({ toolCount: 0, error: "It did not start." });
      renderMarketplace(calls, { plugins: [slackBumped] });
      await openApp("Slack");
      fireEvent.click(screen.getByRole("button", { name: "Update the connection of Slack" }));

      expect(await screen.findAllByText(/It did not start\./u)).not.toHaveLength(0);
      expect(calls.mcp.saveMcpServer).not.toHaveBeenCalled();
    });

    it("moves an address without a test, because its sign-in belongs to the old address", async () => {
      const secret = [{ key: "Authorization", value: "Bearer keep-me" }];
      const calls = host([account(ONE, "Linear — 1", { url: OLD_URL, headers: secret })]);
      renderMarketplace(calls, { plugins: [bumped] });
      await openLinear();
      fireEvent.click(screen.getByRole("button", { name: "Update the connection of Linear" }));

      await waitFor(() => expect(calls.mcp.saveMcpServer).toHaveBeenCalled());
      expect(calls.mcp.testMcpServer).not.toHaveBeenCalled();
      expect(calls.mcp.saveMcpServer.mock.lastCall?.[0].config).toEqual(
        account(ONE, "Linear — 1", { url: LINEAR_URL, headers: secret }),
      );
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "1 account of Linear updated. Sign in again if the app asks.",
        ),
      );
    });
  });

  describe("chat access", () => {
    it("starts every chat Off and changes nothing until a mode is pressed", async () => {
      const calls = host([account(ONE, "Linear — 1")]);
      renderMarketplace(calls);
      await openLinear();

      const alpha = await choices("Alpha", "Linear — 1");
      expect(alpha.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
      expect(alpha.getByRole("button", { name: "Read only" })).toHaveAttribute("aria-pressed", "false");
      expect(calls.save).not.toHaveBeenCalled();
    });

    it("saves one change on top of the policy the host holds now", async () => {
      const other = account(TWO, "Slack — 1", { url: "https://example.com/mcp" });
      const calls = host([account(ONE, "Linear — 1"), other], { alpha: [{ connectionId: TWO, mode: "write" }] });
      renderMarketplace(calls);
      await openLinear();
      fireEvent.click((await choices("Alpha", "Linear — 1")).getByRole("button", { name: "Read only" }));

      await waitFor(() => expect(calls.save).toHaveBeenCalled());
      // Another account's choice for the same chat is kept; the other agent is not touched.
      expect(calls.save).toHaveBeenCalledExactlyOnceWith({ kind: "agent", id: "alpha" }, [
        { connectionId: TWO, mode: "write" },
        { connectionId: ONE, mode: "read" },
      ]);
      await waitFor(async () =>
        expect((await choices("Alpha", "Linear — 1")).getByRole("button", { name: "Read only" })).toHaveAttribute(
          "aria-pressed",
          "true",
        ),
      );
      expect((await choices("Beta", "Linear — 1")).getByRole("button", { name: "Off" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("names the failure and keeps the choice Off when the host refuses", async () => {
      const calls = host([account(ONE, "Linear — 1")]);
      calls.save.mockRejectedValueOnce(new Error("The host could not refresh its agents."));
      renderMarketplace(calls);
      await openLinear();
      fireEvent.click((await choices("Alpha", "Linear — 1")).getByRole("button", { name: "Allow changes" }));

      expect(await screen.findAllByText("The host could not refresh its agents.")).not.toHaveLength(0);
      expect((await choices("Alpha", "Linear — 1")).getByRole("button", { name: "Off" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("shows no controls when the host cannot limit apps for each chat", async () => {
      const calls = host([account(ONE, "Linear — 1")]);
      renderMarketplace(calls, {}, { chatApps: false });
      await openLinear();

      await screen.findByRole("group", { name: "Linear — 1" });
      expect(screen.queryByRole("heading", { name: "Chat access" })).toBeNull();
    });

    it("offers one step for the open chat after a connect, and grants nothing by itself", async () => {
      const calls = host([]);
      renderMarketplace(calls);
      await openLinear();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Linear" }));
      fireEvent.click(await screen.findByRole("button", { name: "Continue to Linear" }));

      expect(await screen.findByRole("heading", { name: "Allow for Alpha" })).toBeInTheDocument();
      // Off is the answer until the user presses a mode.
      expect(calls.save).not.toHaveBeenCalled();
      const step = within(screen.getByRole("region", { name: "Allow for Alpha" }));
      fireEvent.click(step.getByRole("button", { name: "Read only" }));

      await waitFor(() =>
        expect(calls.save).toHaveBeenCalledExactlyOnceWith({ kind: "agent", id: "alpha" }, [
          { connectionId: expect.stringMatching(/^mcpacct-/u), mode: "read" },
        ]),
      );
      await waitFor(() => expect(screen.queryByRole("region", { name: "Allow for Alpha" })).toBeNull());
    });
  });

  describe("event checks of the app", () => {
    it("lists the templates that read this app, and opens one", async () => {
      const checks = createMockEventChecks();
      const templates = createMockEventCheckTemplates(checks);
      const calls = host([account(ONE, "Linear — 1")]);
      renderMarketplace(
        calls,
        { eventChecksHost: { serverId: undefined } },
        { eventChecks: () => ({ templates, checks }) },
      );
      await openLinear();

      const section = within(await screen.findByRole("region", { name: "Event checks for this app" }));
      fireEvent.click(section.getByRole("button", { name: `Open ${PREVIEW_EVENT_CHECK_TEMPLATE.name}` }));
      expect(
        await screen.findByRole("heading", { name: PREVIEW_EVENT_CHECK_TEMPLATE.name, level: 3 }),
      ).toBeInTheDocument();
    });

    it("shows nothing for an app that no template reads", async () => {
      const checks = createMockEventChecks();
      const templates = createMockEventCheckTemplates(checks);
      vi.spyOn(templates, "list").mockResolvedValue([]);
      renderMarketplace(
        host([account(ONE, "Linear — 1")]),
        { eventChecksHost: { serverId: undefined } },
        { eventChecks: () => ({ templates, checks }) },
      );
      await openLinear();

      await screen.findByRole("region", { name: "Chat access" });
      expect(screen.queryByRole("region", { name: "Event checks for this app" })).toBeNull();
    });
  });

  describe("skill updates", () => {
    const listing = (id: string, name: string) => ({
      id,
      slug: id,
      name,
      description: `${name} skill.`,
      category: "documents" as const,
      creatorName: "Ada",
      version: 3,
      installs: 1,
      featured: false,
      iconUrl: null,
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    const held = (skillId: string, name: string, state: "installed" | "update-available" | "modified") => ({
      skillId,
      slug: skillId,
      name,
      installedVersion: 2,
      availableVersion: 3,
      state,
      enabled: true,
    });

    it("badges a skill with an update, updates them all, and leaves a modified skill alone", async () => {
      const install = vi.fn(async () => held("notes", "Notes", "installed"));
      const calls = host([]);
      const hostCalls: MarketplaceCalls = {
        skills: {
          list: async () => ({
            skills: [listing("notes", "Notes"), listing("brief", "Brief"), listing("draft", "Draft")],
            nextCursor: null,
          }),
          get: vi.fn(),
        },
        agents: { list: async () => ({ agents: [], nextCursor: null }), get: vi.fn() },
        agentSkills: () => ({
          listInstalled: async (agentId) =>
            agentId === "alpha"
              ? [
                  held("notes", "Notes", "update-available"),
                  held("brief", "Brief", "modified"),
                  held("draft", "Draft", "installed"),
                ]
              : [],
          install,
          uninstall: vi.fn(),
          setEnabled: vi.fn(),
        }),
        mcp: calls.mcp,
        addAgent: vi.fn(),
        openUrl: async () => undefined,
      };
      render(() => (
        <MarketplaceModal open calls={hostCalls} agents={agents} activeAgentId="alpha" onOpenChange={() => undefined} />
      ));
      fireEvent.click(screen.getByRole("tab", { name: "Skills" }));

      // Only the skill the host reports as updatable counts: a modified skill keeps its changes.
      expect(await screen.findByText("1 installed skill has an update.")).toBeInTheDocument();
      const notes = within(await screen.findByRole("article", { name: "Notes" }));
      expect(notes.getByText("Update available")).toBeInTheDocument();
      expect(within(screen.getByRole("article", { name: "Brief" })).queryByText("Update available")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Update all" }));
      await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
      expect(install).toHaveBeenCalledWith({ agentId: "alpha", skillId: "notes", replaceModified: false });
    });
  });

  describe("plugin skills", () => {
    const skill = {
      id: "skill-triage",
      versionId: "skill-triage-v1",
      slug: "triage",
      description: "How to triage Linear issues.",
    };

    it("installs the pinned skills on a second agent from the page of the app", async () => {
      const install = vi.fn(async () => ({
        skillId: skill.id,
        slug: skill.slug,
        name: "Triage",
        installedVersion: 1,
        availableVersion: 1,
        state: "installed" as const,
        enabled: true,
      }));
      const calls = host([account(ONE, "Linear — 1")]);
      const hostCalls: MarketplaceCalls = {
        skills: { list: async () => ({ skills: [], nextCursor: null }), get: vi.fn() },
        agents: { list: async () => ({ agents: [], nextCursor: null }), get: vi.fn() },
        agentSkills: () => ({
          listInstalled: async (agentId) => (agentId === "alpha" ? [await install()] : []),
          install,
          uninstall: vi.fn(),
          setEnabled: vi.fn(),
        }),
        mcp: calls.mcp,
        addAgent: vi.fn(),
        openUrl: async () => undefined,
      };
      render(() => (
        <MarketplaceModal
          open
          calls={hostCalls}
          agents={agents}
          activeAgentId="alpha"
          pluginServerId="local"
          plugins={[{ ...linear, skills: [skill] }]}
          onOpenChange={() => undefined}
        />
      ));
      await openLinear();
      install.mockClear();
      fireEvent.pointerDown(await screen.findByRole("button", { name: /Linear skills/u }), { button: 0 });
      fireEvent.pointerUp(await screen.findByRole("menuitemcheckbox", { name: /^Beta/u }), { button: 0 });

      await waitFor(() =>
        expect(install).toHaveBeenCalledWith({ agentId: "beta", skillId: skill.id, versionId: skill.versionId }),
      );
      // The agent that already had the skills is not asked again.
      expect(install).not.toHaveBeenCalledWith(expect.objectContaining({ agentId: "alpha" }));
    });
  });

  describe("browse", () => {
    it("shows how many accounts an app has on its card", async () => {
      const calls = host([account(ONE, "Linear — 1"), account(TWO, "Linear — 2")]);
      renderMarketplace(calls);
      fireEvent.click(screen.getByRole("tab", { name: "Apps" }));

      expect(await screen.findByText(/2 accounts/u)).toBeInTheDocument();
    });

    it("finds an app by a word of its description and by its category", async () => {
      const calls = host([]);
      renderMarketplace(calls);
      fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
      const search = await screen.findByRole("searchbox", { name: "Search the marketplace" });

      fireEvent.input(search, { target: { value: "backlog" } });
      expect(await screen.findByRole("button", { name: "Open Linear" })).toBeInTheDocument();
      fireEvent.input(search, { target: { value: "coding" } });
      expect(await screen.findByRole("button", { name: "Open Linear" })).toBeInTheDocument();
      fireEvent.input(search, { target: { value: "no app has this word" } });
      await waitFor(() => expect(screen.queryByRole("button", { name: "Open Linear" })).toBeNull());
    });
  });
});
