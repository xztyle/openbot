// @vitest-environment node
// Failure modes: a client supplying program text, a modified shared program being trusted, a template
// link resetting a live baseline, an update losing the user's settings, and a missing required setting.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventCheckTemplate } from "@openbot/contracts/event-check-templates";
import { decodeEventCheckInput, type EventCheck, type EventCheckConfiguration } from "@openbot/contracts/event-checks";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EVENT_CHECK_TOOL_DEFINITIONS } from "./agent/event-check-tools";
import type { AgentService } from "./agent-service";
import {
  callOpenBotTool,
  createTestService,
  FakeAgentClient,
  paramsRecord,
  startAgentTestFixture,
  stopAgentTestFixture,
  stores,
  waitFor,
} from "./agent-service-test-harness";
import { runCauseEffect } from "./effect-boundary";
import { EventCheckApiReader } from "./event-check-api-reader";
import { EventCheckEnvironment } from "./event-check-environment";
import { EventCheckStore } from "./event-check-store";
import { EventCheckTemplates } from "./event-check-templates";
import { getString } from "./protocol";
import { LOCAL_USER_ACTOR as TEST_USER } from "./security-actor";
import { SecurityAuditLog } from "./security-audit-log";

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
      {
        name: "workspace",
        label: "Workspace",
        description: "Which workspace",
        value: "",
        required: true,
        type: "text",
      },
      {
        name: "pageSize",
        label: "Page size",
        description: "Items per page",
        value: "50",
        required: false,
        type: "text",
      },
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
async function boot(
  shipped: EventCheckTemplate,
  program = PROGRAM,
  earlierFiles: Record<string, string> = {},
  audit?: SecurityAuditLog,
) {
  const { store, mailbox } = stores(root),
    checks = new EventCheckStore(store.database),
    programs = join(store.sharedRoot, "Watchers"),
    catalog = join(root, "catalog");
  await mkdir(programs, { recursive: true });
  await mkdir(join(catalog, "programs"), { recursive: true });
  await writeFile(join(catalog, "catalog.json"), JSON.stringify([shipped]));
  await writeFile(join(catalog, "programs", "fixture.mjs"), program);
  for (const [file, content] of Object.entries(earlierFiles)) await writeFile(join(catalog, "programs", file), content);
  const templates = new EventCheckTemplates(catalog, programs);
  const reader = new EventCheckApiReader(
    new EventCheckEnvironment(join(root, "private-watchers"), cipher(), (check) => templates.reviewed(check)),
    programs,
    (check) => checks.current(check.id, check.revision) !== null,
    process.execPath,
  );
  const client = new FakeAgentClient("codex");
  service = createTestService({
    store,
    mailbox,
    clientFactory: () => client,
    eventCheckApiReader: reader,
    eventCheckTemplates: templates,
    ...(audit ? { securityAudit: audit } : {}),
  });
  await runCauseEffect(service.initialize());
  await runCauseEffect(store.getOrCreate("chief"));
  return { service, checks, programs, client, store };
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
  const installed = await runCauseEffect(checks.templateInstall(request({ workspace: "alpha" }), TEST_USER));
  expect(installed.active).toBe(false);
  expect(installed.source.kind === "api" && installed.source.template).toEqual({ slug: "fixture", version: "1.0.0" });
  expect(installed.source.kind === "api" && installed.source.configuration.map((field) => field.value)).toEqual([
    "alpha",
    "50",
  ]);
  expect(readFileSync(join(programs, "fixture@1.0.0.mjs"), "utf8")).toBe(PROGRAM);
  await expect(runCauseEffect(checks.templateInstall(request({}), TEST_USER))).rejects.toThrow();
  await expect(
    runCauseEffect(checks.templateInstall(request({ workspace: "a", extra: "b" }), TEST_USER)),
  ).rejects.toThrow();
  const second = await runCauseEffect(
    checks.templateInstall({ ...request({ workspace: "beta" }), accountLabel: "home" }, TEST_USER),
  );
  expect(second.id).not.toBe(installed.id);
});
it("never replaces a shared program that no longer matches the reviewed one", async () => {
  const { service, programs } = await boot(template("1.0.0", PROGRAM));
  await writeFile(join(programs, "fixture@1.0.0.mjs"), `${PROGRAM}\n// edited`);
  await expect(
    runCauseEffect(service.eventChecks.templateInstall(request({ workspace: "alpha" }), TEST_USER)),
  ).rejects.toThrow();
  expect(readFileSync(join(programs, "fixture@1.0.0.mjs"), "utf8")).toContain("// edited");
});
it("links an existing check without resetting its baseline, and refuses a program that differs", async () => {
  const { service, checks, programs } = await boot(template("1.0.0", PROGRAM));
  const installed = await runCauseEffect(
    service.eventChecks.templateInstall(request({ workspace: "alpha" }), TEST_USER),
  );
  const target = { agentId: "chief", id: installed.id };
  await runCauseEffect(service.eventChecks.test(target));
  // A check that predates the catalog: the same program under its own name, with no link.
  await writeFile(join(programs, "mine.mjs"), PROGRAM);
  if (installed.source.kind !== "api") throw new Error("Expected an API check.");
  const { template: _link, ...source } = installed.source;
  const legacy = await runCauseEffect(
    service.eventChecks.save(
      {
        ...installed,
        id: undefined,
        name: "Legacy",
        active: true,
        source: { ...source, toolName: "mine.mjs" },
      },
      TEST_USER,
    ),
  );
  await runCauseEffect(service.eventChecks.checkNow({ agentId: "chief", id: legacy.id }));
  const before = checks.state(legacy.id);
  expect(before.baseline).not.toBeNull();
  const linked = await runCauseEffect(
    service.eventChecks.templateAdopt({ agentId: "chief", id: legacy.id, slug: "fixture" }, TEST_USER),
  );
  expect(linked.source.kind === "api" && linked.source.template?.slug).toBe("fixture");
  expect(checks.state(legacy.id)).toEqual(before);
  await writeFile(join(programs, "mine.mjs"), `${PROGRAM}\n// edited`);
  await expect(
    runCauseEffect(service.eventChecks.templateAdopt({ agentId: "chief", id: legacy.id, slug: "fixture" }, TEST_USER)),
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
        { name: "label", label: "Label", description: "New in 2", value: "default", required: false, type: "text" },
      ],
    },
    next,
  );
  await writeFile(join(programs, "fixture@1.0.0.mjs"), PROGRAM);
  const old = await runCauseEffect(
    service.eventChecks.save(
      {
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
      },
      TEST_USER,
    ),
  );
  await runCauseEffect(service.eventChecks.checkNow({ agentId: "chief", id: old.id }));
  expect(checks.state(old.id).baseline).not.toBeNull();
  const updated = await runCauseEffect(service.eventChecks.templateUpdate({ agentId: "chief", id: old.id }, TEST_USER));
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
  await expect(
    runCauseEffect(service.eventChecks.templateUpdate({ agentId: "chief", id: old.id }, TEST_USER)),
  ).rejects.toThrow();
});

