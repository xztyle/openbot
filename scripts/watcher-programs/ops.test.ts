import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import { defaultWatcherCatalogPaths, loadWatcherCatalog } from "../build-watcher-catalog";

const sourceRoot = defaultWatcherCatalogPaths().sourceRoot;
const API_KEY = "rnd_test_key_do_not_leak_12345";
const SERVER_TEXT = "internal-server-detail-xyz";

interface WatcherItem {
  id: string;
  revision: string;
  actor: string;
  [field: string]: unknown;
}
interface WatcherOutput {
  items: WatcherItem[];
  hasNextPage: boolean;
  cursor: string | null;
}
interface Store {
  read(instanceId: string): Promise<number>;
  write(instanceId: string, timestamp: number): Promise<void>;
}
type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
interface Dependencies {
  token?: string;
  fetchImpl: FetchImpl;
  store: Store;
  now: () => number;
}
interface Program {
  runWatcher(input: DynamicRecord, deps: Dependencies): Promise<WatcherOutput>;
}

function isItem(value: unknown): value is WatcherItem {
  return (
    isDynamicRecord(value) &&
    typeof value.id === "string" &&
    typeof value.revision === "string" &&
    typeof value.actor === "string"
  );
}
function isOutput(value: unknown): value is WatcherOutput {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isItem) &&
    typeof value.hasNextPage === "boolean" &&
    (value.cursor === null || typeof value.cursor === "string")
  );
}
function parseOutput(value: unknown): WatcherOutput {
  if (!isOutput(value)) throw new Error("The program printed an unexpected output shape.");
  return value;
}
function first<T>(list: readonly T[]): T {
  const [head] = list;
  if (head === undefined) throw new Error("Expected a first entry.");
  return head;
}

async function loadProgram(slug: string): Promise<Program> {
  const file = join(sourceRoot, "watchers", slug, "program.mjs");
  const loaded = await import(/* @vite-ignore */ pathToFileURL(file).href);
  if (!isDynamicRecord(loaded) || typeof loaded.runWatcher !== "function")
    throw new Error("Missing runWatcher export.");
  const run = loaded.runWatcher;
  return { runWatcher: async (input, deps) => parseOutput(await run(input, deps)) };
}

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-ops-programs-"));
  temporaryRoots.push(root);
  return root;
}

function memoryStore(initial = 0): Store & { value: number } {
  const store = {
    value: initial,
    async read() {
      return store.value;
    },
    async write(_instanceId: string, timestamp: number) {
      store.value = timestamp;
    },
  };
  return store;
}

interface RecordedCall {
  url: URL;
  init: RequestInit;
}
function recorder(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    return handler(parsed, init);
  };
  return { calls, fetchImpl };
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the watcher to fail.");
}
function revisions(output: WatcherOutput): Record<string, string> {
  return Object.fromEntries(output.items.map((item) => [item.id, item.revision]));
}

// ---------------------------------------------------------------- Render

