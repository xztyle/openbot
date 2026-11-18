// Shared host of the workspace Team API E2E scripts (`workspace-read-state-e2e.ts`,
// `workspace-search-e2e.ts`, `workspace-saved-e2e.ts`): a real `TeamApiServer` on loopback with the
// real team, agent, mailbox, channel and sidebar stores on a temporary profile, an owner and a member,
// requests through the frozen wire codecs, and event sockets. The agent service is not initialized,
// so no provider CLI starts: a channel without agents takes messages and starts no work.
// Run each script with Bun: the main process imports Electron, which this file replaces.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_V1_WEBSOCKET,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol";
import { CHANNEL_ROUTES, channelRequest, channelResponse } from "@openbot/contracts/team-protocol/channels-v1";
import { TEAM_CURRENT_CAPABILITIES } from "@openbot/contracts/team-protocol/current";
import { FORK_HOST_CAPABILITY } from "@openbot/contracts/team-protocol/fork-host-v1";
import type { OptionalRouteCodec } from "@openbot/contracts/team-protocol/optional-routes";
import { TEAM_PROTOCOL_V7 } from "@openbot/contracts/team-protocol/v7";
import {
  WORKSPACE_CODECS,
  WORKSPACE_ROUTES,
  withWorkspaceChannels,
} from "@openbot/contracts/team-protocol/workspace-v1";
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

const HOST_VERSION = "0.0.0-e2e";
const STEP_DEADLINE_MS = 30_000;
export const OWNER = { username: "owner-user", password: "owner-password-123" };
export const MEMBER = { username: "member-user", password: "member-password-123" };