it("keeps private values through an update to the reviewed program and withholds them from an edited copy", async () => {
  const next = `${PROGRAM}\n// version two`;
  const shipped = {
    ...template("2.0.0", next),
    variables: [{ name: "FIXTURE_API_TOKEN", label: "Key", hint: "", docsUrl: null }],
  };
  const { service, checks, programs } = await boot(shipped, next);
  await writeFile(join(programs, "fixture@1.0.0.mjs"), PROGRAM);
  const old = await runCauseEffect(
    service.eventChecks.save(
      {
        agentId: "chief",
        name: "Old",
        instruction: "Mine",
        active: false,
        timezone: "UTC",
        schedule: { kind: "interval", amount: 120, unit: "seconds", anchorAt: new Date().toISOString() },
        selfEvents: { mode: "exclude", connectionId: "work", actorPointer: "/actor", accountActorIds: ["me"] },
        source: {
          kind: "api",
          connectionId: "work",
          variables: ["FIXTURE_API_TOKEN"],
          configuration: [{ name: "workspace", label: "Workspace", description: "Which workspace", value: "alpha" }],
          toolName: "fixture@1.0.0.mjs",
          argumentsJson: "{}",
          cursorArgument: "cursor",
          nextCursorPointer: "/cursor",
          template: { slug: "fixture", version: "1.0.0" },
        },
        selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" },
      },
      TEST_USER,
    ),
  );
  const target = { agentId: "chief", id: old.id };
  await runCauseEffect(
    service.eventChecks.setEnvironment(
      { ...target, name: "FIXTURE_API_TOKEN", value: "fixture-private-key" },
      TEST_USER,
    ),
  );
  await runCauseEffect(service.eventChecks.save({ ...checks.get("chief", old.id), active: true }, TEST_USER));
  const agent = { kind: "agent", agentId: "chief", name: "Chief" } as const;
  // The catalog's own program counts as approved, so an agent can move the check to it.
  const updated = await runCauseEffect(service.eventChecks.templateUpdate(target, agent));
  expect(updated.active).toBe(true);
  expect(await runCauseEffect(service.eventChecks.environment(target))).toEqual([
    { name: "FIXTURE_API_TOKEN", configured: true },
  ]);
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("baseline");
  // A copy of that file that someone edited is not the reviewed program.
  await writeFile(join(programs, "fixture@2.0.0.mjs"), `${next}\n// edited`);
  expect((await runCauseEffect(service.eventChecks.checkNow(target))).status).toBe("error");
  expect(checks.get("chief", old.id).active).toBe(false);
  expect(await runCauseEffect(service.eventChecks.environment(target))).toEqual([
    { name: "FIXTURE_API_TOKEN", configured: false, reapprove: true },
  ]);
});

