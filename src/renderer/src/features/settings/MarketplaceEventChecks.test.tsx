import type { EventCheckTemplateInstallInput } from "@openbot/contracts/event-check-templates";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockEventCheckTemplates, PREVIEW_EVENT_CHECK_TEMPLATE } from "../../preview/mock-event-check-templates";
import { createMockEventChecks } from "../../preview/mock-event-checks";
import { MarketplaceModal } from "./MarketplaceModal";
import type { MarketplaceCalls } from "./marketplace-calls";

const SECRET = "tok-1234-secret";

/** The calls of a host with one template. The catalog, agents and apps are empty: only the new tab is in use. */
function setup(
  options: { failFor?: string; seed?: (checks: ReturnType<typeof createMockEventChecks>) => Promise<void> } = {},
) {
  const checks = createMockEventChecks();
  const templates = createMockEventCheckTemplates(checks);
  const seeded = options.seed?.(checks);
  const installOnHost = templates.install;
  const install = vi.spyOn(templates, "install").mockImplementation(async (input) => {
    if (input.agentId === options.failFor) throw new Error("Install exploded.");
    return installOnHost(input);
  });
  const setEnvironment = vi.spyOn(checks, "setEnvironment");
  const calls: MarketplaceCalls = {
    skills: { list: async () => ({ skills: [], nextCursor: null }), get: vi.fn() },
    agents: { list: async () => ({ agents: [], nextCursor: null }), get: vi.fn() },
    agentSkills: () => ({
      listInstalled: async () => [],
      install: vi.fn(),
      uninstall: vi.fn(),
      setEnabled: vi.fn(),
    }),
    mcp: {
      listMcpServers: async () => [],
      removeMcpServer: async () => [],
      saveMcpServer: async () => [],
      testMcpServer: vi.fn(),
      signInMcpServer: vi.fn(),
    },
    addAgent: vi.fn(),
    openUrl: async () => undefined,
    eventChecks: () => ({ templates, checks }),
  };
  render(() => (
    <MarketplaceModal
      open
      calls={calls}
      eventChecksHost={{ serverId: undefined }}
      agents={[
        { id: "alpha", name: "Alpha", avatarSeed: "alpha", avatarHue: null, avatarUrl: null },
        { id: "beta", name: "Beta", avatarSeed: "beta", avatarHue: null, avatarUrl: null },
      ]}
      activeAgentId="alpha"
      onOpenChange={() => undefined}
    />
  ));
  return { install, setEnvironment, templates, seeded };
}

/** A check of an agent, as the host keeps it. `version` absent: the check has no template link. */
async function seedCheck(
  checks: ReturnType<typeof createMockEventChecks>,
  input: { agentId: string; name: string; account: string; version?: string },
) {
  await checks.save({
    agentId: input.agentId,
    name: input.name,
    instruction: "Tell me what changed.",
    active: false,
    timezone: "UTC",
    schedule: { kind: "interval", amount: 60, unit: "seconds", anchorAt: "2026-01-01T00:00:00.000Z" },
    selfEvents: { mode: "exclude", connectionId: input.account, actorPointer: "/actor/id", accountActorIds: [] },
    source: {
      kind: "api",
      connectionId: input.account,
      variables: [],
      configuration: [],
      toolName: PREVIEW_EVENT_CHECK_TEMPLATE.program.file,
      argumentsJson: "{}",
      cursorArgument: "cursor",
      nextCursorPointer: "/cursor",
      ...(input.version ? { template: { slug: PREVIEW_EVENT_CHECK_TEMPLATE.slug, version: input.version } } : {}),
    },
    selection: PREVIEW_EVENT_CHECK_TEMPLATE.selection,
  });
}

async function openTemplatePage() {
  fireEvent.click(await screen.findByRole("tab", { name: "Event checks" }));
  fireEvent.click(await screen.findByRole("button", { name: `Open ${PREVIEW_EVENT_CHECK_TEMPLATE.name}` }));
}

async function openInstallDialog() {
  await openTemplatePage();
  fireEvent.click(await screen.findByRole("button", { name: "Install" }));
}

function type(name: RegExp, value: string) {
  fireEvent.input(screen.getByRole("textbox", { name }), { target: { value } });
}