plugin({
  name: "workspace-e2e-electron-boundary",
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

/** A value that `JSON.parse` gives. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown, label: string): JsonObject {
  assert.ok(isRecord(value), `${label} is not an object.`);
  return value;
}

export interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

export interface Report {
  passed: boolean;
  unverified: string[];
  steps: Step[];
  [key: string]: unknown;
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

export interface WorkspaceHost {
  database: OpenBotDatabase;
  agents: AgentService;
  server: InstanceType<typeof TeamApiServer>;
  team: InstanceType<typeof TeamStore>;
  port: number;
}

/** A person of the host: the session token and the team member id. */
export interface Person {
  token: string;
  id: string;
}

export interface WorkspaceE2e {
  host(): WorkspaceHost;
  /** Stops the host and starts it again on the same profile, as an app restart does. */
  restart(): Promise<void>;
  report: Report;
  step<T>(name: string, run: () => Promise<T>, summarize?: (value: T) => unknown): Promise<T>;
  /** One request as a current client sends it; `capabilities` replaces the advertised list. */
  call(
    method: string,
    path: string,
    input?: { token?: string; body?: unknown; capabilities?: readonly string[] },
  ): Promise<{ status: number; body: unknown }>;
  /** An optional route request through its frozen codec, in both directions. */
  optional(
    codecs: ReadonlyMap<string, OptionalRouteCodec>,
    path: string,
    token: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }>;
  /** A workspace command (`workspace-v1`), answered with the channel. */
  command(token: string, body: JsonObject): Promise<JsonObject>;
  /** A released channel command (`channels-v1`), such as `read`. */
  releasedCommand(token: string, body: JsonObject): Promise<JsonObject>;
  /** The page of a channel, or of one thread, as the member reads it. */
  page(token: string, channelId: string, threadRootId?: string): Promise<JsonObject>;
  /** The channel list of a member, as the sidebar reads it. */
  channels(token: string): Promise<JsonObject[]>;
  owner: Person;
  member: Person;
  /** An event socket of a person that declares `fork-host-v1`. */
  openEvents(token: string): Promise<WebSocket>;
  nextMessage<T>(socket: WebSocket, pick: (value: unknown) => T | null): Promise<T>;
  /** Fails when `pick` accepts a message within `ms`. */
  noMessage(socket: WebSocket, pick: (value: unknown) => boolean, ms?: number): Promise<void>;
  finish(): Promise<void>;
}

/** Starts the host on a new profile with an owner and a member, and gives the shared helpers. */
export async function startWorkspaceE2e(name: string, unverified: string[]): Promise<WorkspaceE2e> {
  const out = resolve(import.meta.dirname, `../.openbot-build/${name}`);
  const root = await mkdtemp(join(tmpdir(), `openbot-${name}-`));
  const userData = join(root, "user-data");
  const home = join(root, "home");
  const report: Report = { passed: false, unverified, steps: [] };
  let current: WorkspaceHost | null = null;
  const sockets: WebSocket[] = [];

  async function startHost(): Promise<WorkspaceHost> {
    const database = new OpenBotDatabase(userData);
    const agentStore = new AgentStore(userData, home, database);
    const mailbox = new MailboxStore(userData, agentStore.sharedRoot, agentStore.database);
    const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
    const team = new TeamStore(join(userData, "openbot-team-server-v2.json"));
    const access = new AgentAccessStore(join(userData, AGENT_ACCESS_FILE));
    await runCauseEffect(sidebar.initialize());
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
      channels: agents.channels,
      spaces: {
        service: agents.spaces,
        channel: (channelId) => (agents.channels.store.exists(channelId) ? agents.channels.store.get(channelId) : null),
      },
    });
    const port = await Effect.runPromise(server.start());
    return { database, agents, server, team, port };
  }

  async function stopHost(): Promise<void> {
    if (!current) return;
    const stopping = current;
    current = null;
    await Effect.runPromise(stopping.server.stop()).catch(() => undefined);
    await runCauseEffect(stopping.agents.stop()).catch(() => undefined);
    stopping.database.close();
  }

  const host = () => {
    assert.ok(current, "The host is not running.");
    return current;
  };

  async function call(
    method: string,
    path: string,
    input: { token?: string; body?: unknown; capabilities?: readonly string[] } = {},
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      [TEAM_PROTOCOL_VERSION_HEADER]: String(TEAM_PROTOCOL_V7),
      [TEAM_APP_VERSION_HEADER]: HOST_VERSION,
      [TEAM_CAPABILITIES_HEADER]: (input.capabilities ?? TEAM_CURRENT_CAPABILITIES).join(","),
    };
    if (input.body !== undefined) headers["Content-Type"] = "application/json";
    if (input.token) headers.Authorization = `Bearer ${input.token}`;
    const response = await fetch(`http://127.0.0.1:${host().port}${path}`, {
      method,
      headers,
      body: input.body === undefined ? null : JSON.stringify(input.body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function optional(
    codecs: ReadonlyMap<string, OptionalRouteCodec>,
    path: string,
    token: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const codec = codecs.get(path);
    assert.ok(codec, `No codec for ${path}.`);
    const sent = codec.request(body);
    const response = await call("POST", path, { token, body: sent });
    return { status: response.status, body: codec.response(response.status, response.body) };
  }

  async function command(token: string, body: JsonObject): Promise<JsonObject> {
    const codec = WORKSPACE_CODECS.get(WORKSPACE_ROUTES.command);
    assert.ok(codec);
    const response = await call("POST", WORKSPACE_ROUTES.command, { token, body: codec.request(body) });
    assert.equal(
      response.status,
      200,
      `${String(body.type)} returned ${response.status}: ${JSON.stringify(response.body)}`,
    );
    return record(codec.response(response.status, response.body), "channel");
  }

  async function releasedCommand(token: string, body: JsonObject): Promise<JsonObject> {
    const response = await call("POST", CHANNEL_ROUTES.command, {
      token,
      body: channelRequest(CHANNEL_ROUTES.command, body),
    });
    assert.equal(
      response.status,
      200,
      `${String(body.type)} returned ${response.status}: ${JSON.stringify(response.body)}`,
    );
    return record(channelResponse(CHANNEL_ROUTES.command, response.status, response.body), "channel");
  }

  async function page(token: string, channelId: string, threadRootId?: string): Promise<JsonObject> {
    if (threadRootId) {
      const codec = WORKSPACE_CODECS.get(WORKSPACE_ROUTES.thread);
      assert.ok(codec);
      const response = await call("POST", WORKSPACE_ROUTES.thread, {
        token,
        body: codec.request({ channelId, threadRootId }),
      });
      assert.equal(response.status, 200, `The thread page returned ${response.status}.`);
      return record(codec.response(response.status, response.body), "thread page");
    }
    const response = await call("POST", CHANNEL_ROUTES.read, {
      token,
      body: channelRequest(CHANNEL_ROUTES.read, { channelId }),
    });
    assert.equal(response.status, 200, `The channel page returned ${response.status}.`);
    const projected = channelResponse(CHANNEL_ROUTES.read, response.status, response.body);
    return record(withWorkspaceChannels(CHANNEL_ROUTES.read, projected, response.body), "channel page");
  }

  async function channels(token: string): Promise<JsonObject[]> {
    const response = await call("GET", CHANNEL_ROUTES.list, { token });
    assert.equal(response.status, 200, `The channel list returned ${response.status}.`);
    const list = channelResponse(CHANNEL_ROUTES.list, response.status, response.body);
    assert.ok(Array.isArray(list));
    return list.map((entry) => record(entry, "channel summary"));
  }

  async function login(credentials: { username: string; password: string }): Promise<string> {
    const response = await call("POST", TEAM_API_ROUTES.auth.login, { body: credentials });
    assert.equal(response.status, 200, `Sign-in returned ${response.status}.`);
    const token = record(response.body, "login").sessionToken;
    assert.equal(typeof token, "string");
    return String(token);
  }

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

  async function noMessage(socket: WebSocket, pick: (value: unknown) => boolean, ms = 750): Promise<void> {
    let seen: unknown = null;
    const onMessage = (event: MessageEvent) => {
      const value = JSON.parse(String(event.data));
      if (pick(value)) seen = value;
    };
    socket.addEventListener("message", onMessage);
    // A check that something did not happen: it waits the whole time and looks at every message.
    await new Promise((done) => setTimeout(done, ms));
    socket.removeEventListener("message", onMessage);
    assert.equal(seen, null, `An event came that must not: ${JSON.stringify(seen)}`);
  }

  async function openEvents(token: string): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${host().port}${TEAM_API_ROUTES.events}`, [
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
        capabilities: ["agent-runtime-snapshots", "channel-chats-v1", FORK_HOST_CAPABILITY],
      }),
    );
    await snapshot;
    return socket;
  }

  async function step<T>(
    stepName: string,
    run: () => Promise<T>,
    summarize: (value: T) => unknown = (value) => value,
  ): Promise<T> {
    process.stdout.write(`- ${stepName}\n`);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // A bound on failure only: each check waits for its reply or event, and a missing event must fail.
      const value = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error(`No result within ${STEP_DEADLINE_MS} ms.`)), STEP_DEADLINE_MS);
        }),
      ]);
      report.steps.push({ name: stepName, passed: true, detail: summarize(value) });
      return value;
    } catch (error) {
      report.steps.push({
        name: stepName,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  current = await startHost();
  const ownerToken = await login(OWNER);
  const invite = await runCauseEffect(host().team.createInvite("member"));
  const joined = await call("POST", TEAM_API_ROUTES.join.server, { body: { inviteToken: invite.token, ...MEMBER } });
  assert.equal(joined.status, 201, `Join returned ${joined.status}.`);
  const memberToken = await login(MEMBER);
  const idOf = (username: string) => {
    const found = host()
      .team.listMembers()
      .find((entry) => entry.username === username);
    assert.ok(found, `No member ${username}.`);
    return found.id;
  };
  const owner: Person = { token: ownerToken, id: idOf(OWNER.username) };
  const member: Person = { token: memberToken, id: idOf(MEMBER.username) };

  return {
    host,
    async restart() {
      for (const socket of sockets.splice(0)) socket.close();
      await stopHost();
      current = await startHost();
      owner.token = await login(OWNER);
      member.token = await login(MEMBER);
    },
    report,
    step,
    call,
    optional,
    command,
    releasedCommand,
    page,
    channels,
    owner,
    member,
    openEvents,
    nextMessage,
    noMessage,
    async finish() {
      for (const socket of sockets) socket.close();
      await stopHost();
      await rm(root, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`Report: ${join(out, "report.json")}\n`);
    },
  };
}