it("links a check that runs an earlier shipped program to that version, keeps its baseline, then updates it", async () => {
  const earlier = `${PROGRAM}\n// version one`;
  const next = `${PROGRAM}\n// version two`;
  const { service, checks, programs } = await boot(
    {
      ...template("2.0.0", next),
      earlierPrograms: [{ version: "1.0.0", file: "fixture-1.0.0.mjs", digest: digest(earlier) }],
    },
    next,
    { "fixture-1.0.0.mjs": earlier },
  );
  // The live check of a user: the earlier program under its own name, with no template link.
  await writeFile(join(programs, "live.mjs"), earlier);
  const live = await runCauseEffect(
    service.eventChecks.save(
      {
        agentId: "chief",
        name: "Live",
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
          toolName: "live.mjs",
          argumentsJson: "{}",
          cursorArgument: "cursor",
          nextCursorPointer: "/cursor",
        },
        selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" },
      },
      TEST_USER,
    ),
  );
  await runCauseEffect(service.eventChecks.checkNow({ agentId: "chief", id: live.id }));
  const before = checks.state(live.id);
  expect(before.baseline).not.toBeNull();
  const linked = await runCauseEffect(
    service.eventChecks.templateAdopt({ agentId: "chief", id: live.id, slug: "fixture" }, TEST_USER),
  );
  // The link names the version whose program the check runs, so Update has something to move from.
  expect(linked.source.kind === "api" && linked.source.template).toEqual({ slug: "fixture", version: "1.0.0" });
  expect(checks.state(live.id)).toEqual(before);
  const updated = await runCauseEffect(
    service.eventChecks.templateUpdate({ agentId: "chief", id: live.id }, TEST_USER),
  );
  expect(updated.source.kind === "api" && updated.source.template?.version).toBe("2.0.0");
  expect(updated.source.kind === "api" && updated.source.toolName).toBe("fixture@2.0.0.mjs");
  expect(readFileSync(join(programs, "fixture@2.0.0.mjs"), "utf8")).toBe(next);
  expect(readFileSync(join(programs, "live.mjs"), "utf8")).toBe(earlier);
});

