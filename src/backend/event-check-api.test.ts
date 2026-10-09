// @vitest-environment node
// Failure modes: secret echo/leak, account mixing, stale reads, malformed output, escaped paths,
// shared code reusing baseline, old-protocol widening, and quiet tests starting model turns.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeEventCheckEnvironmentInput,
  decodeEventCheckInput,
  decodeMcpEventCheckInput,
  type EventCheckInput,
} from "@openbot/contracts/event-checks";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentService } from "./agent-service";
import {
  createTestService,
  FakeAgentClient,
  startAgentTestFixture,
  stopAgentTestFixture,
  stores,
  waitFor,
  waitForQueue,
} from "./agent-service-test-harness";
import { runCauseEffect } from "./effect-boundary";
import { EventCheckApiReader } from "./event-check-api-reader";
import { EventCheckEnvironment } from "./event-check-environment";
import { EventCheckStore } from "./event-check-store";

let root: string,
  service: AgentService | null = null;
function cipher() {
  const key = randomBytes(32);
  return {
    encrypt(value: string) {
      const iv = randomBytes(12),
        encrypt = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, encrypt.update(value), encrypt.final(), encrypt.getAuthTag()]).toString("base64");
    },
    decrypt(value: string) {
      const content = Buffer.from(value, "base64"),
        decrypt = createDecipheriv("aes-256-gcm", key, content.subarray(0, 12));
      decrypt.setAuthTag(content.subarray(-16));
      return Buffer.concat([decrypt.update(content.subarray(12, -16)), decrypt.final()]).toString("utf8");
    },
  };
}
function input(): EventCheckInput {
  return decodeEventCheckInput({
    agentId: "chief",
    name: "API tickets",
    instruction: "Review changes quietly.",
    active: false,
    timezone: "UTC",
    selfEvents: { mode: "include", connectionId: "job-one", actorPointer: "", accountActorIds: [] },
    source: {
      kind: "api",
      connectionId: "job-one",
      toolName: "tickets.mjs",
      variables: ["TEST_API_TOKEN", "SECOND_API_TOKEN"],
      configuration: [{ name: "workspace", label: "Workspace", description: "One workspace to check", value: "one" }],
      argumentsJson: "{}",
      cursorArgument: "cursor",
      nextCursorPointer: "/cursor",
    },
    selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" },
  });
}
async function boot() {
  const { store, mailbox } = stores(root),
    checks = new EventCheckStore(store.database),
    client = new FakeAgentClient("codex");
  const programs = join(store.sharedRoot, "Watchers");
  await mkdir(programs, { recursive: true });
  const environment = new EventCheckEnvironment(join(root, "private-watchers"), cipher());
  const reader = new EventCheckApiReader(
    environment,
    programs,
    (check) => checks.current(check.id, check.revision) !== null,
    process.execPath,
  );
  service = createTestService({ store, mailbox, clientFactory: () => client, eventCheckApiReader: reader });
  await runCauseEffect(service.initialize());
  await runCauseEffect(store.getOrCreate("chief"));
  await writeFile(join(programs, "data.json"), JSON.stringify({ text: "first", status: "todo" }));
  await writeFile(
    join(programs, "tickets.mjs"),
    `import fs from 'node:fs';
let raw=''; for await (const chunk of process.stdin) raw += chunk;
const config=JSON.parse(raw), item=JSON.parse(fs.readFileSync('data.json','utf8'));
if (process.env.OPENAI_API_KEY || process.env.CLOUDFLARE_API_TOKEN) throw Error('inherited secret');
process.stdout.write(JSON.stringify({items:[{id:config.workspace,revision:item.text,text:item.text,status:item.status,echo:process.env.TEST_API_TOKEN,second:process.env.SECOND_API_TOKEN,encoded:encodeURIComponent(process.env.TEST_API_TOKEN)}],hasNextPage:false}));`,
  );
  return { service, checks, client, environment, programs };
}
beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
});
afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});
it("runs shared API programs with separate masked variables, editable config, no idle inference and one wakeup", async () => {
  const { service, checks, client, environment, programs } = await boot();
  const saved = await runCauseEffect(service.eventChecks.save(input())),
    target = { agentId: "chief", id: saved.id };
  expect((await runCauseEffect(service.eventChecks.environment(target))).every((field) => !field.configured)).toBe(
    true,
  );
  expect((await runCauseEffect(service.eventChecks.test(target))).status).toBe("error");
  await expect(runCauseEffect(service.eventChecks.save({ ...saved, active: true }))).rejects.toThrow();
  const token = "private-api-token/secret=first";
  await Promise.all([
    runCauseEffect(service.eventChecks.setEnvironment({ ...target, name: "TEST_API_TOKEN", value: token })),
    runCauseEffect(
      service.eventChecks.setEnvironment({ ...target, name: "SECOND_API_TOKEN", value: "second-private-api-token" }),
    ),
  ]);
  expect(await runCauseEffect(service.eventChecks.environment(target))).toEqual([
    { name: "TEST_API_TOKEN", configured: true },
    { name: "SECOND_API_TOKEN", configured: true },
  ]);
  expect(await readFile(join(environment.root, saved.id, ".env"), "utf8")).not.toContain(token);
  expect((await runCauseEffect(service.eventChecks.test(target))).status).toBe("baseline");
  expect(checks.state(saved.id).baseline).toBeNull();
  expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(0);
  const paused = checks.get("chief", saved.id);
  const active = await runCauseEffect(service.eventChecks.save({ ...paused, active: true }));
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("baseline");
  await writeFile(join(programs, "data.json"), JSON.stringify({ text: "first", status: "done" }));
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("unchanged");
  await writeFile(join(programs, "data.json"), JSON.stringify({ text: "first" + "x".repeat(1000), status: "done" }));
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("triggered");
  await waitForQueue(service, "chief", (queue) => queue.deliveries.some((delivery) => delivery.status === "completed"));
  await runCauseEffect(service.eventChecks.checkNow(target));
  expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  expect(JSON.stringify(client.requests)).not.toContain(token);
  expect(JSON.stringify(checks.pending())).not.toContain(token);
  const second = await runCauseEffect(
    service.eventChecks.save({
      ...input(),
      name: "Second workspace",
      source: { ...input().source, connectionId: "job-two" },
    }),
  );
  expect(
    (await runCauseEffect(service.eventChecks.environment({ agentId: "chief", id: second.id }))).every(
      (field) => !field.configured,
    ),
  ).toBe(true);
  await expect(
    runCauseEffect(
      service.eventChecks.setEnvironment({
        agentId: "other",
        id: saved.id,
        name: "TEST_API_TOKEN",
        value: "wrong-account-token",
      }),
    ),
  ).rejects.toThrow();
  await runCauseEffect(service.eventChecks.setEnvironment({ ...target, name: "TEST_API_TOKEN", value: null }));
  expect(checks.get("chief", saved.id).active).toBe(false);
  expect(checks.state(saved.id).baseline).toBeNull();
  expect((await runCauseEffect(service.eventChecks.test(target))).status).toBe("error");
  for (let i = 0; i < 12; i++) await runCauseEffect(service.eventChecks.test(target));
  expect((await runCauseEffect(service.eventChecks.history(target))).length).toBe(10);
  expect(() => decodeMcpEventCheckInput(active)).toThrow();
  await mkdir(".openbot-build", { recursive: true });
  await writeFile(
    ".openbot-build/api-watcher-verification.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        privateValuesReturned: false,
        ciphertextAtRest: true,
        sharedProgram: true,
        perInstanceCredentials: true,
        pausedTestInferenceTurns: 0,
        eventTurns: 1,
        duplicateTurns: 0,
        contentOnly: true,
        historyLimit: 10,
        v1RejectsApi: true,
      },
      null,
      2,
    ),
  );
});
it("rejects unsafe variables, program escapes, and configuration secrets", async () => {
  const { service } = await boot();
  for (const name of ["PATH", "NODE_OPTIONS", "PYTHONPATH", "BASH_ENV", "LD_PRELOAD"])
    expect(() => decodeEventCheckInput({ ...input(), source: { ...input().source, variables: [name] } })).toThrow();
  expect(() =>
    decodeEventCheckEnvironmentInput({ agentId: "chief", id: "x", name: "TEST_API_TOKEN", value: "a\nb" }),
  ).toThrow();
  expect(() =>
    decodeEventCheckEnvironmentInput({ agentId: "chief", id: "x", name: "TEST_API_TOKEN", value: "xy" }),
  ).toThrow();
  await expect(
    runCauseEffect(service.eventChecks.save({ ...input(), source: { ...input().source, toolName: "../outside.mjs" } })),
  ).rejects.toThrow();
  expect(() =>
    decodeEventCheckInput({
      ...input(),
      source: {
        ...input().source,
        configuration: [{ name: "api_token", label: "Token", description: "", value: "bad" }],
      },
    }),
  ).toThrow();
});

