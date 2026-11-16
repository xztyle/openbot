// Checks the spaces routes of the Team API (`workspace-spaces-v1`, under `fork-host-v1`), the path
// that the web client and a remote desktop client take. A real `TeamApiServer` runs on loopback with
// the real team, agent, mailbox, sidebar and roles stores on a temporary profile. Each request and
// answer goes through the frozen wire codec. The owner makes, changes and deletes spaces; a member
// reads only the agents that the roles let them see, may not change a space, and gets the
// `workspace-spaces-changed` event on their socket. The last step checks the space values that an
// MCP row gets (`{{space.id}}`, `{{space.name}}`), which Motion uses to keep each space apart.
// The agent service is not initialized, so no provider CLI starts.
// Run: `bun scripts/spaces-team-api-e2e.ts`. Writes .openbot-build/spaces-team-api-e2e/report.json.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GENERAL_SPACE_ID, type McpServerConfig } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_V1_WEBSOCKET,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol";
import { AGENT_ACCESS_CODECS, AGENT_ACCESS_ROUTES } from "@openbot/contracts/team-protocol/agent-access-v1";
import { TEAM_CURRENT_CAPABILITIES } from "@openbot/contracts/team-protocol/current";
import { TEAM_PROTOCOL_V7 } from "@openbot/contracts/team-protocol/v7";
import {
  WORKSPACE_SPACES_CAPABILITY,
  WORKSPACE_SPACES_CODECS,
  WORKSPACE_SPACES_ROUTES,
  workspaceSpacesEvent,
} from "@openbot/contracts/team-protocol/workspace-spaces-v1";
import { sourceText } from "@openbot/i18n/source";
import { plugin } from "bun";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import type { TeamApiBrowser } from "../src/main/team-api/dependencies";

const OUT = resolve(import.meta.dirname, "../.openbot-build/spaces-team-api-e2e");
const HOST_VERSION = "0.0.0-e2e";
const OWNER = { username: "owner-user", password: "owner-password-123" };
const MEMBER = { username: "member-user", password: "member-password-123" };
const STEP_DEADLINE_MS = 30_000;

// The main process imports Electron for its windows and IPC. No check here opens a window.
plugin({
  name: "spaces-team-api-electron-boundary",
  setup(build) {
    class Inert {}
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: { getPath: () => tmpdir(), getVersion: () => HOST_VERSION, isPackaged: false, on: () => undefined },
        BrowserWindow: Object.assign(class extends Inert {}, { getAllWindows: () => [] }),
        MessageChannelMain: class extends Inert {},
        Notification: Object.assign(class extends Inert {}, { isSupported: () => false }),
        clipboard: {},
        dialog: {},
        ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
        nativeImage: {},
        net: {},
        powerMonitor: { on: () => undefined },
        safeStorage: { isEncryptionAvailable: () => false },
        screen: {},
        session: {},
        shell: { openExternal: async () => undefined },
        systemPreferences: {},
        webContents: { getAllWebContents: () => [] },
      },
    }));
  },
});

const { TeamApiServer } = await import("../src/main/team-api-server");
const { AGENT_ACCESS_FILE, AgentAccessStore } = await import("../src/main/agent-access-store");
const { TeamStore } = await import("../src/main/team-store");

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; unverified: string[]; steps: Step[] } = {
  passed: false,
  unverified: [
    "The WebRTC transport of the web client. It carries the same requests to the same route handler that this check calls over loopback HTTP.",
    "`create-agent` and `place-channel`. Both start agent or channel work that needs the initialized agent service.",
  ],
  steps: [],
};

/** Runs one check. `summarize` keeps session tokens out of the report. */
async function step<T>(
  name: string,
  run: () => Promise<T>,
  summarize: (value: T) => unknown = (value) => value,
): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // A bound on failure only: each check waits for its reply or event, and a missing event must fail.
    const value = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`No result within ${STEP_DEADLINE_MS} ms.`)), STEP_DEADLINE_MS);
      }),
    ]);
    report.steps.push({ name, passed: true, detail: summarize(value) });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