it("maps the one error code a program prints to fixed text, and never repeats the program's own text", async () => {
  const failing = `let raw=''; for await (const chunk of process.stdin) raw += chunk;
const config = JSON.parse(raw);
const codes = { auth: 'auth', limited: 'rate_limited', setup: 'config', down: 'upstream', weird: 'root' };
process.stderr.write('SECRET-TEXT-FROM-THE-PROGRAM token=abc123\\nopenbot-error: ' + codes[config.workspace] + '\\n');
process.exit(1);`;
  const { service } = await boot(template("1.0.0", failing), failing);
  const text = async (workspace: string) => {
    const installed = await runCauseEffect(service.eventChecks.templateInstall(request({ workspace }), TEST_USER));
    const execution = await runCauseEffect(service.eventChecks.checkNow({ agentId: "chief", id: installed.id }));
    expect(execution.status).toBe("error");
    expect(execution.error).not.toContain("SECRET-TEXT");
    expect(execution.error).not.toContain("abc123");
    return execution.error;
  };
  const messages = [
    await text("auth"),
    await text("limited"),
    await text("setup"),
    await text("down"),
    await text("weird"),
  ];
  expect(new Set(messages).size).toBe(5);
  expect(messages[0]).toContain("did not accept the saved credentials");
  expect(messages[1]).toContain("limited the requests");
  expect(messages[2]).toContain("did not accept the settings");
  expect(messages[3]).toContain("could not be reached");
  // A code outside the list is the generic message.
  expect(messages[4]).toContain("The app check failed.");
});

it("lets an agent list, install and enable a template, rejects a non-boolean value, and has no field for private values", async () => {
  const shipped = template("1.0.0", PROGRAM);
  const { service, client, store } = await boot({
    ...shipped,
    variables: [{ name: "FIXTURE_API_TOKEN", label: "API key", hint: "Create one.", docsUrl: null }],
    configuration: [
      ...shipped.configuration,
      {
        name: "notify",
        label: "Notify",
        description: "Wake the agent",
        value: "true",
        required: false,
        type: "boolean",
      },
    ],
  });
  await runCauseEffect(service.sendMessage({ agentId: "chief", text: "Set up the fixture check." }));
  await waitFor(() => Boolean(store.activeProviderSession("chief")?.externalSessionId));
  const threadId = store.activeProviderSession("chief")?.externalSessionId;
  if (!threadId) throw new Error("Provider session did not start.");
  const call = async (tool: string, args: unknown) => {
    const { result } = await callOpenBotTool(client, threadId, tool, args);
    const items = paramsRecord(result)?.contentItems;
    return {
      success: paramsRecord(result)?.success === true,
      text: Array.isArray(items) ? (getString(items[0], "text") ?? "") : "",
    };
  };
  const listed = await call("list_event_check_templates", {});
  expect(listed.success).toBe(true);
  expect(listed.text).toContain('"slug":"fixture"');
  const bad = await call("install_event_check_template", {
    slug: "fixture",
    accountLabel: "work",
    configuration: [
      { name: "workspace", value: "alpha" },
      { name: "notify", value: "yes" },
    ],
  });
  expect(bad.success).toBe(false);
  expect(await runCauseEffect(service.eventChecks.list({ agentId: "chief" }))).toHaveLength(0);
  const installed = await call("install_event_check_template", {
    slug: "fixture",
    accountLabel: "work",
    accountActorIds: ["me"],
    configuration: [{ name: "workspace", value: "alpha" }],
  });
  expect(installed.success).toBe(true);
  const [check] = await runCauseEffect(service.eventChecks.list({ agentId: "chief" }));
  expect(check?.active).toBe(false);
  expect(check?.name).toBe("Fixture — work");
  expect(check?.source.kind === "api" && check.source.template?.slug).toBe("fixture");
  // The private variable is declared but unset, so enabling fails until the user adds it.
  const early = await call("set_event_check_active", { id: check?.id, active: true });
  expect(early.success).toBe(false);
  expect((await runCauseEffect(service.eventChecks.list({ agentId: "chief" })))[0]?.active).toBe(false);
});

it("tells an agent why a template update was refused, instead of a generic failure", async () => {
  const { service, client, store } = await boot(template("1.0.0", PROGRAM));
  await runCauseEffect(service.sendMessage({ agentId: "chief", text: "Update the check." }));
  await waitFor(() => Boolean(store.activeProviderSession("chief")?.externalSessionId));
  const threadId = store.activeProviderSession("chief")?.externalSessionId;
  if (!threadId) throw new Error("Provider session did not start.");
  const call = async (tool: string, args: unknown) => {
    const { result } = await callOpenBotTool(client, threadId, tool, args);
    const items = paramsRecord(result)?.contentItems;
    return Array.isArray(items) ? (getString(items[0], "text") ?? "") : "";
  };
  const installed = await runCauseEffect(
    service.eventChecks.templateInstall(request({ workspace: "alpha" }), TEST_USER),
  );
  // The check already runs the shipped version, so the update has nothing to do. The reason must show.
  const current = await call("update_event_check_template", { id: installed.id });
  expect(current).toContain("already uses the latest version");
  const unlinked = await call("update_event_check_template", { id: "00000000-0000-4000-8000-000000000000" });
  expect(unlinked.length).toBeGreaterThan(0);
});

