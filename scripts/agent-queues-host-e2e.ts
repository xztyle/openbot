// Checks the all-queues read (`agent-queues-v1`, under `fork-host-v1`) on a real Team API host
// (`workspace-e2e-host.ts`):
// - `GET /v1/agents/queues` answers the queue of every agent, each the same as the agent's own
//   `GET /v1/agents/<agentId>/queue`, and the frozen codec accepts it in both directions;
// - a client without `fork-host-v1` gets 404, so it reads each queue as before;
// - the agent ids in the path do not reach the per-agent routes (`queues` is not read as an agent id).
//
// `bun scripts/agent-queues-host-e2e.ts`. Writes .openbot-build/agent-queues-host-e2e/report.json.
import assert from "node:assert/strict";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { AGENT_QUEUES_CODECS, AGENT_QUEUES_ROUTE } from "@openbot/contracts/team-protocol/agent-queues-v1";
import { TEAM_CURRENT_CAPABILITIES } from "@openbot/contracts/team-protocol/current";
import { FORK_HOST_CAPABILITY } from "@openbot/contracts/team-protocol/fork-host-v1";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { record, startWorkspaceE2e } from "./workspace-e2e-host";

const e2e = await startWorkspaceE2e("agent-queues-host-e2e", [
  "The WebRTC transport of the web client. It carries the same request to the same route handler and the same codec.",
  "Roles that close an agent to a member: the route filters with the same agent levels as the insight route.",
]);
const { owner, step } = e2e;

try {
  const names = ["Queue One", "Queue Two", "Queue Three"];
  const created = [];
  for (const name of names)
    created.push(
      await runCauseEffect(
        e2e.host().agents.createAgentProfile({
          name,
          description: "An agent with a queue",
          avatarSeed: name.toLowerCase().replaceAll(" ", "-"),
          avatarHue: null,
          provider: "codex",
        }),
      ),
    );
  const ids = e2e
    .host()
    .agents.listAgents()
    .map((agent) => agent.id);

  await step("one read answers the queue of every agent, as each agent's own route does", async () => {
    const codec = AGENT_QUEUES_CODECS.get(AGENT_QUEUES_ROUTE);
    assert.ok(codec);
    const response = await e2e.call("GET", AGENT_QUEUES_ROUTE, { token: owner.token });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const body = record(codec.response(response.status, response.body), "queues");
    assert.ok(Array.isArray(body.queues));
    const queues = body.queues.map((queue) => record(queue, "queue"));
    assert.deepEqual(queues.map((queue) => queue.agentId).sort(), [...ids].sort());
    for (const queue of queues) {
      const agentId = String(queue.agentId);
      const own = await e2e.call("GET", TEAM_API_ROUTES.agent.queue(agentId), { token: owner.token });
      assert.equal(own.status, 200);
      const single = record(own.body, "single queue");
      assert.ok(Array.isArray(queue.deliveries) && Array.isArray(single.deliveries));
      assert.equal(queue.deliveries.length, single.deliveries.length);
    }
    return { agents: queues.length, created: created.length };
  });

  await step("a client without fork-host-v1 gets 404 and reads each queue as before", async () => {
    const capabilities = TEAM_CURRENT_CAPABILITIES.filter((capability) => capability !== FORK_HOST_CAPABILITY);
    const response = await e2e.call("GET", AGENT_QUEUES_ROUTE, { token: owner.token, capabilities });
    assert.equal(response.status, 404);
    return { status: response.status };
  });

  e2e.report.passed = true;
} finally {
  await e2e.finish();
}
