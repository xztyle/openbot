#!/usr/bin/env bun
// The keys and passwords store on a real folder, as the host runs it: who may read each key (the
// files the agent jail opens), versions and rollback, the bin, expiry, the history of each key, the
// encrypted bundle, and that no value reaches the history, the ledger, a log line or the bundle.
//
// `bun scripts/secret-vault-e2e.ts`. Writes .openbot-build/secret-vault-e2e/report.json.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText } from "@openbot/logging";
import { Effect } from "effect";
import { AgentApiKeys } from "../src/backend/agent-api-keys";
import { WorkspaceSecretsService } from "../src/backend/workspace-secrets";

const OUT = join(process.cwd(), ".openbot-build", "secret-vault-e2e");
const steps: { step: string; result: unknown }[] = [];
async function step(name: string, run: () => unknown): Promise<void> {
  try {
    steps.push({ step: name, result: (await run()) ?? "ok" });
  } catch (error) {
    steps.push({ step: name, result: { failed: error instanceof Error ? error.message : String(error) } });
    write();
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function write() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "report.json"),
    `${JSON.stringify({ passed: steps.every((s) => !(typeof s.result === "object" && s.result !== null && "failed" in s.result)), steps }, null, 2)}\n`,
  );
}

const root = join(tmpdir(), `secret-vault-e2e-${process.pid}`);
const keysRoot = join(root, "agent-api-keys");
rmSync(root, { recursive: true, force: true });
let now = Date.parse("2026-11-27T10:00:00Z");
const DAY = 86_400_000;
const agents = [
  { id: "agent-ana", name: "Ana", spaceId: "space-uni" },
  { id: "agent-beto", name: "Beto", spaceId: "space-uni" },
  { id: "agent-carla", name: "Carla", spaceId: "space-shop" },
];
const OWNER = { kind: "owner" as const, id: "member-1", name: "Owner" };
const META = "EAAG-meta-value-7f3a9c1d2e";
const META_2 = "EAAG-meta-second-value-88d1b2";
const OLD_SHARED = "legacy-shared-value-4b1c9e";
const SPACE_VALUE = "space-only-value-19ac72";
const ALL_VALUES = [META, META_2, OLD_SHARED, SPACE_VALUE];

// A store from before the ledger: plain key files, one shared and one an agent's.
mkdirSync(join(keysRoot, "_shared"), { recursive: true });
mkdirSync(join(keysRoot, "agent-ana"), { recursive: true });
writeFileSync(join(keysRoot, "_shared", "OLD_SHARED_KEY"), OLD_SHARED, { mode: 0o600 });
writeFileSync(join(keysRoot, "agent-ana", "ANA_KEY"), "ana-own-value-55e1d0", { mode: 0o600 });

const keys = new AgentApiKeys(keysRoot, { now: () => now });
keys.ledger.setDirectory(() => agents);
const service = new WorkspaceSecretsService(
  keys,
  (id) => agents.some((agent) => agent.id === id),
  (id) => ["space-uni", "space-shop"].includes(id),
);
const vault = (call: Parameters<WorkspaceSecretsService["vault"]>[0]) => service.vault(call, OWNER);
const overview = async () => {
  const result = await vault({ kind: "overview" });
  assert.equal(result.kind, "overview");
  return result.kind === "overview" ? result : null;
};
const detail = async (scope: string, name: string) => {
  const result = await vault({ kind: "detail", scope, name });
  assert.equal(result.kind, "detail");
  if (result.kind !== "detail") throw new Error("no detail");
  return result.detail;
};
const agentFiles = (agentId: string) =>
  [
    ...readdirSafe(join(keysRoot, agentId)).map((name) => `${agentId}/${name}`),
    ...readdirSafe(join(keysRoot, "_shared")).map((name) => `_shared/${name}`),
    ...readdirSafe(join(keysRoot, "_grants", agentId)).map((name) => `_grants/${agentId}/${name}`),
  ].sort();
function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

await step("a store from before the ledger keeps every key, with its value, in place", async () => {
  await Effect.runPromise(keys.registerSaved());
  const list = (await overview())?.secrets ?? [];
  assert.deepEqual(
    list.map((secret) => `${secret.scope}/${secret.name}`),
    ["shared/OLD_SHARED_KEY", "agent-ana/ANA_KEY"],
  );
  assert.equal(readFileSync(join(keysRoot, "_shared", "OLD_SHARED_KEY"), "utf8"), OLD_SHARED);
  assert.equal(keys.readNow("any", "agent-carla", "OLD_SHARED_KEY"), OLD_SHARED);
  assert.ok(!redactText(`value ${OLD_SHARED}`).includes(OLD_SHARED), "a migrated value is not masked");
  return list.map((secret) => ({ name: secret.name, version: secret.version, everyone: secret.access.everyone }));
});

