// Checks the agent efficiency features (`agent-efficiency-v1`, under `fork-host-v1`) on a real Team
// API host (`workspace-e2e-host.ts`), as the web client reaches them:
//
// - The model policy and the role ride an agent update and come back on the agent list beside the
//   frozen projection; `fixed` and `null` clear them.
// - Sleep: one agent, a team (the lead and everyone under it in the org chart) and a space go to
//   sleep and wake; `sleepingSince` shows on the agent list; a member gets 403.
// - Model savings and reviews answer for the owner; an agent with no work gets no review (no model call).
// - Playbooks: a skill that two agents share is a candidate; "make a playbook" from it installs it in
//   every agent of the role, adopts the identical copies, and leaves a different copy alone; a role
//   change takes it away from an agent; remove leaves each agent the skill as its own.
//
// `bun scripts/agent-efficiency-e2e.ts`. Writes .openbot-build/agent-efficiency-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_EFFICIENCY_CODECS, AGENT_EFFICIENCY_ROUTES } from "@openbot/contracts/team-protocol/agent-efficiency-v1";
import type { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { type JsonObject, type Person, record, startWorkspaceE2e } from "./workspace-e2e-host";

let store: AgentStore | null = null;
const e2e = await startWorkspaceE2e(
  "agent-efficiency-e2e",
  [
    "Turns on a provider: the host starts no provider here, so the model policy's choice is checked by its classifier only.",
  ],
  {
    server: async (parts) => {
      store = parts.agentStore;
      return {};
    },
  },
);
const { owner, member, step } = e2e;

function agents(): AgentStore {
  if (!store) throw new Error("The agent store is not ready.");
  return store;
}

async function route(path: string, person: Person, body: JsonObject): Promise<{ status: number; body: unknown }> {
  return e2e.optional(AGENT_EFFICIENCY_CODECS, path, person.token, body);
}

async function ok(path: string, body: JsonObject, person: Person = owner): Promise<JsonObject> {
  const response = await route(path, person, body);
  assert.equal(response.status, 200, `${path} returned ${response.status}: ${JSON.stringify(response.body)}`);
  return record(response.body, path);
}

async function listed(): Promise<JsonObject[]> {
  const response = await e2e.call("GET", "/v1/agents", { token: owner.token });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body));
  return response.body.map((entry) => record(entry, "agent"));
}

function ids(value: unknown): string[] {
  assert.ok(Array.isArray(value) && value.every((item) => typeof item === "string"), "a list of ids");
  return value;
}

function records(value: unknown): JsonObject[] {
  assert.ok(Array.isArray(value), "a list");
  return value.map((item) => record(item, "item"));
}

const SKILL = "---\nname: copy-anuncios-meta\ndescription: Copy de anuncios de Meta.\n---\n# Copy\n";

async function addAgent(name: string, skill?: string): Promise<{ id: string; workspace: string }> {
  const id = `agent-${randomUUID()}`;
  const agent = await runCauseEffect(agents().getOrCreate(id, name));
  if (skill)
    for (const folder of [".agents/skills", ".claude/skills"]) {
      await mkdir(join(agent.workspacePath, folder, "copy-anuncios-meta"), { recursive: true });
      await writeFile(join(agent.workspacePath, folder, "copy-anuncios-meta", "SKILL.md"), skill);
    }
  return { id, workspace: agent.workspacePath };
}