interface FakeService {
  id: string;
  name: string;
  suspended?: string;
  deploys: Array<{ id: string; status: string; message?: string }>;
}
interface FakeRender {
  services: FakeService[];
  postgres: Array<{ id: string; name: string; status: string; suspended: string }>;
  keyValue: Array<{ id: string; name: string; status: string }>;
}
function renderState(): FakeRender {
  return {
    services: [
      {
        id: "srv-web",
        name: "web",
        deploys: [{ id: "dep-1", status: "live", message: "Fix login\nlong body line" }],
      },
      { id: "srv-api", name: "api", deploys: [{ id: "dep-7", status: "live" }] },
    ],
    postgres: [{ id: "dpg-main", name: "main-db", status: "available", suspended: "not_suspended" }],
    keyValue: [{ id: "red-cache", name: "cache", status: "available" }],
  };
}
function listPage<T>(entries: T[], url: URL, wrap: (entry: T, index: number) => DynamicRecord): unknown[] {
  const limit = Number(url.searchParams.get("limit") ?? "20");
  const cursor = url.searchParams.get("cursor");
  const start = cursor === null ? 0 : Number(cursor.replace("cur-", "")) + 1;
  return entries.slice(start, start + limit).map((entry, offset) => ({
    cursor: `cur-${start + offset}`,
    ...wrap(entry, start + offset),
  }));
}
function renderServer(state: FakeRender) {
  return recorder((url) => {
    const path = url.pathname;
    if (path === "/v1/services") {
      return json(
        listPage(state.services, url, (service) => ({
          service: {
            id: service.id,
            name: service.name,
            type: "web_service",
            suspended: service.suspended ?? "not_suspended",
            branch: "main",
            dashboardUrl: `https://dashboard.render.com/web/${service.id}`,
          },
        })),
      );
    }
    const deploys = /^\/v1\/services\/([^/]+)\/deploys$/.exec(path);
    if (deploys) {
      const service = state.services.find((entry) => entry.id === deploys[1]);
      const limit = Number(url.searchParams.get("limit"));
      return json(
        (service?.deploys ?? []).slice(0, limit).map((deploy) => ({
          cursor: deploy.id,
          deploy: {
            id: deploy.id,
            status: deploy.status,
            commit: { message: deploy.message ?? "msg" },
            finishedAt: "2026-10-09T10:00:00Z",
          },
        })),
      );
    }
    if (path === "/v1/postgres") {
      return json(listPage(state.postgres, url, (postgres) => ({ postgres })));
    }
    if (path === "/v1/key-value") {
      return json(listPage(state.keyValue, url, (keyValue) => ({ keyValue })));
    }
    return json({ message: SERVER_TEXT }, 404);
  });
}
const renderConfig = {
  instanceId: "render-test",
  maxServices: "50",
  watchDatabases: "true",
  notifyOnDeploying: "false",
};

async function runRender(
  state: FakeRender,
  config: DynamicRecord = {},
  options: { store?: Store; now?: () => number } = {},
) {
  const program = await loadProgram("render-services");
  const server = renderServer(state);
  const output = await program.runWatcher(
    { ...renderConfig, ...config },
    {
      token: API_KEY,
      fetchImpl: server.fetchImpl,
      store: options.store ?? memoryStore(),
      now: options.now ?? (() => 1_000_000),
    },
  );
  return { output, calls: server.calls };
}