await step("a new shared key reaches every agent; restricting it takes the file away from the others", async () => {
  await vault({
    kind: "save",
    scope: "shared",
    name: "META_ACCESS_TOKEN",
    value: META,
    folder: "universidad-online/meta",
    tags: ["ads"],
  });
  for (const agent of agents) assert.ok(agentFiles(agent.id).includes("_shared/META_ACCESS_TOKEN"));
  await vault({
    kind: "update",
    scope: "shared",
    name: "META_ACCESS_TOKEN",
    access: { everyone: false, agents: ["agent-carla"], spaces: [] },
  });
  assert.ok(!existsSync(join(keysRoot, "_shared", "META_ACCESS_TOKEN")), "the shared file stays");
  assert.deepEqual(
    agentFiles("agent-carla").filter((file) => file.endsWith("META_ACCESS_TOKEN")),
    ["_grants/agent-carla/META_ACCESS_TOKEN"],
  );
  assert.equal(agentFiles("agent-ana").filter((file) => file.endsWith("META_ACCESS_TOKEN")).length, 0);
  assert.equal(keys.readNow("any", "agent-carla", "META_ACCESS_TOKEN"), META);
  assert.equal(keys.readNow("shared", "agent-ana", "META_ACCESS_TOKEN"), null, "a refused agent read the value");
  const listed = await Effect.runPromise(keys.listForAgent("agent-ana"));
  assert.ok(!listed.some((key) => key.name === "META_ACCESS_TOKEN"), "list_api_keys shows a refused key");
  const rows = (await detail("shared", "META_ACCESS_TOKEN")).audit;
  assert.ok(
    rows.some((row) => row.action === "blocked" && row.actor.id === "agent-ana"),
    "the refusal is not in the history",
  );
  assert.ok(
    rows.some((row) => row.action === "used" && row.actor.id === "agent-carla"),
    "the use is not in the history",
  );
  return { carla: agentFiles("agent-carla"), ana: agentFiles("agent-ana") };
});

await step("a space's key reaches the agents of that space only, by default", async () => {
  await vault({ kind: "save", scope: "space:space-uni", name: "UNI_PORTAL_PASSWORD", value: SPACE_VALUE });
  assert.equal(keys.readNow("any", "agent-ana", "UNI_PORTAL_PASSWORD"), SPACE_VALUE);
  assert.equal(keys.readNow("any", "agent-beto", "UNI_PORTAL_PASSWORD"), SPACE_VALUE);
  assert.equal(keys.readNow("any", "agent-carla", "UNI_PORTAL_PASSWORD"), null);
  assert.ok(agentFiles("agent-beto").includes("_grants/agent-beto/UNI_PORTAL_PASSWORD"));
  assert.ok(!agentFiles("agent-carla").some((file) => file.endsWith("UNI_PORTAL_PASSWORD")));
  // An agent's own key is for that agent alone until the owner gives it to another.
  assert.equal(keys.readNow("any", "agent-beto", "ANA_KEY"), null);
  await vault({
    kind: "update",
    scope: "agent-ana",
    name: "ANA_KEY",
    access: { everyone: false, agents: ["agent-beto"], spaces: [] },
  });
  assert.equal(keys.readNow("any", "agent-beto", "ANA_KEY"), "ana-own-value-55e1d0");
});

await step("a new value is a new version; going back restores the old value as the newest version", async () => {
  now += DAY;
  await vault({ kind: "save", scope: "shared", name: "META_ACCESS_TOKEN", value: META_2 });
  let info = await detail("shared", "META_ACCESS_TOKEN");
  assert.equal(info.secret.version, 2);
  assert.equal(info.secret.rotatedAt, now);
  assert.equal(readFileSync(join(keysRoot, "_grants", "agent-carla", "META_ACCESS_TOKEN"), "utf8"), META_2);
  await vault({ kind: "rollback", scope: "shared", name: "META_ACCESS_TOKEN", version: 1 });
  info = await detail("shared", "META_ACCESS_TOKEN");
  assert.deepEqual(
    info.versions.map((version) => [version.version, version.current]),
    [
      [3, true],
      [2, false],
      [1, false],
    ],
  );
  assert.equal(keys.readNow("any", "agent-carla", "META_ACCESS_TOKEN"), META);
  const earlier = await vault({
    kind: "reveal",
    scope: "shared",
    name: "META_ACCESS_TOKEN",
    purpose: "show",
    version: 2,
  });
  assert.deepEqual(earlier, { kind: "value", value: META_2 });
  return info.versions.map((version) => version.version);
});

await step("each reveal and copy is in the history, without the value", async () => {
  await vault({ kind: "reveal", scope: "shared", name: "META_ACCESS_TOKEN", purpose: "copy" });
  const rows = (await detail("shared", "META_ACCESS_TOKEN")).audit;
  const revealed = rows.filter((row) => row.action === "revealed" || row.action === "copied");
  assert.ok(revealed.length >= 2);
  assert.ok(revealed.every((row) => row.actor.id === OWNER.id));
  assert.ok(!JSON.stringify(rows).includes(META) && !JSON.stringify(rows).includes(META_2));
  return revealed.map((row) => ({ action: row.action, detail: row.detail }));
});