it("keeps the template link when an agent saves the check again without it", async () => {
  const { service } = await boot(template("1.0.0", PROGRAM));
  const installed = await runCauseEffect(
    service.eventChecks.templateInstall(request({ workspace: "alpha" }), TEST_USER),
  );
  const { template: _link, ...source } = installed.source.kind === "api" ? installed.source : never();
  const saved = await runCauseEffect(
    service.eventChecks.save(
      { ...installed, name: "Renamed", source },
      { kind: "agent", agentId: "chief", name: "Chief" },
    ),
  );
  expect(saved.source.kind === "api" && saved.source.template?.slug).toBe("fixture");
  // A save that changes the program is a different check: it does not inherit the link.
  const other = await runCauseEffect(
    service.eventChecks.save(
      { ...saved, source: { ...source, toolName: "fixture.mjs" } },
      { kind: "agent", agentId: "chief", name: "Chief" },
    ),
  ).catch(() => null);
  expect(other?.source.kind === "api" ? other.source.template : undefined).toBeUndefined();
});

function never(): never {
  throw new Error("Expected an API check.");
}

// A program that lists choices when it is asked to. It never prints the token, and its failure text
// holds the token on purpose: the host must not pass that text on.
const DISCOVERING = `let raw=''; for await (const chunk of process.stdin) raw += chunk;
const config = JSON.parse(raw);
if (config.discover === true) {
  const token = process.env.FIXTURE_API_TOKEN ?? '';
  if (!token.startsWith('good-')) {
    process.stderr.write('Fixture failed with ' + token + ' SERVER-TEXT\\nopenbot-error: auth\\n');
    process.exit(1);
  }
  const options = [
    { id: 'C1AAA', label: '#general-' + config.workspace + '\\u0007', group: 'channel' },
    { id: 'D1AAA', label: '@pat', group: 'dm' },
    { id: 'C1AAA', label: 'again', group: 'channel' },
  ];
  // Counts the runs and records what was asked, in files that the test reads.
  const fs = await import('node:fs');
  if (config.workspace.startsWith('/')) fs.appendFileSync(config.workspace + '.log', JSON.stringify(config.ids ?? null) + '\\n');
  process.stdout.write(JSON.stringify({ options: Array.isArray(config.ids) ? options.filter((option) => config.ids.includes(option.id)) : options }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({items:[{id:config.workspace,revision:'1',actor:'someone'}],hasNextPage:false}));`;
function discovering(version = "1.0.0", program = DISCOVERING): EventCheckTemplate {
  const shipped = template(version, program);
  return {
    ...shipped,
    variables: [{ name: "FIXTURE_API_TOKEN", label: "API key", hint: "", docsUrl: null }],
    configuration: [
      ...shipped.configuration,
      {
        name: "rules",
        label: "Rules",
        description: "Pick them",
        value: "",
        required: false,
        type: "text",
        picker: {
          optionsFrom: "program",
          modes: [
            { value: "all", label: "All" },
            { value: "mentions", label: "Mentions" },
          ],
        },
      },
    ],
  };
}
const draft = (
  overrides: Partial<{
    variables: Record<string, string>;
    field: string;
    configuration: Record<string, string>;
    ids: string[];
  }> = {},
) => ({
  slug: "fixture",
  field: "rules",
  configuration: { workspace: "alpha" },
  variables: { FIXTURE_API_TOKEN: "good-draft-token" },
  ...overrides,
});
const AGENT = { kind: "agent", agentId: "chief", name: "Chief" } as const;
/** Every file under `directory`, read as text, whose content holds `needle`. */
function filesHolding(directory: string, needle: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    try {
      if (readFileSync(path).includes(needle)) found.push(path);
    } catch {
      // A file that cannot be read cannot hold the value for a reader either.
    }
  }
  return found;
}