describe("render-services program", () => {
  it("returns one item per service and database with compact revisions", async () => {
    const { output, calls } = await runRender(renderState());
    expect(output.hasNextPage).toBe(false);
    expect(output.cursor).toBeNull();
    expect(revisions(output)).toEqual({
      "svc:srv-web": "not_suspended:live:dep-1",
      "svc:srv-api": "not_suspended:live:dep-7",
      "db:dpg-main": "available:not_suspended",
      "db:red-cache": "available:unknown",
    });
    const web = output.items[0];
    expect(web).toMatchObject({
      actor: "unknown",
      name: "web",
      type: "web_service",
      commitMessage: "Fix login",
      branch: "main",
      finishedAt: "2026-10-09T10:00:00Z",
      dashboardUrl: "https://dashboard.render.com/web/srv-web",
    });
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });
    expect(calls.every((call) => call.url.origin === "https://api.render.com")).toBe(true);
    expect(calls.every((call) => call.init.redirect === "error")).toBe(true);
  });

  it("sends only GET requests", async () => {
    const { calls } = await runRender(renderState());
    expect(calls.length).toBeGreaterThan(4);
    expect(calls.every((call) => call.init.method === "GET" && call.init.body === undefined)).toBe(true);
  });

  it("changes a revision once when a deploy finishes, and not while it builds", async () => {
    const state = renderState();
    const before = revisions((await runRender(state)).output);
    const web = first(state.services);
    web.deploys.unshift({ id: "dep-2", status: "build_in_progress" });
    const building = revisions((await runRender(state)).output);
    expect(building).toEqual(before);
    web.deploys[0] = { id: "dep-2", status: "live" };
    const live = revisions((await runRender(state)).output);
    expect(live["svc:srv-web"]).toBe("not_suspended:live:dep-2");
    expect(live["svc:srv-api"]).toBe(before["svc:srv-api"]);
    expect(revisions((await runRender(state)).output)).toEqual(live);
  });

  it("changes a revision for a failed deploy and for a suspended service", async () => {
    const state = renderState();
    const web = first(state.services);
    web.deploys.unshift({ id: "dep-3", status: "build_failed" });
    expect(revisions((await runRender(state)).output)["svc:srv-web"]).toBe("not_suspended:build_failed:dep-3");
    web.suspended = "suspended";
    expect(revisions((await runRender(state)).output)["svc:srv-web"]).toBe("suspended:build_failed:dep-3");
  });

  it("wakes for a running deploy only when notifyOnDeploying is true, and not twice", async () => {
    const state = renderState();
    const web = first(state.services);
    web.deploys.unshift({ id: "dep-2", status: "build_in_progress" });
    const started = await runRender(state, { notifyOnDeploying: "true" });
    expect(revisions(started.output)["svc:srv-web"]).toBe("not_suspended:deploying:dep-2");
    web.deploys[0] = { id: "dep-2", status: "update_in_progress" };
    const second = await runRender(state, { notifyOnDeploying: "true" });
    expect(revisions(second.output)).toEqual(revisions(started.output));
    const deployCalls = started.calls.filter((call) => call.url.pathname.endsWith("/deploys"));
    expect(deployCalls.every((call) => call.url.searchParams.get("limit") === "1")).toBe(true);
  });

  it("changes a database revision when its status changes", async () => {
    const state = renderState();
    const before = revisions((await runRender(state)).output);
    first(state.postgres).status = "unavailable";
    const after = revisions((await runRender(state)).output);
    expect(after["db:dpg-main"]).toBe("unavailable:not_suspended");
    expect(after["svc:srv-web"]).toBe(before["svc:srv-web"]);
  });

  it("skips databases when watchDatabases is false", async () => {
    const { output, calls } = await runRender(renderState(), { watchDatabases: "false" });
    expect(output.items.map((item) => item.id)).toEqual(["svc:srv-web", "svc:srv-api"]);
    expect(calls.some((call) => call.url.pathname === "/v1/postgres")).toBe(false);
  });

  it("reads every page and filters by name and workspace", async () => {
    const state = renderState();
    state.services = Array.from({ length: 150 }, (_, index) => ({
      id: `srv-${index}`,
      name: `service-${index}`,
      deploys: [{ id: `dep-${index}`, status: "live" }],
    }));
    const { output, calls } = await runRender(state, {
      serviceNames: "Service-3, service-140",
      ownerId: "tea-abc",
      watchDatabases: "false",
    });
    expect(output.items.map((item) => item.id)).toEqual(["svc:srv-3", "svc:srv-140"]);
    const pages = calls.filter((call) => call.url.pathname === "/v1/services");
    expect(pages).toHaveLength(2);
    expect(pages[1]?.url.searchParams.get("cursor")).toBe("cur-99");
    expect(pages.every((call) => call.url.searchParams.get("ownerId") === "tea-abc")).toBe(true);
  });

  it("fails loudly when pagination does not advance", async () => {
    const program = await loadProgram("render-services");
    const stuck = recorder(() =>
      json(Array.from({ length: 100 }, () => ({ cursor: "same", service: { id: "srv-a", name: "a" } }))),
    );
    const message = await failure(
      program.runWatcher(
        { ...renderConfig, watchDatabases: "false" },
        { token: API_KEY, fetchImpl: stuck.fetchImpl, store: memoryStore(), now: () => 1 },
      ),
    );
    expect(message).toContain("pagination did not advance");
  });

  it("fails loudly instead of checking only some services when there are more than maxServices", async () => {
    const state = renderState();
    const program = await loadProgram("render-services");
    const server = renderServer(state);
    const message = await failure(
      program.runWatcher(
        { ...renderConfig, maxServices: "1" },
        { token: API_KEY, fetchImpl: server.fetchImpl, store: memoryStore(), now: () => 1 },
      ),
    );
    expect(message).toContain("more than maxServices (1)");
    expect(server.calls.some((call) => call.url.pathname.endsWith("/deploys"))).toBe(false);
  });

  it("fails when a configured service name matches nothing", async () => {
    const program = await loadProgram("render-services");
    const server = renderServer(renderState());
    const message = await failure(
      program.runWatcher(
        { ...renderConfig, serviceNames: "web,typo" },
        { token: API_KEY, fetchImpl: server.fetchImpl, store: memoryStore(), now: () => 1 },
      ),
    );
    expect(message).toBe("A name in serviceNames matches no service.");
  });

  it("gives a safe message for a bad key without the key or server text", async () => {
    const program = await loadProgram("render-services");
    const denied = recorder(() => json({ message: SERVER_TEXT }, 403));
    const message = await failure(
      program.runWatcher(renderConfig, {
        token: API_KEY,
        fetchImpl: denied.fetchImpl,
        store: memoryStore(),
        now: () => 1,
      }),
    );
    expect(message).toContain("HTTP 403");
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(SERVER_TEXT);
  });

  it("hides network error text, including the key, and an error from the middle of the run", async () => {
    const program = await loadProgram("render-services");
    const state = renderState();
    const server = renderServer(state);
    const broken: FetchImpl = async (url, init) => {
      if (new URL(url).pathname.endsWith("/deploys")) throw new Error(`socket closed ${API_KEY} ${SERVER_TEXT}`);
      return server.fetchImpl(url, init);
    };
    const message = await failure(
      program.runWatcher(renderConfig, { token: API_KEY, fetchImpl: broken, store: memoryStore(), now: () => 1 }),
    );
    expect(message).toBe("Render API request failed or timed out.");
  });

  it("saves a cooldown on HTTP 429 and sends nothing while it lasts", async () => {
    const program = await loadProgram("render-services");
    const store = memoryStore();
    let clock = 1_000_000;
    const limited = recorder(() => new Response(SERVER_TEXT, { status: 429, headers: { "retry-after": "120" } }));
    const first = await failure(
      program.runWatcher(renderConfig, { token: API_KEY, fetchImpl: limited.fetchImpl, store, now: () => clock }),
    );
    expect(first).toContain("rate limit");
    expect(first).not.toContain(SERVER_TEXT);
    expect(store.value).toBe(1_000_000 + 120_000);
    const during = await failure(
      program.runWatcher(renderConfig, {
        token: API_KEY,
        fetchImpl: limited.fetchImpl,
        store,
        now: () => clock + 60_000,
      }),
    );
    expect(during).toContain("cooldown is active");
    expect(limited.calls).toHaveLength(1);
    clock += 121_000;
    const server = renderServer(renderState());
    const output = await program.runWatcher(renderConfig, {
      token: API_KEY,
      fetchImpl: server.fetchImpl,
      store,
      now: () => clock,
    });
    expect(output.items.length).toBeGreaterThan(0);
  });

  it("rejects bad input before any request", async () => {
    const program = await loadProgram("render-services");
    const server = renderServer(renderState());
    const deps = { token: API_KEY, fetchImpl: server.fetchImpl, store: memoryStore(), now: () => 1 };
    expect(await failure(program.runWatcher({ ...renderConfig, instanceId: "" }, deps))).toContain("instanceId");
    expect(await failure(program.runWatcher({ ...renderConfig, maxServices: "101" }, deps))).toContain("maxServices");
    expect(await failure(program.runWatcher({ ...renderConfig, watchDatabases: "yes" }, deps))).toContain(
      "watchDatabases",
    );
    expect(await failure(program.runWatcher({ ...renderConfig, ownerId: "tea abc" }, deps))).toContain("ownerId");
    expect(await failure(program.runWatcher({ ...renderConfig, cursor: "abc" }, deps))).toContain("cursor");
    expect(await failure(program.runWatcher(renderConfig, { ...deps, token: "" }))).toContain("RENDER_API_KEY");
    expect(server.calls).toHaveLength(0);
  });
});