await step("an expired key stops reaching agents and its file goes; clearing the date brings it back", async () => {
  await vault({ kind: "update", scope: "space:space-uni", name: "UNI_PORTAL_PASSWORD", expiresAt: now + 60_000 });
  assert.equal(keys.readNow("any", "agent-ana", "UNI_PORTAL_PASSWORD"), SPACE_VALUE);
  now += 120_000;
  const reminders = keys.ledger.sweep();
  assert.ok(reminders.some((reminder) => reminder.reason === "expired" && reminder.label === "UNI_PORTAL_PASSWORD"));
  assert.equal(keys.ledger.sweep().length, 0, "a reminder repeats");
  assert.equal(keys.readNow("any", "agent-ana", "UNI_PORTAL_PASSWORD"), null);
  assert.ok(!agentFiles("agent-ana").some((file) => file.endsWith("UNI_PORTAL_PASSWORD")));
  const rows = (await detail("space:space-uni", "UNI_PORTAL_PASSWORD")).audit;
  assert.ok(rows.some((row) => row.action === "expired"));
  await vault({ kind: "update", scope: "space:space-uni", name: "UNI_PORTAL_PASSWORD", expiresAt: null });
  assert.equal(keys.readNow("any", "agent-ana", "UNI_PORTAL_PASSWORD"), SPACE_VALUE);
});

await step("a rotation date that passes gives the owner one reminder", async () => {
  await vault({ kind: "update", scope: "shared", name: "OLD_SHARED_KEY", rotateBy: now + DAY, label: "Old portal" });
  assert.equal(keys.ledger.sweep().length, 0);
  now += 2 * DAY;
  const due = keys.ledger.sweep();
  assert.deepEqual(
    due.map((reminder) => [reminder.reason, reminder.label]),
    [["rotate", "Old portal"]],
  );
  await vault({ kind: "update", scope: "shared", name: "OLD_SHARED_KEY", rotateEveryDays: 90 });
  await vault({ kind: "save", scope: "shared", name: "OLD_SHARED_KEY", value: `${OLD_SHARED}-v2` });
  const info = await detail("shared", "OLD_SHARED_KEY");
  assert.equal(info.secret.rotateBy, now + 90 * DAY, "a new value does not move the date");
  return due;
});

await step("a deleted key leaves the agents at once and comes back from the bin", async () => {
  await vault({ kind: "delete", scope: "space:space-uni", name: "UNI_PORTAL_PASSWORD" });
  assert.equal(keys.readNow("any", "agent-ana", "UNI_PORTAL_PASSWORD"), null);
  const listed = await overview();
  assert.ok(listed?.trash.some((item) => item.name === "UNI_PORTAL_PASSWORD"));
  await vault({ kind: "restore", scope: "space:space-uni", name: "UNI_PORTAL_PASSWORD" });
  assert.equal(keys.readNow("any", "agent-ana", "UNI_PORTAL_PASSWORD"), SPACE_VALUE);
  await vault({ kind: "delete", scope: "space:space-uni", name: "UNI_PORTAL_PASSWORD" });
  now += 31 * DAY;
  keys.ledger.sweep();
  assert.equal((await overview())?.trash.length, 0, "the bin keeps a key past 30 days");
});

let bundle = "";
await step("an export opens only with its passphrase, and holds no readable value", async () => {
  const result = await vault({ kind: "export", passphrase: "correct horse battery" });
  assert.equal(result.kind, "bundle");
  if (result.kind !== "bundle") return;
  bundle = result.bundle;
  const decoded = Buffer.from(bundle, "base64").toString("utf8");
  for (const value of ALL_VALUES)
    assert.ok(!bundle.includes(value) && !decoded.includes(value), "a value is readable in the bundle");
  const other = new AgentApiKeys(join(root, "other-server"), { now: () => now });
  other.ledger.setDirectory(() => [{ id: "agent-zoe", name: "Zoe", spaceId: null }]);
  const otherService = new WorkspaceSecretsService(other, (id) => id === "agent-zoe");
  await assert.rejects(otherService.vault({ kind: "import", bundle, passphrase: "wrong passphrase" }, OWNER));
  const imported = await otherService.vault({ kind: "import", bundle, passphrase: "correct horse battery" }, OWNER);
  assert.equal(imported.kind, "imported");
  // A key of an agent this server does not have arrives shared with nobody.
  assert.equal(other.readNow("any", "agent-zoe", "ANA_KEY"), null);
  assert.equal(other.readNow("any", "agent-zoe", "OLD_SHARED_KEY"), `${OLD_SHARED}-v2`);
  return { result: imported, count: result.count };
});

await step("no value is in the history, the ledger, the projection list or a log line", () => {
  const vaultFolder = join(keysRoot, "_vault");
  for (const file of readdirSync(vaultFolder)) {
    if (file === "key") continue;
    const text = readFileSync(join(vaultFolder, file), "utf8");
    for (const value of ALL_VALUES) assert.ok(!text.includes(value), `${file} holds a value`);
  }
  for (const value of [...ALL_VALUES, `${OLD_SHARED}-v2`])
    assert.ok(!redactText(`Authorization: Bearer ${value}`).includes(value), "a value is not masked in logs");
  return readdirSync(vaultFolder).sort();
});

write();
rmSync(root, { recursive: true, force: true });
process.stdout.write(`secret-vault-e2e: ${steps.length} steps passed\n`);