it("rejects a picker value that is not ID:mode pairs at install, and accepts a valid one", async () => {
  const { service } = await boot(discovering(), DISCOVERING);
  const checks = service.eventChecks;
  await expect(
    runCauseEffect(checks.templateInstall(request({ workspace: "alpha", rules: "C1AAA:sometimes" }), TEST_USER)),
  ).rejects.toThrow(/Rules/);
  await expect(
    runCauseEffect(checks.templateInstall(request({ workspace: "alpha", rules: "C1AAA" }), TEST_USER)),
  ).rejects.toThrow();
  const installed = await runCauseEffect(
    checks.templateInstall(request({ workspace: "alpha", rules: "C1AAA:mentions,D1AAA:all" }), TEST_USER),
  );
  expect(
    installed.source.kind === "api" && installed.source.configuration.find((field) => field.name === "rules")?.value,
  ).toBe("C1AAA:mentions,D1AAA:all");
});

it("lists choices for a draft with typed private values, and keeps those values off disk and out of the audit", async () => {
  const audit = new SecurityAuditLog(join(root, "security-audit.jsonl"));
  const { service, programs } = await boot(discovering(), DISCOVERING, {}, audit);
  const typed = "good-draft-token-PRIVATE-9917";
  const result = await runCauseEffect(
    service.eventChecks.templateDiscover(draft({ variables: { FIXTURE_API_TOKEN: typed } }), TEST_USER),
  );
  // The settings that the form holds reach the program. The label is cleaned, and an ID comes once.
  expect(result).toEqual({
    options: [
      { id: "C1AAA", label: "#general-alpha", group: "channel" },
      { id: "D1AAA", label: "@pat", group: "dm" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain(typed);
  // Only the reviewed program was placed. No private file exists, and no file under the host's data holds the value.
  expect(existsSync(join(programs, "fixture@1.0.0.mjs"))).toBe(true);
  expect(existsSync(join(root, "private-watchers"))).toBe(false);
  expect(filesHolding(root, typed)).toEqual([]);
  // A read is not a change: nothing was audited, and there is no check to name.
  expect(audit.read(50)).toEqual([]);
});

it("refuses a draft with only fixed text: a bad token, a missing value, a name the template does not declare", async () => {
  const { service } = await boot(discovering(), DISCOVERING);
  const checks = service.eventChecks;
  const secret = "wrong-token-VALUE-THAT-MUST-NOT-LEAK";
  const failure = await runCauseEffect(
    checks.templateDiscover(draft({ variables: { FIXTURE_API_TOKEN: secret } }), TEST_USER),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  const message = failure instanceof Error ? failure.message : "";
  expect(message).toContain("did not accept the saved credentials");
  expect(message).not.toContain(secret);
  expect(message).not.toContain("SERVER-TEXT");
  const refusals = [
    draft({ variables: {} }),
    draft({ variables: { FIXTURE_API_TOKEN: "   " } }),
    draft({ variables: { FIXTURE_API_TOKEN: "good-x", OTHER_VALUE: "x" } }),
    draft({ configuration: { workspace: "alpha", surprise: "x" } }),
    draft({ field: "workspace" }),
    draft({ field: "nothing" }),
    { ...draft(), slug: "unknown" },
  ];
  for (const refused of refusals)
    await expect(runCauseEffect(checks.templateDiscover(refused, TEST_USER))).rejects.toThrow();
});

it("lists the choices of an installed check with its saved private value, and never for an agent", async () => {
  const { service, checks, programs } = await boot(discovering(), DISCOVERING);
  const installed = await runCauseEffect(
    service.eventChecks.templateInstall(request({ workspace: "beta" }), TEST_USER),
  );
  const target = { agentId: "chief", id: installed.id, field: "rules" };
  // No value is set yet: the host says so, and starts nothing it could leak to.
  await expect(runCauseEffect(service.eventChecks.discoverCheck(target, TEST_USER))).rejects.toThrow();
  await runCauseEffect(
    service.eventChecks.setEnvironment(
      { agentId: "chief", id: installed.id, name: "FIXTURE_API_TOKEN", value: "good-stored-token" },
      TEST_USER,
    ),
  );
  const result = await runCauseEffect(service.eventChecks.discoverCheck(target, TEST_USER));
  expect(result.options.map((option) => option.label)).toEqual(["#general-beta", "@pat"]);
  // An agent has no way to this call, and the method refuses it as well.
  await expect(runCauseEffect(service.eventChecks.discoverCheck(target, AGENT))).rejects.toThrow();
  await expect(runCauseEffect(service.eventChecks.templateDiscover(draft(), AGENT))).rejects.toThrow();
  expect(EVENT_CHECK_TOOL_DEFINITIONS.some((tool) => /discover|choices|picker/iu.test(tool.name))).toBe(false);
  // An edited copy of the program is not the reviewed one: it neither runs nor receives the value.
  await writeFile(join(programs, "fixture@1.0.0.mjs"), `${DISCOVERING}\n// edited`);
  await expect(runCauseEffect(service.eventChecks.discoverCheck(target, TEST_USER))).rejects.toThrow();
  expect(checks.get("chief", installed.id).active).toBe(false);
  // A field that is not a picker is refused as well.
  await expect(
    runCauseEffect(service.eventChecks.discoverCheck({ ...target, field: "workspace" }, TEST_USER)),
  ).rejects.toThrow();
});

it("refuses to list choices for a check that runs an earlier program, or has no template", async () => {
  const earlier = `${DISCOVERING}\n// version one`;
  const { service, programs } = await boot(
    {
      ...discovering("2.0.0"),
      earlierPrograms: [{ version: "1.0.0", file: "fixture-1.0.0.mjs", digest: digest(earlier) }],
    },
    DISCOVERING,
    { "fixture-1.0.0.mjs": earlier },
  );
  await writeFile(join(programs, "fixture@1.0.0.mjs"), earlier);
  const saved = await runCauseEffect(
    service.eventChecks.save(
      {
        agentId: "chief",
        name: "Old",
        instruction: "Mine",
        active: false,
        timezone: "UTC",
        schedule: { kind: "interval", amount: 120, unit: "seconds", anchorAt: new Date().toISOString() },
        selfEvents: { mode: "exclude", connectionId: "work", actorPointer: "/actor", accountActorIds: ["me"] },
        source: {
          kind: "api",
          connectionId: "work",
          variables: ["FIXTURE_API_TOKEN"],
          configuration: [{ name: "workspace", label: "Workspace", description: "", value: "alpha" }],
          toolName: "fixture@1.0.0.mjs",
          argumentsJson: "{}",
          cursorArgument: "cursor",
          nextCursorPointer: "/cursor",
          template: { slug: "fixture", version: "1.0.0" },
        },
        selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" },
      },
      TEST_USER,
    ),
  );
  const target = { agentId: "chief", id: saved.id, field: "rules" };
  await expect(runCauseEffect(service.eventChecks.discoverCheck(target, TEST_USER))).rejects.toThrow(
    /cannot list choices/,
  );
  const plain = await runCauseEffect(
    service.eventChecks.save(
      {
        ...saved,
        id: undefined,
        name: "Plain",
        source: saved.source.kind === "api" ? { ...saved.source, template: undefined } : saved.source,
      },
      TEST_USER,
    ),
  );
  await expect(
    runCauseEffect(service.eventChecks.discoverCheck({ ...target, id: plain.id }, TEST_USER)),
  ).rejects.toThrow();
});

/** The fixture with a picker and no private variable, so a check can run and hold a baseline. */
function labelled(): EventCheckTemplate {
  const shipped = discovering();
  return { ...shipped, variables: [] };
}
const rulesField = (check: EventCheck) =>
  check.source.kind === "api" ? check.source.configuration.find((field) => field.name === "rules") : undefined;

/** The check as a client sends it back: through the wire, with only the fields it edits changed. */
function resave(check: EventCheck, edit: (field: EventCheckConfiguration) => EventCheckConfiguration) {
  const input = decodeEventCheckInput(JSON.parse(JSON.stringify(check)));
  if (input.source.kind !== "api") throw new Error("Expected an API check.");
  const configuration = input.source.configuration.map((field) => (field.name === "rules" ? edit(field) : field));
  return { ...input, source: { ...input.source, configuration } };
}

it("keeps the names of picked choices with the check, without touching the baseline, and drops names of choices that left", async () => {
  const { service, checks } = await boot(labelled(), DISCOVERING);
  const installed = await runCauseEffect(
    service.eventChecks.templateInstall(
      {
        ...request({ workspace: "alpha", rules: "C1AAA:mentions,D1AAA:all" }),
        // A name for an ID that the value does not hold is dropped, and so is one for a plain setting.
        configurationLabels: { rules: { C1AAA: "#general", D1AAA: "@pat", Z9ZZZ: "#gone" }, workspace: { A1: "x" } },
      },
      TEST_USER,
    ),
  );
  expect(rulesField(installed)?.optionLabels).toEqual({ C1AAA: "#general", D1AAA: "@pat" });
  const active = await runCauseEffect(service.eventChecks.save({ ...installed, active: true }, TEST_USER));
  expect((await runCauseEffect(service.eventChecks.checkNow({ agentId: "chief", id: active.id }))).status).toBe(
    "baseline",
  );
  const before = checks.state(active.id);
  expect(before.baseline).not.toBeNull();
  // A rename is display text: the baseline stays.
  const renamed = await runCauseEffect(
    service.eventChecks.save(
      resave(active, (field) => ({ ...field, optionLabels: { C1AAA: "#general-renamed" } })),
      TEST_USER,
    ),
  );
  expect(rulesField(renamed)?.optionLabels).toEqual({ C1AAA: "#general-renamed", D1AAA: "@pat" });
  expect(checks.state(active.id)).toEqual(before);
  // A save that carries no names (an older client) keeps the saved ones.
  const stripped = await runCauseEffect(
    service.eventChecks.save(
      resave(renamed, ({ optionLabels: _names, ...rest }) => rest),
      TEST_USER,
    ),
  );
  expect(rulesField(stripped)?.optionLabels).toEqual({ C1AAA: "#general-renamed", D1AAA: "@pat" });
  expect(checks.state(active.id)).toEqual(before);
  // An agent cannot name choices, and its save does not remove the names.
  const byAgent = await runCauseEffect(
    service.eventChecks.save(
      resave(stripped, (field) => ({ ...field, optionLabels: { C1AAA: "#other-name" } })),
      AGENT,
    ),
  );
  expect(rulesField(byAgent)?.optionLabels).toEqual({ C1AAA: "#general-renamed", D1AAA: "@pat" });
  // A choice that leaves the value takes its name along. The value changed, so the baseline resets.
  const narrowed = await runCauseEffect(
    service.eventChecks.save(
      resave(byAgent, (field) => ({ ...field, value: "C1AAA:mentions" })),
      TEST_USER,
    ),
  );
  expect(rulesField(narrowed)?.optionLabels).toEqual({ C1AAA: "#general-renamed" });
  expect(checks.state(active.id).baseline).toBeNull();
});

it("asks the program for only the named IDs, for a draft and for an installed check", async () => {
  const { service } = await boot(discovering(), DISCOVERING);
  const asked = (log: string) => readFileSync(`${log}.log`, "utf8").trim().split("\n");
  const draftLog = join(root, "draft-run");
  const named = await runCauseEffect(
    service.eventChecks.templateDiscover(draft({ configuration: { workspace: draftLog }, ids: ["D1AAA"] }), TEST_USER),
  );
  expect(named.options.map((option) => option.id)).toEqual(["D1AAA"]);
  expect(asked(draftLog)).toEqual([JSON.stringify(["D1AAA"])]);
  const installLog = join(root, "installed-run");
  const installed = await runCauseEffect(
    service.eventChecks.templateInstall(request({ workspace: installLog }), TEST_USER),
  );
  await runCauseEffect(
    service.eventChecks.setEnvironment(
      { agentId: "chief", id: installed.id, name: "FIXTURE_API_TOKEN", value: "good-stored-token" },
      TEST_USER,
    ),
  );
  const target = { agentId: "chief", id: installed.id, field: "rules" };
  const some = await runCauseEffect(service.eventChecks.discoverCheck({ ...target, ids: ["C1AAA"] }, TEST_USER));
  expect(some.options.map((option) => option.id)).toEqual(["C1AAA"]);
  const all = await runCauseEffect(service.eventChecks.discoverCheck(target, TEST_USER));
  expect(all.options.map((option) => option.id)).toEqual(["C1AAA", "D1AAA"]);
  expect(asked(installLog)).toEqual([JSON.stringify(["C1AAA"]), "null"]);
});