// --------------------------------------------------------------- PostHog

interface Counts {
  volume: number;
  pageviews: number;
  users: number;
  exceptions: number;
  errors?: number;
}
interface Windows {
  current: Counts;
  previous: Counts;
  week: Counts;
}
function healthy(): Windows {
  const counts = { volume: 1000, pageviews: 400, users: 80, exceptions: 2 };
  return { current: { ...counts }, previous: { ...counts }, week: { ...counts } };
}
function posthogServer(windows: Windows, withErrors = false) {
  return recorder(() => {
    const row = (name: keyof Windows) => {
      const counts = windows[name];
      const values = [counts.volume, counts.pageviews, counts.users, counts.exceptions];
      return [name, ...values, ...(withErrors ? [counts.errors ?? 0] : [])];
    };
    return json({ results: [row("current"), row("previous"), row("week")] });
  });
}
const posthogConfig = { instanceId: "posthog-test", projectId: "123" };

async function runPosthog(
  windows: Windows,
  config: DynamicRecord = {},
  options: { store?: Store; now?: () => number } = {},
) {
  const program = await loadProgram("posthog-health");
  const server = posthogServer(windows, typeof config.errorEventNames === "string" && config.errorEventNames !== "");
  const output = await program.runWatcher(
    { ...posthogConfig, ...config },
    {
      token: API_KEY,
      fetchImpl: server.fetchImpl,
      store: options.store ?? memoryStore(),
      now: options.now ?? (() => 1_000_000),
    },
  );
  return { output, calls: server.calls };
}