/** A value that `JSON.parse` gives: the wire body of a response, a frame or a fixture. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonObject {
  assert.ok(isRecord(value), `${label} is not an object.`);
  return value;
}

function text(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} is not text.`);
  return String(value);
}

const unused = () => Effect.die(new Error("Not used by this check."));
const agentBrowser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};
const teamBrowser: TeamApiBrowser = {
  listTabs: () => [],
  getControlState: () => ({ sessions: [] }),
  open: unused,
  activate: unused,
  navigate: unused,
  reload: unused,
  stop: unused,
  takeUserControl: unused,
  releaseUserControl: () => {},
  releaseUserControlHeldBy: () => {},
  close: unused,
  capturePreview: unused,
  setVisible: unused,
  getDisplayState: () => ({ tabs: [], activeTabId: null }),
  loadUrl: unused,
  isPrivate: () => false,
  startView: unused,
  dispatchViewInput: unused,
  copyViewSelection: unused,
  importSignIn: unused,
};

const root = await mkdtemp(join(tmpdir(), "openbot-spaces-team-api-"));
const userData = join(root, "user-data");
const home = join(root, "home");

interface Host {
  database: OpenBotDatabase;
  agents: AgentService;
  server: InstanceType<typeof TeamApiServer>;
  team: InstanceType<typeof TeamStore>;
  port: number;
}

let host: Host | null = null;
const sockets: WebSocket[] = [];

/** Starts the host on the profile, as the app does at launch, with the spaces wired as the app wires them. */
async function startHost(): Promise<Host> {
  const database = new OpenBotDatabase(userData);
  const agentStore = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, agentStore.sharedRoot, agentStore.database);
  const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
  const team = new TeamStore(join(userData, "openbot-team-server-v2.json"));
  const access = new AgentAccessStore(join(userData, AGENT_ACCESS_FILE));
  await runCauseEffect(sidebar.initialize());
  // The stores only: `AgentService.initialize` would start the provider CLIs, which no step needs.
  await runCauseEffect(agentStore.initialize());
  await runCauseEffect(mailbox.initialize());
  await runCauseEffect(team.initialize());
  assert.equal(await runCauseEffect(access.load()), true, "The roles file did not load.");
  if (!team.getIdentity()) await runCauseEffect(team.configure("E2E Host", OWNER.username, OWNER.password));
  const agents = new AgentService({ store: agentStore, mailbox, browser: agentBrowser, sidebarLayout: sidebar });
  const server = new TeamApiServer({
    store: team,
    agents,
    mailbox,
    browser: teamBrowser,
    sidebarLayout: sidebar,
    appVersion: HOST_VERSION,
    hiddenAgents: agents,
    agentAccess: access,
    spaces: {
      service: agents.spaces,
      channel: (channelId) => (agents.channels.store.exists(channelId) ? agents.channels.store.get(channelId) : null),
    },
  });
  const port = await Effect.runPromise(server.start());
  return { database, agents, server, team, port };
}

async function stopHost(): Promise<void> {
  if (!host) return;
  const stopping = host;
  host = null;
  await Effect.runPromise(stopping.server.stop()).catch(() => undefined);
  await runCauseEffect(stopping.agents.stop()).catch(() => undefined);
  stopping.database.close();
}

function current(): Host {
  assert.ok(host, "The host is not running.");
  return host;
}

/** One request from a current client, which advertises `fork-host-v1`. */
async function call(
  method: string,
  path: string,
  input: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    [TEAM_PROTOCOL_VERSION_HEADER]: String(TEAM_PROTOCOL_V7),
    [TEAM_APP_VERSION_HEADER]: HOST_VERSION,
    [TEAM_CAPABILITIES_HEADER]: TEAM_CURRENT_CAPABILITIES.join(","),
  };
  if (input.body !== undefined) headers["Content-Type"] = "application/json";
  if (input.token) headers.Authorization = `Bearer ${input.token}`;
  const response = await fetch(`http://127.0.0.1:${current().port}${path}`, {
    method,
    headers,
    body: input.body === undefined ? null : JSON.stringify(input.body),
  });
  const body = await response.text();
  return { status: response.status, body: body ? JSON.parse(body) : null };
}

