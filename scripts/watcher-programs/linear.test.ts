import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import { defaultWatcherCatalogPaths, loadWatcherCatalog } from "../build-watcher-catalog";

// Every response here is simulated. Nothing in this file talks to Linear.
const sourceRoot = defaultWatcherCatalogPaths().sourceRoot;
const directory = join(sourceRoot, "watchers", "linear-assigned-intake");
const TOKEN = "lin_api_test_token_do_not_leak";
const SERVER_TEXT = "internal-server-detail-xyz";
const ME = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const V1_DIGEST = "1a5615c5e9e212de528747963595af688276fcb760c49c85c6df6b6bb6b1082b";

interface Output {
  items: Array<{ id: string; revision: string; actor: string }>;
  hasNextPage: boolean;
  cursor: string | null;
}
interface Store {
  read(instanceId: string): Promise<number>;
  write(instanceId: string, timestamp: number): Promise<void>;
}
type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
interface Program {
  runWatcher(
    input: DynamicRecord,
    deps: { token?: string; fetchImpl: FetchImpl; store: Store; now: () => number },
  ): Promise<Output>;
}

function isOutput(value: unknown): value is Output {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        isDynamicRecord(item) &&
        typeof item.id === "string" &&
        typeof item.revision === "string" &&
        typeof item.actor === "string",
    ) &&
    typeof value.hasNextPage === "boolean" &&
    (value.cursor === null || typeof value.cursor === "string")
  );
}
async function load(): Promise<Program> {
  const loaded = await import(/* @vite-ignore */ pathToFileURL(join(directory, "program-1.1.0.mjs")).href);
  if (!isDynamicRecord(loaded) || typeof loaded.runWatcher !== "function") throw new Error("Missing runWatcher.");
  const runWatcher = loaded.runWatcher;
  return {
    runWatcher: async (input, deps) => {
      const output = await runWatcher(input, deps);
      if (!isOutput(output)) throw new Error("The program printed an unexpected output shape.");
      return output;
    },
  };
}

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const base = {
  instanceId: "test",
  workspaceId: "ws-1",
  workspaceSlug: "acme",
  assigneeId: ME,
  assigneeEmail: "me@example.com",
  teamId: "team-1",
  teamKey: "ENG",
};
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
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const identity = {
  organization: { id: "ws-1", urlKey: "acme" },
  viewer: { id: ME, email: "me@example.com" },
  team: { id: "team-1", key: "ENG" },
};
const noHistory = { nodes: [], pageInfo: { hasPreviousPage: false } };
interface IssueOptions {
  id?: string;
  title?: string;
  state?: string;
  labels?: string[];
  delegate?: string;
  comments?: Array<{ id: string; updatedAt: string }>;
}
function issue(options: IssueOptions = {}) {
  return {
    id: options.id ?? "issue-1",
    title: options.title ?? "Fix login",
    description: "Steps to reproduce",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-09T11:59:00.000Z",
    assignee: { id: ME },
    team: { id: "team-1" },
    ...(options.delegate ? { delegate: { id: options.delegate } } : {}),
    state: { id: "state-1", name: options.state ?? "Todo" },
    labels: {
      nodes: (options.labels ?? []).map((name) => ({ id: `label-${name}`, name })),
      pageInfo: { hasNextPage: false },
    },
    comments: {
      nodes: (options.comments ?? []).map((comment) => ({ ...comment, user: { id: AGENT } })),
      pageInfo: { hasPreviousPage: false },
    },
    history: noHistory,
  };
}
const issuePage = (nodes: unknown[], hasNextPage = false) => ({
  data: { ...identity, issues: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? "c1" : null } } },
});
const projectPage = (nodes: unknown[]) => ({
  data: { ...identity, projects: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
});
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
interface Sent {
  query: string;
  variables: { filter: DynamicRecord; first: number };
}
function recorder(handler: (sent: Sent, index: number) => Response) {
  const calls: Sent[] = [];
  const fetchImpl: FetchImpl = async (_url, init) => {
    const sent: Sent = JSON.parse(String(init.body));
    calls.push(sent);
    return handler(sent, calls.length - 1);
  };
  return { calls, fetchImpl };
}
async function run(settings: DynamicRecord, nodes: unknown[]) {
  const { calls, fetchImpl } = recorder(() => json(issuePage(nodes)));
  const program = await load();
  const output = await program.runWatcher(
    { ...base, includeProjects: "false", ...settings },
    { token: TOKEN, fetchImpl, store: memoryStore(), now: () => NOW },
  );
  return { output, calls };
}
async function failure(promise: Promise<unknown>): Promise<Error & { code?: string | null }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected the watcher to fail.");
}
function revisionOf(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

describe("linear-assigned-intake 1.1.0 catalog", () => {
  it("lists the new version and keeps the 1.0.0 program byte for byte so a live check can still be linked", async () => {
    const { templates, files } = await loadWatcherCatalog(sourceRoot);
    const linear = templates.find((template) => template.slug === "linear-assigned-intake");
    expect(linear?.version).toBe("1.1.0");
    expect(linear?.earlierPrograms).toEqual([
      { version: "1.0.0", file: "linear-assigned-intake-1.0.0.mjs", digest: V1_DIGEST },
    ]);
    const earlier = files.find((file) => file.path === "programs/linear-assigned-intake-1.0.0.mjs");
    expect(
      createHash("sha256")
        .update(earlier?.content ?? "")
        .digest("hex"),
    ).toBe(V1_DIGEST);
    expect(linear?.program.digest).not.toBe(V1_DIGEST);
  });

  it("holds no account constant in the new program", async () => {
    const text = await readFile(join(directory, "program-1.1.0.mjs"), "utf8");
    expect(text).not.toMatch(/Alejandro|BAZ/u);
  });
});

describe("linear-assigned-intake 1.1.0 revisions", () => {
  it("watches title and description only when no optional setting is set, as 1.0.0 did", async () => {
    const todo = await run({}, [issue({ state: "Todo", labels: ["bug"] })]);
    const done = await run({}, [issue({ state: "Done", labels: ["feature"] })]);
    expect(todo.output.items[0]?.revision).toBe(revisionOf(["Fix login", "Steps to reproduce"]));
    expect(done.output.items[0]?.revision).toBe(todo.output.items[0]?.revision);
    expect(todo.calls[0]?.query).not.toContain("state {");
    expect(todo.calls[0]?.query).not.toContain("comments(");
  });

  it("adds the state to the revision and the filter to the query with a state filter", async () => {
    const todo = await run({ stateFilter: "Todo, In Progress" }, [issue({ state: "Todo" })]);
    const progress = await run({ stateFilter: "Todo, In Progress" }, [issue({ state: "In Progress" })]);
    expect(todo.calls[0]?.variables.filter).toMatchObject({ state: { name: { in: ["Todo", "In Progress"] } } });
    expect(todo.output.items[0]?.revision).not.toBe(progress.output.items[0]?.revision);
  });

  it("rejects an issue that the API returns outside the state filter", async () => {
    const { calls, fetchImpl } = recorder(() => json(issuePage([issue({ state: "Done" })])));
    const program = await load();
    const error = await failure(
      program.runWatcher(
        { ...base, stateFilter: "Todo", includeProjects: "false" },
        { token: TOKEN, fetchImpl, store: memoryStore(), now: () => NOW },
      ),
    );
    expect(calls).toHaveLength(1);
    expect(error.message).toContain("state filter");
  });

  it("adds the sorted label names with a label filter", async () => {
    const one = await run({ labelFilter: "bug, agent" }, [issue({ labels: ["bug", "agent"] })]);
    const same = await run({ labelFilter: "bug, agent" }, [issue({ labels: ["agent", "bug"] })]);
    const changed = await run({ labelFilter: "bug, agent" }, [issue({ labels: ["bug"] })]);
    expect(one.calls[0]?.variables.filter).toMatchObject({ labels: { some: { name: { in: ["bug", "agent"] } } } });
    expect(one.output.items[0]?.revision).toBe(same.output.items[0]?.revision);
    expect(one.output.items[0]?.revision).not.toBe(changed.output.items[0]?.revision);
  });

  it("adds the update time of recent comments, and asks for smaller pages", async () => {
    const first = await run({ includeComments: "true", pageSize: "100" }, [
      issue({ comments: [{ id: "c1", updatedAt: "2026-10-09T10:00:00.000Z" }] }),
    ]);
    const edited = await run({ includeComments: "true" }, [
      issue({ comments: [{ id: "c1", updatedAt: "2026-10-09T11:00:00.000Z" }] }),
    ]);
    expect(first.calls[0]?.variables.first).toBe(25);
    expect(first.calls[0]?.query).toContain("comments(last: 25");
    expect(first.output.items[0]?.revision).not.toBe(edited.output.items[0]?.revision);
  });

  it("also watches issues delegated to the agent user, and reads the delegate", async () => {
    const { output, calls } = await run({ delegateId: AGENT }, [
      issue({ id: "issue-1" }),
      { ...issue({ id: "issue-2", delegate: AGENT }), assignee: { id: AGENT } },
    ]);
    expect(calls[0]?.variables.filter).toMatchObject({
      or: [{ assignee: { id: { eq: ME } } }, { delegate: { id: { eq: AGENT } } }],
    });
    expect(calls[0]?.query).toContain("delegate { id }");
    expect(output.items.map((item) => item.id)).toEqual(["i:issue-1", "i:issue-2"]);
  });

  it("rejects bad settings with the config code and no request", async () => {
    const { calls, fetchImpl } = recorder(() => json(issuePage([])));
    const program = await load();
    for (const settings of [{ includeComments: "yes" }, { stateFilter: "x".repeat(101) }, { pageSize: "0" }]) {
      const error = await failure(
        program.runWatcher({ ...base, ...settings }, { token: TOKEN, fetchImpl, store: memoryStore(), now: () => NOW }),
      );
      expect(error.code).toBe("config");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("linear-assigned-intake 1.1.0 paging", () => {
  it("reads issues, then the projects the user leads, unless projects are off", async () => {
    const program = await load();
    const { calls, fetchImpl } = recorder((sent) =>
      json(
        "lead" in sent.variables.filter
          ? projectPage([
              {
                id: "p1",
                createdAt: "2026-10-01T00:00:00.000Z",
                updatedAt: "2026-10-01T00:00:00.000Z",
                lead: { id: ME },
                history: noHistory,
              },
            ])
          : issuePage([issue()]),
      ),
    );
    const deps = { token: TOKEN, fetchImpl, store: memoryStore(), now: () => NOW };
    const first = await program.runWatcher(base, deps);
    expect(first.hasNextPage).toBe(true);
    const second = await program.runWatcher({ ...base, cursor: first.cursor }, deps);
    expect(second.items.map((item) => item.id)).toEqual(["p:p1"]);
    expect(second.hasNextPage).toBe(false);
    expect(calls).toHaveLength(2);
    const noProjects = await run({}, [issue()]);
    expect(noProjects.output.hasNextPage).toBe(false);
  });
});

describe("linear-assigned-intake 1.1.0 failures", () => {
  it("reports a rejected key as auth, without server text", async () => {
    const program = await load();
    for (const response of [
      () => json({ errors: [{ message: SERVER_TEXT, extensions: { code: "AUTHENTICATION_ERROR" } }] }, 400),
      () => new Response(SERVER_TEXT, { status: 401 }),
    ]) {
      const { fetchImpl } = recorder(response);
      const error = await failure(
        program.runWatcher(base, { token: TOKEN, fetchImpl, store: memoryStore(), now: () => NOW }),
      );
      expect(error.code).toBe("auth");
      expect(error.message).not.toContain(SERVER_TEXT);
      expect(error.message).not.toContain(TOKEN);
    }
  });

  it("saves a cooldown on a rate limit and sends nothing while it lasts", async () => {
    const program = await load();
    const store = memoryStore();
    const limited = recorder(() => json({}, 429, { "retry-after": "120" }));
    const error = await failure(
      program.runWatcher(base, { token: TOKEN, fetchImpl: limited.fetchImpl, store, now: () => NOW }),
    );
    expect(error.code).toBe("rate_limited");
    expect(store.value).toBe(NOW + 120_000);
    const next = recorder(() => json(issuePage([])));
    const blocked = await failure(
      program.runWatcher(base, { token: TOKEN, fetchImpl: next.fetchImpl, store, now: () => NOW + 1000 }),
    );
    expect(blocked.code).toBe("rate_limited");
    expect(next.calls).toHaveLength(0);
  });

  it("treats the GraphQL RATELIMITED code as a rate limit", async () => {
    const program = await load();
    const store = memoryStore();
    const { fetchImpl } = recorder(() => json({ errors: [{ extensions: { code: "RATELIMITED" } }] }, 200));
    const error = await failure(program.runWatcher(base, { token: TOKEN, fetchImpl, store, now: () => NOW }));
    expect(error.code).toBe("rate_limited");
    expect(store.value).toBeGreaterThan(NOW);
  });

  it("stops the next run early when almost no requests are left", async () => {
    const program = await load();
    const store = memoryStore();
    const { fetchImpl } = recorder(() =>
      json(issuePage([]), 200, {
        "x-ratelimit-requests-remaining": "2",
        "x-ratelimit-requests-reset": String(NOW + 30_000),
      }),
    );
    await program.runWatcher({ ...base, includeProjects: "false" }, { token: TOKEN, fetchImpl, store, now: () => NOW });
    expect(store.value).toBe(NOW + 30_000);
  });

  it("reports an identity mismatch as config with neutral text", async () => {
    const program = await load();
    const { fetchImpl } = recorder(() =>
      json({ data: { ...issuePage([]).data, viewer: { id: AGENT, email: "x@example.com" } } }),
    );
    const error = await failure(
      program.runWatcher(base, { token: TOKEN, fetchImpl, store: memoryStore(), now: () => NOW }),
    );
    expect(error.code).toBe("config");
    expect(error.message).toBe("API token must belong to the configured user.");
  });

  it("reports a network failure and a server error as upstream", async () => {
    const program = await load();
    const down: FetchImpl = async () => {
      throw new Error(SERVER_TEXT);
    };
    const first = await failure(
      program.runWatcher(base, { token: TOKEN, fetchImpl: down, store: memoryStore(), now: () => NOW }),
    );
    expect(first.code).toBe("upstream");
    expect(first.message).not.toContain(SERVER_TEXT);
    const { fetchImpl } = recorder(() => json({}, 503));
    const second = await failure(
      program.runWatcher(base, { token: TOKEN, fetchImpl, store: memoryStore(), now: () => NOW }),
    );
    expect(second.code).toBe("upstream");
  });

  it("reports a missing key as auth", async () => {
    const program = await load();
    const { fetchImpl } = recorder(() => json(issuePage([])));
    const error = await failure(
      program.runWatcher(base, { token: "", fetchImpl, store: memoryStore(), now: () => NOW }),
    );
    expect(error.code).toBe("auth");
  });
});

describe("linear-assigned-intake 1.1.0 as a process", () => {
  it("prints the message line, then one allow-listed code line, and exits 1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-linear-"));
    temporaryRoots.push(dir);
    const program = join(dir, "program.mjs");
    await cp(join(directory, "program-1.1.0.mjs"), program);
    const stub = join(dir, "stub-fetch.mjs");
    await writeFile(stub, `globalThis.fetch = async () => new Response(process.env.STUB_BODY, { status: 401 });\n`);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, program], {
      cwd: dir,
      input: JSON.stringify(base),
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? "", LANG: "C", LINEAR_API_TOKEN: TOKEN, STUB_BODY: SERVER_TEXT },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Assigned Linear watcher: Linear rejected the API key (HTTP 401).\nopenbot-error: auth\n",
    );
    expect(result.stderr).not.toContain(SERVER_TEXT);
  });
});