describe("posthog-health program", () => {
  it("reports ok for every metric when nothing moved", async () => {
    const { output } = await runPosthog(healthy());
    expect(output.hasNextPage).toBe(false);
    expect(revisions(output)).toEqual({
      "metric:volume": "ok",
      "metric:pageviews": "ok",
      "metric:users": "ok",
      "metric:exceptions": "ok",
    });
    expect(output.items.every((item) => item.actor === "unknown")).toBe(true);
    expect(output.items[1]).toMatchObject({
      current: 400,
      previousWindow: 400,
      sameWindowLastWeek: 400,
      changeVsLastWeekPercent: 0,
      windowMinutes: 60,
    });
  });

  it("sends exactly one read-only HogQL query to the project query endpoint", async () => {
    const { calls } = await runPosthog(healthy());
    expect(calls).toHaveLength(1);
    const call = first(calls);
    expect(call.url.href).toBe("https://us.posthog.com/api/projects/123/query/");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    expect(call.init.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });
    const body: { query: { kind: string; query: string } } = JSON.parse(String(call.init.body));
    expect(body.query.kind).toBe("HogQLQuery");
    expect(body.query.query).toMatch(/^SELECT /);
    expect(body.query.query).toMatch(/ LIMIT \d+$/);
    expect(body.query.query).not.toMatch(/;|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i);
  });

  it("uses the configured host and window, and adds custom error events", async () => {
    const { output, calls } = await runPosthog(healthy(), {
      host: "https://eu.posthog.com/",
      windowMinutes: "30",
      errorEventNames: "payment_failed, checkout error",
    });
    expect(calls[0]?.url.origin).toBe("https://eu.posthog.com");
    const sent: { query: { query: string } } = JSON.parse(String(first(calls).init.body));
    const query = sent.query.query;
    expect(query).toContain("toIntervalMinute(30)");
    expect(query).toContain("toIntervalMinute(60)");
    expect(query).toContain("event IN ('payment_failed', 'checkout error')");
    expect(output.items.map((item) => item.id)).toContain("metric:errors");
  });

  it("changes only the affected revisions, and once, when pageviews fall by more than half", async () => {
    const windows = healthy();
    const before = revisions((await runPosthog(windows)).output);
    windows.current = { ...windows.current, pageviews: 100 };
    const dropped = revisions((await runPosthog(windows)).output);
    expect(dropped["metric:pageviews"]).toBe("low");
    expect({ ...dropped, "metric:pageviews": "ok" }).toEqual(before);
    expect(revisions((await runPosthog(windows)).output)).toEqual(dropped);
    windows.current = { ...windows.current, pageviews: 400 };
    expect(revisions((await runPosthog(windows)).output)).toEqual(before);
  });

  it("does not change status for noise inside the thresholds", async () => {
    const windows = healthy();
    windows.current = { volume: 1300, pageviews: 250, users: 55, exceptions: 5 };
    expect(revisions((await runPosthog(windows)).output)).toEqual(revisions((await runPosthog(healthy())).output));
  });

  it("marks a volume spike as high, and an error spike only when it is big enough", async () => {
    const windows = healthy();
    windows.current = { ...windows.current, volume: 4000, exceptions: 60 };
    const spike = revisions((await runPosthog(windows)).output);
    expect(spike["metric:volume"]).toBe("high");
    expect(spike["metric:exceptions"]).toBe("high");
    windows.current = { ...windows.current, exceptions: 8 };
    expect(revisions((await runPosthog(windows)).output)["metric:exceptions"]).toBe("ok");
  });

  it("never marks a drop in errors, or a rise in pageviews, as a problem", async () => {
    const windows = healthy();
    windows.week.exceptions = 100;
    windows.current = { ...windows.current, exceptions: 0, pageviews: 5000 };
    const result = revisions((await runPosthog(windows)).output);
    expect(result["metric:exceptions"]).toBe("ok");
    expect(result["metric:pageviews"]).toBe("ok");
  });

  it("reports unknown without enough baseline, and falls back to the previous window", async () => {
    const quiet = healthy();
    quiet.week = { volume: 10, pageviews: 5, users: 2, exceptions: 0 };
    quiet.previous = { volume: 10, pageviews: 5, users: 2, exceptions: 0 };
    expect(revisions((await runPosthog(quiet)).output)).toMatchObject({
      "metric:volume": "unknown",
      "metric:pageviews": "unknown",
      "metric:users": "unknown",
      "metric:exceptions": "ok",
    });
    const fallback = healthy();
    fallback.week = { volume: 0, pageviews: 0, users: 0, exceptions: 0 };
    fallback.current = { ...fallback.current, volume: 100 };
    const result = (await runPosthog(fallback)).output;
    expect(revisions(result)["metric:volume"]).toBe("low");
    expect(result.items[0]?.changeVsLastWeekPercent).toBeNull();
  });

  it("treats a missing window as zero events", async () => {
    const program = await loadProgram("posthog-health");
    const only = recorder(() => json({ results: [["week", 1000, 400, 80, 2]] }));
    const output = await program.runWatcher(posthogConfig, {
      token: API_KEY,
      fetchImpl: only.fetchImpl,
      store: memoryStore(),
      now: () => 1,
    });
    expect(revisions(output)["metric:volume"]).toBe("low");
  });

  it("fails on a malformed result", async () => {
    const program = await loadProgram("posthog-health");
    for (const body of [
      { results: [["nope", 1, 1, 1, 1]] },
      { results: [["current", -1, 1, 1, 1]] },
      { results: "x" },
      [],
    ]) {
      const bad = recorder(() => json(body));
      const message = await failure(
        program.runWatcher(posthogConfig, {
          token: API_KEY,
          fetchImpl: bad.fetchImpl,
          store: memoryStore(),
          now: () => 1,
        }),
      );
      expect(message).toBe("Unexpected PostHog query result.");
    }
  });

  it("gives a safe message for a bad key without the key or server text", async () => {
    const program = await loadProgram("posthog-health");
    const denied = recorder(() => json({ detail: SERVER_TEXT }, 403));
    const message = await failure(
      program.runWatcher(posthogConfig, {
        token: API_KEY,
        fetchImpl: denied.fetchImpl,
        store: memoryStore(),
        now: () => 1,
      }),
    );
    expect(message).toContain("HTTP 403");
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(SERVER_TEXT);
    const broken: FetchImpl = async () => {
      throw new Error(`reset ${API_KEY} ${SERVER_TEXT}`);
    };
    expect(
      await failure(
        program.runWatcher(posthogConfig, { token: API_KEY, fetchImpl: broken, store: memoryStore(), now: () => 1 }),
      ),
    ).toBe("PostHog API request failed or timed out.");
  });

  it("saves a cooldown on HTTP 429 and sends nothing while it lasts", async () => {
    const program = await loadProgram("posthog-health");
    const store = memoryStore();
    let clock = 5_000_000;
    const limited = recorder(() => new Response(SERVER_TEXT, { status: 429, headers: { "retry-after": "300" } }));
    const first = await failure(
      program.runWatcher(posthogConfig, { token: API_KEY, fetchImpl: limited.fetchImpl, store, now: () => clock }),
    );
    expect(first).toContain("rate limit");
    expect(first).not.toContain(SERVER_TEXT);
    expect(store.value).toBe(5_000_000 + 300_000);
    expect(
      await failure(
        program.runWatcher(posthogConfig, {
          token: API_KEY,
          fetchImpl: limited.fetchImpl,
          store,
          now: () => clock + 1000,
        }),
      ),
    ).toContain("cooldown is active");
    expect(limited.calls).toHaveLength(1);
    clock += 301_000;
    const ok = posthogServer(healthy());
    const output = await program.runWatcher(posthogConfig, {
      token: API_KEY,
      fetchImpl: ok.fetchImpl,
      store,
      now: () => clock,
    });
    expect(output.items).toHaveLength(4);
  });

  it("rejects bad input before any request", async () => {
    const program = await loadProgram("posthog-health");
    const server = posthogServer(healthy());
    const deps = { token: API_KEY, fetchImpl: server.fetchImpl, store: memoryStore(), now: () => 1 };
    const bad: Array<[DynamicRecord, string]> = [
      [{ ...posthogConfig, projectId: "" }, "projectId"],
      [{ ...posthogConfig, projectId: "12/../3" }, "projectId"],
      [{ ...posthogConfig, host: "http://us.posthog.com" }, "host"],
      [{ ...posthogConfig, host: "https://user:pw@us.posthog.com" }, "host"],
      [{ ...posthogConfig, host: "https://us.posthog.com/path" }, "host"],
      [{ ...posthogConfig, windowMinutes: "1" }, "windowMinutes"],
      [{ ...posthogConfig, dropPercent: "100" }, "dropPercent"],
      [{ ...posthogConfig, errorEventNames: "a'; DROP TABLE events" }, "errorEventNames"],
      [{ ...posthogConfig, cursor: "abc" }, "cursor"],
    ];
    for (const [input, name] of bad) expect(await failure(program.runWatcher(input, deps))).toContain(name);
    expect(await failure(program.runWatcher(posthogConfig, { ...deps, token: "  " }))).toContain(
      "POSTHOG_PERSONAL_API_KEY",
    );
    expect(server.calls).toHaveLength(0);
  });
});