/** A spaces request through the frozen codec, in both directions, as the clients send it. */
async function spaces(path: string, token: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const codec = WORKSPACE_SPACES_CODECS.get(path);
  assert.ok(codec, `No workspace-spaces-v1 codec for ${path}.`);
  codec.request(body);
  const response = await call("POST", path, { token, body });
  return { status: response.status, body: codec.response(response.status, response.body) };
}

interface Placement {
  spaces: { id: string; name: string }[];
  agents: Map<string, string>;
}

/** The spaces that a member reads, and the space of each agent they see. */
async function readSpaces(token: string): Promise<Placement> {
  const response = await spaces(WORKSPACE_SPACES_ROUTES.read, token, {});
  assert.equal(response.status, 200, `Reading the spaces returned ${response.status}.`);
  const body = record(response.body, "spaces");
  assert.ok(Array.isArray(body.spaces) && Array.isArray(body.agents), "The spaces answer has no lists.");
  const placed = body.agents.map((item) => {
    const entry = record(item, "agent placement");
    return [text(entry.id, "agent id"), text(entry.spaceId, "space id")] as const;
  });
  return {
    spaces: body.spaces.map((item) => {
      const space = record(item, "space");
      return { id: text(space.id, "space id"), name: text(space.name, "space name") };
    }),
    agents: new Map(placed),
  };
}

async function act(token: string, action: JsonObject): Promise<{ status: number; body: unknown }> {
  return spaces(WORKSPACE_SPACES_ROUTES.action, token, action);
}

async function login(credentials: { username: string; password: string }): Promise<string> {
  const response = await call("POST", TEAM_API_ROUTES.auth.login, { body: credentials });
  assert.equal(response.status, 200, `Sign-in returned ${response.status}.`);
  return text(record(response.body, "login").sessionToken, "session token");
}

