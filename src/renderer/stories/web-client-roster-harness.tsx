/*
 * The web client on a mock host whose roster changes take the real wire, for
 * `scripts/web-roster-live-e2e.ts`. Each `agents-changed` of the mock host is encoded as the host
 * encodes it for a fork peer on protocol 8 (`agent-roster-changed`, see `agent-roster-v1.ts`), sent
 * through the relay's decoder as the WebRTC host peer does, and decoded as the client's peer does.
 * The roster holds more than 100 agents, many of them made by another agent, which the frozen
 * `bots-changed` event cannot carry. `window.__roster` lets the script change the host.
 */
import type { AgentEvent, ClientAgentSummary, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { AGENT_ROSTER_EVENT } from "@openbot/contracts/team-protocol/agent-roster-v1";
import { FORK_HOST_CAPABILITY } from "@openbot/contracts/team-protocol/fork-host-v1";
import { optionalTeamEvent, optionalTeamEventToCurrent } from "@openbot/contracts/team-protocol/optional-events";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { encodeTeamResponseBody } from "../../main/team-api/response-encoding";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { StaticI18nProvider } from "../src/i18n-context";
import { STORY_AGENT_SUMMARIES } from "../src/preview/fixtures";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { seeds } from "./workspace/workspace-app-seeds";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

const HELPERS = 120;
const template = STORY_AGENT_SUMMARIES[2];
if (!template) throw new Error("The story agents are missing.");
const helpers: ClientAgentSummary[] = Array.from({ length: HELPERS }, (_, index) => ({
  ...template,
  id: `helper-${index}`,
  name: `Helper ${index}`,
  title: "Temporary helper",
  threadId: `thread-helper-${index}`,
  workspacePath: `/mock/OpenBot/Agents/helper-${index}`,
  avatarSeed: `helper-${index}`,
  createdBy: { agentId: "chief", at: "2026-08-19T09:00:00.000Z" },
}));

/** The roster event as the host sends it, relayed and decoded as a remote client reads it. */
function overTheWire(event: AgentEvent | TeamRealtimeEvent): AgentEvent | TeamRealtimeEvent {
  if (event.type !== "agents-changed") return event;
  const body = encodeTeamResponseBody(
    {
      method: "GET",
      path: TEAM_API_ROUTES.agents.all,
      protocol: 8,
      capabilities: new Set([FORK_HOST_CAPABILITY]),
      hiddenAgentIds: new Set(),
    },
    200,
    event.agents,
  );
  const sent = JSON.parse(JSON.stringify({ type: AGENT_ROSTER_EVENT, agents: JSON.parse(body) }));
  const relayed = optionalTeamEvent(sent);
  if (!relayed) throw new Error("The relay dropped the roster event.");
  const received = optionalTeamEvent(JSON.parse(JSON.stringify(relayed)));
  if (!received) throw new Error("The client dropped the roster event.");
  const current = optionalTeamEventToCurrent(received);
  if (current.type !== "agents-changed") throw new Error("The roster event did not decode as agents-changed.");
  return current;
}

const mock = createMockOpenBot({
  agents: [...STORY_AGENT_SUMMARIES, ...helpers],
  channels: seeds(WEB_PREVIEW_MEMBER_ID),
  channelMemberId: WEB_PREVIEW_MEMBER_ID,
  spaces: [{ space: { id: "helpers", name: "Helpers", icon: null, hue: 150 }, agentIds: helpers.map((a) => a.id) }],
});
let dropRosterEvents = 0;
let rosterEvents = 0;

const controls = {
  /** How many roster events reached the client. */
  rosterEvents: () => rosterEvents,
  /** The host roster, as `GET /v1/agents` reads it. */
  agents: () => mock.api.agent.listAgents(),
  /** A teammate that another agent makes, as the `create_agent` tool does. */
  async createByAgent(name: string): Promise<string> {
    const created = await mock.api.agent.createAgent({
      name,
      description: "Made by Chief for one task.",
      initialMessage: "Start on the brief.",
      avatarSeed: `seed-${name.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`,
      avatarHue: 30,
    });
    return created.id;
  },
  /** A teammate whose roster event the client does not get, as after a lost event. */
  async createUnannounced(name: string): Promise<string> {
    dropRosterEvents += 2;
    return controls.createByAgent(name);
  },
  /** An event of an agent, as a turn of a new helper sends it. */
  turnStarted(agentId: string): void {
    mock.emitAgentEvent({ type: "turn-started", agentId, threadId: `thread-${agentId}`, turnId: `turn-${agentId}` });
  },
  /** A change made on the host: an operator route, the agent's own `update_profile`, a failover. */
  hostUpdate(agentId: string, update: { name?: string; model?: string; title?: string }) {
    return mock.api.agent.updateAgent({ agentId, ...update });
  },
  /** The asleep switch, as the host's efficiency route sends it. */
  async setAsleep(agentId: string, asleep: boolean): Promise<void> {
    const agents = await mock.api.agent.listAgents();
    mock.emitAgentEvent({
      type: "agents-changed",
      agents: agents.map((agent) => {
        if (agent.id !== agentId) return agent;
        const { sleepingSince: _sleeping, ...awake } = agent;
        return asleep ? { ...awake, sleepingSince: "2026-08-19T10:00:00.000Z" } : awake;
      }),
    });
  },
};
Object.assign(window, { __roster: controls });

const runtime: WebRuntimeFactory = (_accountId, events) =>
  mockWebRuntimeFor(mock, {
    ...events,
    event(hostId, event) {
      if (event.type === "agents-changed") {
        if (dropRosterEvents > 0) {
          dropRosterEvents -= 1;
          return;
        }
        rosterEvents += 1;
      }
      events.event(hostId, overTheWire(event));
    },
  });

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <div class="web-app">
          <Toaster />
          <WebWorkspace
            accountId="preview-account"
            accountEmail="you@example.com"
            accountName="Preview User"
            accountFetch={fetch}
            onSessionCheck={async () => {}}
            onLogout={async () => {}}
            createRuntime={runtime}
            language="system"
            onChangeLanguage={() => {}}
            appearance="dark"
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