try {
  const lead = await addAgent("PUO Abogados – Líder de Producto");
  const creative = await addAgent("PUO Abogados – Creativo de Anuncios", SKILL);
  const creative2 = await addAgent("PUO Inglés – Creativo de Anuncios", SKILL);
  const cso = await addAgent("CSO - Director de Ventas", `${SKILL}\nOwn notes.\n`);
  for (const report of [creative, creative2])
    await runCauseEffect(agents().updateAgent({ agentId: report.id, reportsToAgentId: lead.id }));

  await step("model policy and role ride the agent update", async () => {
    const patch = await e2e.call("PATCH", `/v1/agents/${lead.id}`, {
      token: owner.token,
      body: { modelPolicy: "auto", playbookRole: "Líder" },
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    const shown = (await listed()).find((agent) => agent.id === lead.id);
    assert.equal(shown?.modelPolicy, "auto");
    assert.equal(shown?.playbookRole, "Líder");
    const cleared = await e2e.call("PATCH", `/v1/agents/${lead.id}`, {
      token: owner.token,
      body: { modelPolicy: "fixed", playbookRole: null },
    });
    assert.equal(cleared.status, 200);
    const after = (await listed()).find((agent) => agent.id === lead.id);
    assert.equal(after?.modelPolicy, undefined);
    assert.equal(after?.playbookRole, undefined);
    await e2e.call("PATCH", `/v1/agents/${lead.id}`, { token: owner.token, body: { modelPolicy: "auto" } });
    return { lead: after?.name };
  });

  await step("sleep an agent, a team and a space, then wake them", async () => {
    const one = await ok(AGENT_EFFICIENCY_ROUTES.sleep, { target: { kind: "agent", id: cso.id }, sleeping: true });
    assert.deepEqual(one.changedAgentIds, [cso.id]);
    assert.ok(typeof (await listed()).find((agent) => agent.id === cso.id)?.sleepingSince === "string");
    const team = await ok(AGENT_EFFICIENCY_ROUTES.sleep, { target: { kind: "team", id: lead.id }, sleeping: true });
    assert.deepEqual(new Set(ids(team.changedAgentIds)), new Set([lead.id, creative.id, creative2.id]));
    const refused = await route(AGENT_EFFICIENCY_ROUTES.sleep, member, {
      target: { kind: "agent", id: lead.id },
      sleeping: false,
    });
    assert.equal(refused.status, 403);
    const space = await ok(AGENT_EFFICIENCY_ROUTES.sleep, {
      target: { kind: "space", id: "general" },
      sleeping: false,
    });
    assert.equal(ids(space.sleepingAgentIds).length, 0);
    assert.ok((await listed()).every((agent) => agent.sleepingSince === undefined));
    return { team: team.changedAgentIds, woke: space.changedAgentIds };
  });

  await step("model savings and reviews answer; no work means no review", async () => {
    const savings = await ok(AGENT_EFFICIENCY_ROUTES.modelSavings, {});
    assert.equal(savings.days, 7);
    assert.equal(savings.warmSwitches, 0);
    const reviews = await ok(AGENT_EFFICIENCY_ROUTES.reviews, {});
    assert.deepEqual(reviews.reviews, []);
    const run = await ok(AGENT_EFFICIENCY_ROUTES.runReview, { agentId: creative.id });
    assert.equal(run.review, null);
    const off = await ok(AGENT_EFFICIENCY_ROUTES.reviews, { enabled: false });
    assert.equal(off.enabled, false);
    return { savings, enabled: off.enabled };
  });

  await step("a shared skill becomes a role playbook", async () => {
    const before = await ok(AGENT_EFFICIENCY_ROUTES.playbooks, {});
    const candidate = records(before.candidates).find((entry) => entry.slug === "copy-anuncios-meta");
    assert.ok(candidate, JSON.stringify(before.candidates));
    assert.equal(candidate.suggestedRole, "Creativo de Anuncios");
    const made = await ok(AGENT_EFFICIENCY_ROUTES.importPlaybook, {
      agentId: creative.id,
      slug: "copy-anuncios-meta",
      roles: ["Creativo de Anuncios"],
    });
    const playbook = record(records(made.playbooks)[0], "playbook");
    assert.deepEqual(new Set(ids(playbook.agentIds)), new Set([creative.id, creative2.id]));
    for (const agent of [creative, creative2])
      for (const folder of [".agents/skills", ".claude/skills"])
        assert.ok(
          (await readdir(join(agent.workspace, folder, "copy-anuncios-meta"))).includes(".openbot-playbook.json"),
        );
    const own = await readdir(join(cso.workspace, ".claude/skills/copy-anuncios-meta"));
    assert.ok(!own.includes(".openbot-playbook.json"), "a different copy stays unmanaged");
    // The lead takes the role: it gets the playbook, and loses it again with another role.
    await e2e.call("PATCH", `/v1/agents/${lead.id}`, {
      token: owner.token,
      body: { playbookRole: "Creativo de Anuncios" },
    });
    const withLead = await ok(AGENT_EFFICIENCY_ROUTES.playbooks, {});
    assert.ok(ids(records(withLead.playbooks)[0]?.agentIds).includes(lead.id));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(await readFile(join(lead.workspace, ".claude/skills/copy-anuncios-meta/SKILL.md"), "utf8"), SKILL);
    await e2e.call("PATCH", `/v1/agents/${lead.id}`, { token: owner.token, body: { playbookRole: "Líder" } });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.deepEqual(await readdir(join(lead.workspace, ".claude/skills")).catch(() => []), []);
    const removed = await ok(AGENT_EFFICIENCY_ROUTES.removePlaybook, { id: String(playbook.id) });
    assert.deepEqual(removed.playbooks, []);
    // The agents keep the skill as their own: only the mark goes.
    assert.deepEqual(await readdir(join(creative.workspace, ".claude/skills/copy-anuncios-meta")), ["SKILL.md"]);
    return { playbook: playbook.slug, agents: playbook.agentIds };
  });

  await step("a member cannot read the playbooks", async () => {
    const response = await route(AGENT_EFFICIENCY_ROUTES.playbooks, member, {});
    assert.equal(response.status, 403);
    return { status: response.status };
  });
} finally {
  await e2e.finish();
}