/** Opens a member's event socket that declares `fork-host-v1`, and waits for its first snapshot. */
async function openEvents(token: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${current().port}${TEAM_API_ROUTES.events}`, [
    TEAM_PROTOCOL_V1_WEBSOCKET,
    `openbot-token.${token}`,
  ]);
  sockets.push(socket);
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => reject(new Error("The event socket did not open.")), { once: true });
  });
  const snapshot = nextMessage(socket, (value) =>
    isRecord(value) && value.type === "runtime-snapshot" ? value : null,
  );
  socket.send(
    JSON.stringify({
      type: "agent-event-scope",
      includeConversations: false,
      capabilities: ["agent-runtime-snapshots", WORKSPACE_SPACES_CAPABILITY],
    }),
  );
  await snapshot;
  return socket;
}

/** Waits for the first socket message that `pick` accepts. */
function nextMessage<T>(socket: WebSocket, pick: (value: unknown) => T | null): Promise<T> {
  return new Promise((resolveMessage, reject) => {
    const onMessage = (event: MessageEvent) => {
      const picked = pick(JSON.parse(String(event.data)));
      if (picked === null) return;
      socket.removeEventListener("message", onMessage);
      resolveMessage(picked);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", (event) => reject(new Error(`The event socket closed: ${event.code}.`)), {
      once: true,
    });
  });
}

const spacesChanged = (socket: WebSocket) => nextMessage(socket, workspaceSpacesEvent);

/** The headers that the Motion MCP row of the live host sends, filled for one agent. */
function motionHeaders(agentId: string): Record<string, string> {
  const { agents } = current();
  const row: McpServerConfig = {
    id: "motion",
    name: "motion",
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "http://motion.invalid/mcp",
    headers: [
      { key: "X-Motion-Agent", value: "{{agent.id}}" },
      { key: "X-Motion-Workspace-Key", value: "{{space.id}}" },
      { key: "X-Motion-Workspace-Name", value: "{{space.name}}" },
    ],
  };
  const filled = agents.personalMcpServer(row, agents.mcpAgent(agentId));
  assert.ok(filled, "The Motion row was not filled.");
  return Object.fromEntries(filled.headers.map((pair) => [pair.key, pair.value]));
}

try {
  host = await startHost();
  const ownerToken = await login(OWNER);

  const setup = await step(
    "setup: an owner, a member and three agents, all in General",
    async () => {
      const { agents, team } = current();
      const create = async (name: string) =>
        (
          await runCauseEffect(
            agents.createAgentProfile({ name, description: name, avatarSeed: name.toLowerCase(), avatarHue: null }),
          )
        ).id;
      const trader = await create("Trader");
      const analyst = await create("Analyst");
      const secret = await create("Secret");
      const invite = await runCauseEffect(team.createInvite("member"));
      const joined = await call("POST", TEAM_API_ROUTES.join.server, {
        body: { inviteToken: invite.token, ...MEMBER },
      });
      assert.equal(joined.status, 201, `Join returned ${joined.status}.`);
      const memberToken = await login(MEMBER);
      const read = await readSpaces(memberToken);
      assert.deepEqual(
        read.spaces.map((space) => space.id),
        [GENERAL_SPACE_ID],
      );
      for (const id of [trader, analyst, secret])
        assert.equal(read.agents.get(id) ?? GENERAL_SPACE_ID, GENERAL_SPACE_ID);
      return { ids: { trader, analyst, secret }, memberToken };
    },
    ({ ids }) => ids,
  );
  const { trader, analyst, secret } = setup.ids;
  const memberSocket = await openEvents(setup.memberToken);

  const tradingId = await step("owner: create a space; the member's socket hears it", async () => {
    const changed = spacesChanged(memberSocket);
    const made = await act(ownerToken, { kind: "create", name: "Trading", icon: "📈", hue: 215 });
    assert.equal(made.status, 200, `Create returned ${made.status}: ${JSON.stringify(made.body)}`);
    const id = text(record(made.body, "create").createdSpaceId, "created space id");
    await changed;
    const read = await readSpaces(setup.memberToken);
    assert.deepEqual(
      read.spaces.map((space) => space.name),
      ["General", "Trading"],
    );
    return id;
  });

  await step("member: may read but not change the spaces", async () => {
    const create = await act(setup.memberToken, { kind: "create", name: "Mine" });
    const move = await act(setup.memberToken, { kind: "move", spaceId: tradingId, agentIds: [analyst] });
    assert.equal(create.status, 403, `A member's create returned ${create.status}.`);
    assert.equal(move.status, 403, `A member's move returned ${move.status}.`);
    assert.equal((await readSpaces(ownerToken)).spaces.length, 2, "A member made a space.");
    return { create: create.status, move: move.status };
  });

  await step("owner: move two agents to the space; both clients read the new places", async () => {
    const changed = spacesChanged(memberSocket);
    const moved = await act(ownerToken, { kind: "move", spaceId: tradingId, agentIds: [trader, secret] });
    assert.equal(moved.status, 200, `Move returned ${moved.status}: ${JSON.stringify(moved.body)}`);
    await changed;
    for (const token of [ownerToken, setup.memberToken]) {
      const read = await readSpaces(token);
      assert.equal(read.agents.get(trader), tradingId);
      assert.equal(read.agents.get(secret), tradingId);
      assert.equal(read.agents.get(analyst) ?? GENERAL_SPACE_ID, GENERAL_SPACE_ID);
    }
    return { trader: tradingId, secret: tradingId };
  });

  await step("member: an agent that the roles close is not in the member's spaces answer", async () => {
    const codec = AGENT_ACCESS_CODECS.get(AGENT_ACCESS_ROUTES.set);
    assert.ok(codec, "No agent-access-v1 codec for the roles.");
    const change = { revision: 0, everyone: { [secret]: "none" }, roles: [] };
    codec.request(change);
    const saved = await call("POST", AGENT_ACCESS_ROUTES.set, { token: ownerToken, body: change });
    assert.equal(saved.status, 200, `Saving the roles returned ${saved.status}.`);
    const member = await readSpaces(setup.memberToken);
    const owner = await readSpaces(ownerToken);
    assert.equal(member.agents.has(secret), false, "The member reads the space of a closed agent.");
    assert.equal(owner.agents.get(secret), tradingId, "The owner lost the closed agent.");
    return { member: [...member.agents.keys()].length, owner: [...owner.agents.keys()].length };
  });

  await step("owner: a refused action answers 409 with the reason in words", async () => {
    const notEmpty = await act(ownerToken, { kind: "delete", spaceId: tradingId });
    assert.equal(notEmpty.status, 409, `Deleting a full space returned ${notEmpty.status}.`);
    assert.ok(JSON.stringify(notEmpty.body).includes(sourceText("error.backend.spaceNotEmpty")));
    const general = await act(ownerToken, { kind: "delete", spaceId: GENERAL_SPACE_ID });
    assert.equal(general.status, 409, `Deleting General returned ${general.status}.`);
    assert.ok(JSON.stringify(general.body).includes(sourceText("error.backend.spaceGeneralKept")));
    const taken = await act(ownerToken, { kind: "create", name: "trading" });
    assert.equal(taken.status, 409, `A taken name returned ${taken.status}.`);
    const malformed = await call("POST", WORKSPACE_SPACES_ROUTES.action, {
      token: ownerToken,
      body: { kind: "create", name: "" },
    });
    assert.equal(malformed.status, 400, `An empty name returned ${malformed.status}.`);
    return { notEmpty: 409, general: 409, taken: 409, malformed: 400 };
  });

  await step("owner: rename the space; the agents keep their place", async () => {
    const changed = spacesChanged(memberSocket);
    const renamed = await act(ownerToken, { kind: "update", spaceId: tradingId, name: "Markets" });
    assert.equal(renamed.status, 200);
    await changed;
    const read = await readSpaces(setup.memberToken);
    assert.equal(read.spaces.find((space) => space.id === tradingId)?.name, "Markets");
    assert.equal(read.agents.get(trader), tradingId);
    return { name: "Markets" };
  });

  await step("mcp: {{space.id}} and {{space.name}} follow the agent's space", async () => {
    const inSpace = motionHeaders(trader);
    assert.deepEqual(inSpace, {
      "X-Motion-Agent": trader,
      "X-Motion-Workspace-Key": tradingId,
      "X-Motion-Workspace-Name": "Markets",
    });
    const inGeneral = motionHeaders(analyst);
    assert.equal(inGeneral["X-Motion-Workspace-Key"], GENERAL_SPACE_ID);
    assert.equal(inGeneral["X-Motion-Workspace-Name"], "General");
    return { trader: inSpace, analyst: inGeneral };
  });

  await step("owner: delete the space and move its agents to General", async () => {
    const changed = spacesChanged(memberSocket);
    const deleted = await act(ownerToken, { kind: "delete", spaceId: tradingId, moveTo: GENERAL_SPACE_ID });
    assert.equal(deleted.status, 200, `Delete returned ${deleted.status}: ${JSON.stringify(deleted.body)}`);
    await changed;
    const read = await readSpaces(ownerToken);
    assert.deepEqual(
      read.spaces.map((space) => space.id),
      [GENERAL_SPACE_ID],
    );
    for (const id of [trader, secret]) assert.equal(read.agents.get(id) ?? GENERAL_SPACE_ID, GENERAL_SPACE_ID);
    assert.equal(motionHeaders(trader)["X-Motion-Workspace-Key"], GENERAL_SPACE_ID);
    return { spaces: 1 };
  });

  report.passed = true;
} finally {
  for (const socket of sockets) socket.close();
  await stopHost();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
}