// ------------------------------------------------- spawn contract (real node)

const slugs = ["render-services", "posthog-health"] as const;
const validInputs: Record<(typeof slugs)[number], Record<string, string>> = {
  "render-services": { ...renderConfig, watchDatabases: "false" },
  "posthog-health": { ...posthogConfig },
};
const keyNames: Record<(typeof slugs)[number], string> = {
  "render-services": "RENDER_API_KEY",
  "posthog-health": "POSTHOG_PERSONAL_API_KEY",
};
const emptyBodies: Record<(typeof slugs)[number], DynamicRecord | never[]> = {
  "render-services": [],
  "posthog-health": { results: [] },
};

async function installProgram(slug: (typeof slugs)[number]) {
  const dir = await scratch();
  const program = join(dir, "program.mjs");
  await cp(join(sourceRoot, "watchers", slug, "program.mjs"), program);
  const stub = join(dir, "stub-fetch.mjs");
  await writeFile(
    stub,
    `globalThis.fetch = async () => new Response(process.env.STUB_BODY, {
      status: Number(process.env.STUB_STATUS),
      headers: { "retry-after": "90" },
    });\n`,
  );
  const run = (input: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, program], {
      cwd: dir,
      input,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? "", LANG: "C", ...extra },
    });
  return { dir, run };
}