describe("Marketplace event check templates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks the install until the required values are in", async () => {
    const { install } = setup();
    await openInstallDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Install on 1 agent" }));
    expect(await screen.findAllByText("This field is required.")).toHaveLength(2);
    expect(install).not.toHaveBeenCalled();

    // The label alone is not enough: the template also needs its team key.
    type(/^Account label/u, "Work");
    fireEvent.click(screen.getByRole("button", { name: "Install on 1 agent" }));
    expect(await screen.findAllByText("This field is required.")).toHaveLength(1);
    expect(install).not.toHaveBeenCalled();
  });

  it("installs once for each agent, then sets the private variable apart from the install", async () => {
    const { install, setEnvironment } = setup();
    await openInstallDialog();

    type(/^Account label/u, "Work");
    type(/^Team key/u, "ENG");
    type(/^Your verified user IDs/u, "user-1, user-2\nuser-1");
    fireEvent.click(screen.getByRole("checkbox", { name: /Beta/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Install on 2 agents" }));

    await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    const sent = install.mock.calls.map(([input]) => input);
    expect(sent.map((input) => input.agentId)).toEqual(["alpha", "beta"]);
    const expected: Omit<EventCheckTemplateInstallInput, "agentId" | "timezone"> = {
      slug: PREVIEW_EVENT_CHECK_TEMPLATE.slug,
      name: `${PREVIEW_EVENT_CHECK_TEMPLATE.name} — Work`,
      accountLabel: "Work",
      instruction: PREVIEW_EVENT_CHECK_TEMPLATE.instruction,
      intervalSeconds: PREVIEW_EVENT_CHECK_TEMPLATE.intervalSeconds,
      accountActorIds: ["user-1", "user-2"],
      configuration: { teamKey: "ENG", projectFilter: "" },
    };
    for (const input of sent) expect(input).toMatchObject(expected);
    expect(setEnvironment).not.toHaveBeenCalled();

    // Second step: one masked field for each created check. The value goes to `setEnvironment` only.
    const [field, other] = await screen.findAllByLabelText(/SAMPLE_API_TOKEN/u);
    expect(other).toBeDefined();
    expect(field).toHaveAttribute("type", "password");
    if (!field) throw new Error("The masked field is missing.");
    fireEvent.input(field, { target: { value: SECRET } });
    const [save] = screen.getAllByRole("button", { name: "Save value" });
    if (!save) throw new Error("The save button is missing.");
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(setEnvironment).toHaveBeenCalledTimes(1));
    expect(setEnvironment).toHaveBeenCalledWith(expect.objectContaining({ name: "SAMPLE_API_TOKEN", value: SECRET }));
    expect(JSON.stringify(install.mock.calls)).not.toContain(SECRET);
    expect(screen.getByText(/The checks were created paused/u)).toBeInTheDocument();
  });

  it("keeps the checks that were created when one agent fails, and retries only the failed agent", async () => {
    const { install } = setup({ failFor: "beta" });
    await openInstallDialog();

    type(/^Account label/u, "Work");
    type(/^Team key/u, "ENG");
    fireEvent.click(screen.getByRole("checkbox", { name: /Beta/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Install on 2 agents" }));

    expect(await screen.findByText("Beta: Install exploded.")).toBeInTheDocument();
    expect(await screen.findAllByLabelText(/SAMPLE_API_TOKEN/u)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Try the failed agents again" }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(3));
    expect(install.mock.calls.map(([input]) => input.agentId)).toEqual(["alpha", "beta", "beta"]);
  });

  it("updates an older copy after a baseline warning, and links a check the user made", async () => {
    const { templates, seeded } = setup({
      seed: async (checks) => {
        await seedCheck(checks, { agentId: "alpha", name: "Old copy", account: "Work", version: "1" });
        await seedCheck(checks, { agentId: "beta", name: "My own watcher", account: "Mine" });
      },
    });
    await seeded;
    await openTemplatePage();

    expect(await screen.findByText("Alpha · Work")).toBeInTheDocument();
    expect(screen.getByText("Update available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update Old copy" }));
    expect(await screen.findByText(/The check gets a fresh baseline/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update and reset baseline" }));
    expect(await screen.findByText(/is on version 2\. It has a fresh baseline\./u)).toBeInTheDocument();
    expect(screen.queryByText("Update available")).not.toBeInTheDocument();

    const adopt = vi.spyOn(templates, "adopt");
    fireEvent.click(await screen.findByRole("button", { name: "Link My own watcher to this template" }));
    await waitFor(() =>
      expect(adopt).toHaveBeenCalledWith({
        agentId: "beta",
        id: expect.any(String),
        slug: PREVIEW_EVENT_CHECK_TEMPLATE.slug,
      }),
    );
    expect(await screen.findByText("Beta · Mine")).toBeInTheDocument();
  });
});