it("records program failures, prevents incomplete pages, resets edited programs and cancels stale reads", async () => {
  const { service, checks, programs } = await boot();
  let saved = await runCauseEffect(service.eventChecks.save(input()));
  const target = { agentId: "chief", id: saved.id };
  for (const name of ["TEST_API_TOKEN", "SECOND_API_TOKEN"])
    await runCauseEffect(service.eventChecks.setEnvironment({ ...target, name, value: "private-test-value" }));
  saved = await runCauseEffect(service.eventChecks.save({ ...checks.get("chief", saved.id), active: true }));
  await runCauseEffect(service.eventChecks.checkNow(target));
  await writeFile(join(programs, "tickets.mjs"), `process.stdout.write(JSON.stringify({items:[],hasNextPage:true}));`);
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("error");
  expect(checks.state(saved.id).baseline).toBeNull();
  await writeFile(join(programs, "tickets.mjs"), `process.stdout.write(JSON.stringify({items:[],hasNextPage:false}));`);
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("baseline");
  await writeFile(join(programs, "tickets.mjs"), `process.stdout.write('invalid json '+process.env.TEST_API_TOKEN);`);
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("error");
  const captured = checks.get("chief", saved.id);
  await runCauseEffect(
    service.eventChecks.setEnvironment({ ...target, name: "TEST_API_TOKEN", value: "rotated-private-value" }),
  );
  expect(checks.get("chief", saved.id).active).toBe(false);
  expect(checks.current(saved.id, captured.revision)).toBeNull();
  await writeFile(join(programs, "tickets.mjs"), "x".repeat(1_048_577));
  expect((await runCauseEffect(service.eventChecks.test(target))).status).toBe("error");
  expect(JSON.stringify(await runCauseEffect(service.eventChecks.history(target)))).not.toContain("private-test-value");
});

it("stops stale program work and its descendants when private variables change", async () => {
  const { service, programs } = await boot();
  await writeFile(
    join(programs, "tickets.mjs"),
    `import fs from 'node:fs'; import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
fs.writeFileSync('owned-child.pid',String(child.pid));fs.writeFileSync('ready','ready');setInterval(()=>{},1000);`,
  );
  const saved = await runCauseEffect(service.eventChecks.save(input())),
    target = { agentId: "chief", id: saved.id };
  for (const name of ["TEST_API_TOKEN", "SECOND_API_TOKEN"])
    await runCauseEffect(service.eventChecks.setEnvironment({ ...target, name, value: "private-test-value" }));
  const reading = runCauseEffect(service.eventChecks.test(target));
  await waitFor(() => existsSync(join(programs, "ready")));
  const pid = Number(readFileSync(join(programs, "owned-child.pid"), "utf8"));
  await runCauseEffect(
    service.eventChecks.setEnvironment({ ...target, name: "TEST_API_TOKEN", value: "new-private-value" }),
  );
  expect((await reading).status).toBe("error");
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  expect((await runCauseEffect(service.eventChecks.history(target)))[0]?.status).toBe("cancelled");
});