describe.each(slugs)("%s as a spawned program", (slug) => {
  const key = keyNames[slug];

  it("prints one JSON value and exits zero", async () => {
    const { run } = await installProgram(slug);
    const result = run(JSON.stringify(validInputs[slug]), {
      [key]: API_KEY,
      STUB_STATUS: "200",
      STUB_BODY: JSON.stringify(emptyBodies[slug]),
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const output = parseOutput(JSON.parse(result.stdout));
    expect(output.hasNextPage).toBe(false);
    expect(Array.isArray(output.items)).toBe(true);
  });

  it("exits 1 with a safe stderr message for bad input", async () => {
    const { run } = await installProgram(slug);
    const environment = { [key]: API_KEY, STUB_STATUS: "200", STUB_BODY: "[]" };
    const notJson = run("not json", environment);
    expect(notJson.status).toBe(1);
    expect(notJson.stdout).toBe("");
    expect(notJson.stderr).toContain("Invalid watcher input JSON.");
    const noKey = run(JSON.stringify(validInputs[slug]), { STUB_STATUS: "200", STUB_BODY: "[]" });
    expect(noKey.status).toBe(1);
    expect(noKey.stdout).toBe("");
    expect(noKey.stderr).toContain(`Missing ${key}`);
    const missing = run(JSON.stringify({}), environment);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("instanceId");
  });

  it("keeps its cooldown in a file next to the program and honors it on the next run", async () => {
    const { dir, run } = await installProgram(slug);
    const limited = run(JSON.stringify(validInputs[slug]), {
      [key]: API_KEY,
      STUB_STATUS: "429",
      STUB_BODY: SERVER_TEXT,
    });
    expect(limited.status).toBe(1);
    expect(limited.stderr).toContain("rate limit");
    expect(limited.stderr).not.toContain(SERVER_TEXT);
    const folders = (await readdir(dir)).filter((name) => name.endsWith("-cooldowns"));
    expect(folders).toHaveLength(1);
    const files = await readdir(join(dir, first(folders)));
    expect(files).toHaveLength(1);
    expect((await stat(join(dir, first(folders), first(files)))).isFile()).toBe(true);
    const next = run(JSON.stringify(validInputs[slug]), {
      [key]: API_KEY,
      STUB_STATUS: "200",
      STUB_BODY: JSON.stringify(emptyBodies[slug]),
    });
    expect(next.status).toBe(1);
    expect(next.stderr).toContain("cooldown is active");
    expect(next.stdout).toBe("");
  });
});

// ------------------------------------------------------- catalog install proof

describe("ops watcher templates", () => {
  it("resolve through the same install proof as the real build", async () => {
    const root = await scratch();
    await mkdir(join(root, "watchers"), { recursive: true });
    await writeFile(
      join(root, "catalog.json"),
      JSON.stringify({ schemaVersion: 1, catalogVersion: "v1", order: [...slugs] }),
    );
    for (const slug of slugs)
      await cp(join(sourceRoot, "watchers", slug), join(root, "watchers", slug), { recursive: true });
    const { templates, files } = await loadWatcherCatalog(root);
    expect(templates.map((template) => template.slug)).toEqual([...slugs]);
    expect(files.map((file) => file.path).sort()).toEqual([
      "catalog.json",
      "programs/posthog-health.mjs",
      "programs/render-services.mjs",
    ]);
    for (const template of templates) {
      expect(template.selection).toEqual({ itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" });
      expect(template.actorPointer).toBe("/actor");
      expect(template.intervalSeconds).toBeGreaterThanOrEqual(120);
      expect(template.variables).toHaveLength(1);
      expect(template.instruction).toMatch(/untrusted/);
      expect(template.instruction).toMatch(/Do not (deploy|change)/);
      const listing = await readFile(
        join(sourceRoot, "..", "plugin-catalog", "plugins", String(template.app), "plugin.json"),
        "utf8",
      );
      expect(JSON.parse(listing)).toMatchObject({ slug: template.app });
    }
    expect(templates[0]?.intervalSeconds).toBe(120);
    expect(templates[1]?.intervalSeconds).toBe(300);
  });

  it("keeps configuration defaults inside the program's own limits", async () => {
    const posthog = await loadProgram("posthog-health");
    const render = await loadProgram("render-services");
    for (const [slug, program, extra] of [
      ["render-services", render, { instanceId: "x" }],
      ["posthog-health", posthog, { instanceId: "x", projectId: "1" }],
    ] as const) {
      const source: { configuration: Array<{ name: string; value: string }> } = JSON.parse(
        await readFile(join(sourceRoot, "watchers", slug, "watcher.json"), "utf8"),
      );
      const defaults = Object.fromEntries(source.configuration.map((field) => [field.name, field.value]));
      const deps = {
        token: API_KEY,
        fetchImpl:
          slug === "render-services" ? renderServer(renderState()).fetchImpl : posthogServer(healthy()).fetchImpl,
        store: memoryStore(),
        now: () => 1,
      };
      await expect(program.runWatcher({ ...defaults, ...extra }, deps)).resolves.toMatchObject({ hasNextPage: false });
    }
  });
});
