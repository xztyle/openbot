// @vitest-environment node
// Failure modes: a client supplying program text, a modified shared program being trusted, a template
// link resetting a live baseline, an update losing the user's settings, and a missing required setting.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventCheckTemplate } from "@openbot/contracts/event-check-templates";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentService } from "./agent-service";
import {
  createTestService,
  FakeAgentClient,
  startAgentTestFixture,
  stopAgentTestFixture,
  stores,
} from "./agent-service-test-harness";
import { runCauseEffect } from "./effect-boundary";
import { EventCheckApiReader } from "./event-check-api-reader";
import { EventCheckEnvironment } from "./event-check-environment";
import { EventCheckStore } from "./event-check-store";
import { EventCheckTemplates } from "./event-check-templates";

let root: string,
  service: AgentService | null = null;
const PROGRAM = `let raw=''; for await (const chunk of process.stdin) raw += chunk;
const config = JSON.parse(raw);
process.stdout.write(JSON.stringify({items:[{id:config.workspace,revision:'1',actor:'someone'}],hasNextPage:false}));`;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function template(version: string, program: string): EventCheckTemplate {
  return {
    slug: "fixture",
    name: "Fixture",
    tagline: "A fixture",
    description: "A fixture template",
    version,
    creatorName: "OpenBot",
    iconUrl: null,
    websiteUrl: null,
    app: null,
    program: { file: "fixture.mjs", digest: digest(program) },
    accountLabelHint: "Work account",
    variables: [],
    configuration: [
      { name: "workspace", label: "Workspace", description: "Which workspace", value: "", required: true },
      { name: "pageSize", label: "Page size", description: "Items per page", value: "50", required: false },
    ],
    argumentsJson: "{}",
    cursorArgument: "cursor",
    nextCursorPointer: "/cursor",
    selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" },
    actorPointer: "/actor",
    intervalSeconds: 60,
    instruction: "Review changes quietly.",
  };
}
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
async function boot(shipped: EventCheckTemplate, program = PROGRAM) {
  const { store, mailbox } = stores(root),
    checks = new EventCheckStore(store.database),
    programs = join(store.sharedRoot, "Watchers"),
    catalog = join(root, "catalog");
  await mkdir(programs, { recursive: true });
  await mkdir(join(catalog, "programs"), { recursive: true });
  await writeFile(join(catalog, "catalog.json"), JSON.stringify([shipped]));
  await writeFile(join(catalog, "programs", "fixture.mjs"), program);
  const reader = new EventCheckApiReader(
    new EventCheckEnvironment(join(root, "private-watchers"), cipher()),
    programs,
    (check) => checks.current(check.id, check.revision) !== null,
    process.execPath,
  );
  service = createTestService({
    store,
    mailbox,
    clientFactory: () => new FakeAgentClient("codex"),
    eventCheckApiReader: reader,
    eventCheckTemplates: new EventCheckTemplates(catalog, programs),
  });
  await runCauseEffect(service.initialize());
  await runCauseEffect(store.getOrCreate("chief"));
  return { service, checks, programs };
}
const request = (configuration: Record<string, string>) => ({
  slug: "fixture",
  agentId: "chief",
  name: "Fixture — work",
  accountLabel: "work",
  instruction: "Review changes quietly.",
  timezone: "UTC",
  intervalSeconds: 60,
  accountActorIds: ["me"],
  configuration,
});
beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
});
afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});
it("installs a paused, linked check from the shipped program and refuses unknown or missing settings", async () => {
  const { service, programs } = await boot(template("1.0.0", PROGRAM));
  const checks = service.eventChecks;
  expect(await runCauseEffect(checks.templateList())).toHaveLength(1);
  const installed = await runCauseEffect(checks.templateInstall(request({ workspace: "alpha" })));
  expect(installed.active).toBe(false);
  expect(installed.source.kind === "api" && installed.source.template).toEqual({ slug: "fixture", version: "1.0.0" });
  expect(installed.source.kind === "api" && installed.source.configuration.map((field) => field.value)).toEqual([
    "alpha",
    "50",
  ]);
  expect(readFileSync(join(programs, "fixture@1.0.0.mjs"), "utf8")).toBe(PROGRAM);
  await expect(runCauseEffect(checks.templateInstall(request({})))).rejects.toThrow();
  await expect(runCauseEffect(checks.templateInstall(request({ workspace: "a", extra: "b" })))).rejects.toThrow();
  const second = await runCauseEffect(
    checks.templateInstall({ ...request({ workspace: "beta" }), accountLabel: "home" }),
  );
  expect(second.id).not.toBe(installed.id);
});
it("never replaces a shared program that no longer matches the reviewed one", async () => {
  const { service, programs } = await boot(template("1.0.0", PROGRAM));
  await writeFile(join(programs, "fixture@1.0.0.mjs"), `${PROGRAM}\n// edited`);
  await expect(runCauseEffect(service.eventChecks.templateInstall(request({ workspace: "alpha" })))).rejects.toThrow();
  expect(readFileSync(join(programs, "fixture@1.0.0.mjs"), "utf8")).toContain("// edited");
});
it("links an existing check without resetting its baseline, and refuses a program that differs", async () => {
  const { service, checks, programs } = await boot(template("1.0.0", PROGRAM));
  const installed = await runCauseEffect(service.eventChecks.templateInstall(request({ workspace: "alpha" })));
  const target = { agentId: "chief", id: installed.id };
  await runCauseEffect(service.eventChecks.test(target));
  // A check that predates the catalog: the same program under its own name, with no link.
  await writeFile(join(programs, "mine.mjs"), PROGRAM);
  if (installed.source.kind !== "api") throw new Error("Expected an API check.");
  const { template: _link, ...source } = installed.source;
  const legacy = await runCauseEffect(
    service.eventChecks.save({
      ...installed,
      id: undefined,
      name: "Legacy",
      active: true,
      source: { ...source, toolName: "mine.mjs" },
    }),
  );
  await runCauseEffect(service.eventChecks.checkNow({ agentId: "chief", id: legacy.id }));
  const before = checks.state(legacy.id);
  expect(before.baseline).not.toBeNull();
  const linked = await runCauseEffect(
    service.eventChecks.templateAdopt({ agentId: "chief", id: legacy.id, slug: "fixture" }),
  );
  expect(linked.source.kind === "api" && linked.source.template?.slug).toBe("fixture");
  expect(checks.state(legacy.id)).toEqual(before);
  await writeFile(join(programs, "mine.mjs"), `${PROGRAM}\n// edited`);
  await expect(
    runCauseEffect(service.eventChecks.templateAdopt({ agentId: "chief", id: legacy.id, slug: "fixture" })),
  ).rejects.toThrow();
});
it("moves a linked check to the newer program, keeps the user's settings and gives it a fresh baseline", async () => {
  const next = `${PROGRAM}\n// version two`;
  const shipped = template("2.0.0", next);
  const { service, checks, programs } = await boot(
    {
      ...shipped,
      configuration: [
        ...shipped.configuration,
        { name: "label", label: "Label", description: "New in 2", value: "default", required: false },
      ],
    },
    next,
  );
  await writeFile(join(programs, "fixture@1.0.0.mjs"), PROGRAM);
  const old = await runCauseEffect(
    service.eventChecks.save({
      agentId: "chief",
      name: "Old",
      instruction: "Mine",
      active: true,
      timezone: "UTC",
      schedule: { kind: "interval", amount: 120, unit: "seconds", anchorAt: new Date().toISOString() },
      selfEvents: { mode: "exclude", connectionId: "work", actorPointer: "/actor", accountActorIds: ["me"] },
      source: {
        kind: "api",
        connectionId: "work",
        variables: [],
        configuration: [{ name: "workspace", label: "Workspace", description: "Which workspace", value: "alpha" }],
        toolName: "fixture@1.0.0.mjs",
        argumentsJson: "{}",
        cursorArgument: "cursor",
        nextCursorPointer: "/cursor",
        template: { slug: "fixture", version: "1.0.0" },
      },
      selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" },
    }),
  );
  await runCauseEffect(service.eventChecks.checkNow({ agentId: "chief", id: old.id }));
  expect(checks.state(old.id).baseline).not.toBeNull();
  const updated = await runCauseEffect(service.eventChecks.templateUpdate({ agentId: "chief", id: old.id }));
  expect(updated.source.kind === "api" && updated.source.template?.version).toBe("2.0.0");
  expect(updated.source.kind === "api" && updated.source.toolName).toBe("fixture@2.0.0.mjs");
  expect(
    updated.source.kind === "api" && updated.source.configuration.map((field) => [field.name, field.value]),
  ).toEqual([
    ["workspace", "alpha"],
    ["pageSize", "50"],
    ["label", "default"],
  ]);
  expect(updated.name).toBe("Old");
  expect(updated.schedule).toMatchObject({ amount: 120 });
  expect(checks.state(old.id).baseline).toBeNull();
  expect(existsSync(join(programs, "fixture@1.0.0.mjs"))).toBe(true);
  await expect(runCauseEffect(service.eventChecks.templateUpdate({ agentId: "chief", id: old.id }))).rejects.toThrow();
});
