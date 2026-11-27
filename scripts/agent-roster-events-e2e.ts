// Checks on a real Team API host (`workspace-e2e-host.ts`) that every change of an agent reaches an
// open client as a roster event, also with more than 100 agents, and also when the code that made
// the change sends no event itself (an agent's own `update_profile`, an operator route, a recovery):
//
// - A current client (`fork-host-v1` on protocol 8) gets `agent-roster-changed` with every agent it
//   can see, more than 100 of them, as the agent list response encodes them. It decodes as
//   `agents-changed`, as the web, phone and desktop clients read it.
// - An agent that another agent made shows with its name, its face and its creator.
// - A rename and a model change saved straight in the agent store, with no `agents-changed` from
//   the caller, reach the client.
// - A change through the agent route (`PATCH /v1/agents/:id`) reaches the client, and its answer
//   holds the saved agent, which the web client shows at once.
// - The frozen `bots-changed` event cannot carry this roster: it is why no change reached a client.
//
// `bun scripts/agent-roster-events-e2e.ts`. Writes .openbot-build/agent-roster-events-e2e/report.json.
import assert from "node:assert/strict";
import type { AgentEvent } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_PROTOCOL_V1_WEBSOCKET } from "@openbot/contracts/team-protocol";
import { AGENT_ROSTER_EVENT } from "@openbot/contracts/team-protocol/agent-roster-v1";
import { TEAM_CURRENT_CAPABILITIES } from "@openbot/contracts/team-protocol/current";
import { optionalTeamEvent, optionalTeamEventToCurrent } from "@openbot/contracts/team-protocol/optional-events";
import { encodeTeamProtocolV8BaseCurrentEvent } from "@openbot/contracts/team-protocol/v8-base-adapter";
import { Effect } from "effect";
import type { AgentStore } from "../src/backend/agent-store";
import { isRecord, record, startWorkspaceE2e } from "./workspace-e2e-host";

const ROSTER = 104;
let store: AgentStore | null = null;
const e2e = await startWorkspaceE2e(
  "agent-roster-events-e2e",
  [
    "The WebRTC relay of the host and the client's peer: `web-roster-live-e2e.ts` runs the same event through their decoders.",
  ],
  {
    server: async (parts) => {
      store = parts.agentStore;
      return {};
    },
  },
);
const { owner, step, nextMessage } = e2e;
const agentStore = () => {
  assert.ok(store, "The host has no agent store.");
  return store;
};

type Roster = Extract<AgentEvent, { type: "agents-changed" }>["agents"];

/** An event socket of a current client: the scope that the host's WebRTC peer sends for it. */
async function openCurrentEvents(token: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${e2e.host().port}${TEAM_API_ROUTES.events}`, [
    TEAM_PROTOCOL_V1_WEBSOCKET,
    `openbot-token.${token}`,
  ]);
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => reject(new Error("The event socket did not open.")), { once: true });
  });
  const snapshot = nextMessage(socket, (value) =>
    isRecord(value) && value.type === "runtime-snapshot" ? value : null,
  );
  socket.send(
    JSON.stringify({ type: "agent-event-scope", includeConversations: true, capabilities: TEAM_CURRENT_CAPABILITIES }),
  );
  await snapshot;
  return socket;
}

/** The next roster event that `accept` takes, decoded as a client decodes it. */
function nextRoster(socket: WebSocket, accept: (agents: Roster) => boolean): Promise<Roster> {
  return nextMessage(socket, (value) => {
    if (!isRecord(value) || value.type !== AGENT_ROSTER_EVENT) return null;
    const relayed = optionalTeamEvent(JSON.parse(JSON.stringify(optionalTeamEvent(value))));
    assert.ok(relayed, "The relay dropped the roster event.");
    const current = optionalTeamEventToCurrent(relayed);
    assert.equal(current.type, "agents-changed");
    if (current.type !== "agents-changed") return null;
    return accept(current.agents) ? current.agents : null;
  });
}

try {
  const events = await openCurrentEvents(owner.token);

  const creatorId = await step("more than 100 agents are on the host", async () => {
    for (let index = 0; index < ROSTER; index += 1)
      await Effect.runPromise(
        agentStore().createAgent({
          name: `Agent ${index}`,
          description: "",
          avatarSeed: `agent-${index}`,
          avatarHue: null,
        }),
      );
    const agents = agentStore().list();
    assert.ok(agents.length > 100);
    const creator = agents.at(-1);
    assert.ok(creator);
    return creator.id;
  });

  const helperId = await step("a teammate that another agent makes reaches the client with its name", async () => {
    // The store saves the agent, then its creator; the host sends the roster once both are saved.
    let madeId = "";
    const roster = nextRoster(events, (agents) =>
      agents.some((agent) => agent.id === madeId && agent.createdBy?.agentId === creatorId),
    );
    const helper = await Effect.runPromise(
      agentStore().createAgent({
        name: "Fichador Higgsfield",
        description: "A helper for one task.",
        avatarSeed: "fichador-higgsfield",
        avatarHue: 30,
      }),
    );
    madeId = helper.id;
    agentStore().recordCreator(helper.id, creatorId);
    const shown = await roster;
    assert.ok(shown.length > 100, `The event has ${shown.length} agents.`);
    const received = shown.find((agent) => agent.id === helper.id);
    assert.equal(received?.avatarSeed, "fichador-higgsfield");
    assert.equal(received?.createdBy?.agentId, creatorId);
    // The frozen event that this host sent before: it cannot describe this roster.
    let frozen: string | null = null;
    try {
      frozen = encodeTeamProtocolV8BaseCurrentEvent({ type: "agents-changed", agents: shown }, {});
    } catch {
      frozen = null;
    }
    assert.equal(frozen, null, "The frozen event carries the roster: this check no longer shows the cause.");
    return madeId;
  });

  await step("a rename and a model change saved with no event of their own reach the client", async () => {
    const renamed = nextRoster(events, (agents) =>
      agents.some((agent) => agent.id === helperId && agent.name === "Fichador Uno" && agent.title === "Helper"),
    );
    await Effect.runPromise(agentStore().updateAgent({ agentId: helperId, name: "Fichador Uno", title: "Helper" }));
    await renamed;
    const before = agentStore()
      .list()
      .find((agent) => agent.id === helperId);
    assert.ok(before);
    const effort = before.reasoningEffort === "high" ? "low" : "high";
    const changed = nextRoster(events, (agents) =>
      agents.some((agent) => agent.id === helperId && agent.reasoningEffort === effort),
    );
    await Effect.runPromise(agentStore().updateAgent({ agentId: helperId, reasoningEffort: effort }));
    await changed;
    return { effort };
  });

  await step("a change through the agent route reaches the client, and its answer holds the agent", async () => {
    const changed = nextRoster(events, (agents) =>
      agents.some((agent) => agent.id === helperId && agent.name === "Fichador Dos"),
    );
    const response = await e2e.call("PATCH", TEAM_API_ROUTES.agent.one(helperId), {
      token: owner.token,
      body: { name: "Fichador Dos" },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(record(response.body, "agent").name, "Fichador Dos");
    await changed;
  });

  e2e.report.passed = true;
} finally {
  await e2e.finish();
}
