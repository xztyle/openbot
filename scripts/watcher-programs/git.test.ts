import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadWatcherCatalog } from "../build-watcher-catalog";

// Mock-only tests. Nothing here talks to GitHub or to a Git server. The one real `git` test uses a
// bare repository in a temporary folder.

const catalogSource = resolve(import.meta.dirname, "..", "..", "marketplace", "watcher-catalog");
const githubDirectory = join(catalogSource, "watchers", "github-activity");
const gitDirectory = join(catalogSource, "watchers", "git-remote-refs");

const TOKEN = "test-access-value-0123456789";
const SERVER_TEXT = "server-secret-text-should-never-appear";
const NOW = Date.parse("2026-10-09T12:00:00Z");
const SINCE = "2026-10-09T11:55:00Z";
const RECENT = "2026-10-09T11:58:00Z";
const OLD = "2026-10-09T09:00:00Z";

type Json = object;
interface Item {
  id: string;
  revision: string;
  actor: string;
  kind?: string;
}
interface Output {
  items: Item[];
  hasNextPage: boolean;
  cursor: string | null;
}
interface CooldownStore {
  read(instanceId: string): Promise<number>;
  write(instanceId: string, timestamp: number): Promise<void>;
}
interface GithubModule {
  runWatcher(
    input: Json,
    deps: {
      token?: string;
      fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
      store: CooldownStore;
      now: () => number;
    },
  ): Promise<Output>;
}
interface GitRunResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
  tooLarge: boolean;
  failedToStart: boolean;
}
interface GitRunOptions {
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
}
interface GitModule {
  globMatches(pattern: string, text: string): boolean;
  runCommand(command: string, args: string[], options: GitRunOptions): Promise<GitRunResult>;
  runWatcher(
    input: Json,
    deps: {
      token?: string;
      run?: (command: string, args: string[], options: GitRunOptions) => Promise<GitRunResult>;
      baseEnv?: Record<string, string>;
      testOnlyAllowFileUrl?: boolean;
    },
  ): Promise<Output>;
}

async function load<T>(directory: string): Promise<T> {
  const module: T = await import(pathToFileURL(join(directory, "program.mjs")).href);
  return module;
}

const temporaryRoots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "watcher-programs-"));
  temporaryRoots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error("Expected the program to fail.");
}

interface ProgramRun {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Starts the program the way the host does: `node program.mjs`, JSON on stdin, trimmed environment. */
function runProgram(directory: string, stdin: string, env: Record<string, string>): Promise<ProgramRun> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(directory, "program.mjs")], {
      env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

// ---------------------------------------------------------------------------------------------
// github-activity
// ---------------------------------------------------------------------------------------------

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
}
type Router = (url: URL) => Reply | undefined;

function fakeFetch(router: Router, onRequest?: () => void) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers)),
      redirect: init.redirect,
    });
    onRequest?.();
    const reply = router(url);
    if (!reply) throw new Error(`Unexpected request ${url.pathname}`);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
  };
  return { calls, fetchImpl };
}

function memoryStore(initial = 0) {
  const writes: number[] = [];
  const state = { value: initial, writes };
  const store: CooldownStore = {
    read: async () => state.value,
    write: async (_instanceId, timestamp) => {
      state.value = timestamp;
      state.writes.push(timestamp);
    },
  };
  return { state, store };
}

const NEXT = { link: '<https://api.github.com/next>; rel="next", <https://api.github.com/last>; rel="last"' };
const sha = (seed: string) => createHash("sha1").update(seed).digest("hex");

/** Answers /user and the repository call, then whatever the test routes. */
function githubRouter(extra: Router, repo = "acme/api"): Router {
  return (url) => {
    if (url.pathname === "/user") return { body: { login: "octocat" } };
    if (url.pathname === `/repos/${repo}`) return { body: { full_name: repo, default_branch: "main" } };
    return extra(url);
  };
}

function githubInput(overrides: Json = {}) {
  return {
    instanceId: "work",
    login: "octocat",
    apiBaseUrl: "https://api.github.com",
    watchNotifications: "false",
    participatingOnly: "false",
    repos: "acme/api",
    branches: "",
    watchPullRequests: "false",
    watchIssues: "false",
    watchCommits: "false",
    watchFailedRuns: "false",
    watchReleases: "false",
    watchSecurityAlerts: "false",
    maxRequests: "60",
    since: SINCE,
    until: "2026-10-09T12:00:00Z",
    ...overrides,
  };
}

function pullRow(number: number, overrides: Json = {}) {
  return {
    number,
    state: "open",
    title: `Pull request ${number}`,
    user: { login: "alice" },
    head: { sha: sha(`pr${number}`) },
    merged_at: null,
    draft: false,
    created_at: OLD,
    updated_at: RECENT,
    html_url: `https://github.com/acme/api/pull/${number}`,
    ...overrides,
  };
}
function issueRow(number: number, overrides: Json = {}) {
  return {
    number,
    state: "open",
    title: `Issue ${number}`,
    user: { login: "bob" },
    comments: 2,
    created_at: OLD,
    updated_at: RECENT,
    html_url: `https://github.com/acme/api/issues/${number}`,
    ...overrides,
  };
}

describe("github-activity", () => {
  it("reports each kind of recent activity with stable ids, revisions and honest actors", async () => {
    const program = await load<GithubModule>(githubDirectory);
    const commit = sha("commit-one");
    const { calls, fetchImpl } = fakeFetch(
      githubRouter((url) => {
        if (url.pathname === "/notifications")
          return {
            body: [
              {
                id: "42",
                unread: true,
                reason: "review_requested",
                updated_at: RECENT,
                subject: {
                  title: "Fix\nthe   bug",
                  type: "PullRequest",
                  url: "https://api.github.com/repos/acme/api/pulls/7",
                },
                repository: { full_name: "acme/api" },
              },
            ],
          };
        if (url.pathname === "/repos/acme/api/pulls")
          return {
            body: [
              pullRow(7, { created_at: RECENT, updated_at: RECENT }), // opened in the window and not touched since
              pullRow(8, { state: "closed", merged_at: RECENT }), // updated: the author is not the change author
            ],
          };
        if (url.pathname === "/repos/acme/api/issues")
          return {
            body: [
              issueRow(3),
              issueRow(4, { pull_request: { url: "x" } }), // pull requests are not issues here
              issueRow(5, { created_at: RECENT, updated_at: RECENT }),
            ],
          };
        if (url.pathname === "/repos/acme/api/commits")
          return {
            body: [
              {
                sha: commit,
                author: { login: "carol" },
                commit: { message: "Add thing\n\nLong body", author: { name: "Carol", date: RECENT } },
                html_url: `https://github.com/acme/api/commit/${commit}`,
              },
              {
                sha: sha("commit-two"),
                author: null,
                commit: { message: "Anonymous", author: { name: "X", date: RECENT } },
              },
            ],
          };
        if (url.pathname === "/repos/acme/api/actions/runs")
          return {
            body: {
              total_count: 1,
              workflow_runs: [
                {
                  id: 900,
                  run_attempt: 2,
                  conclusion: "failure",
                  name: "CI",
                  display_title: "Fix things",
                  head_branch: "main",
                  event: "push",
                  run_number: 55,
                  head_sha: commit,
                  actor: { login: "octocat" },
                  html_url: "https://github.com/acme/api/actions/runs/900",
                },
              ],
            },
          };
        if (url.pathname === "/repos/acme/api/releases")
          return {
            body: [
              {
                id: 11,
                tag_name: "v1.2.0",
                name: "One two",
                published_at: RECENT,
                created_at: RECENT,
                author: { login: "dave" },
                draft: false,
              },
              { id: 12, tag_name: "v1.3.0-draft", draft: true, created_at: RECENT, published_at: null },
              { id: 10, tag_name: "v1.1.0", published_at: OLD, created_at: OLD, author: { login: "dave" } },
            ],
          };
        if (url.pathname === "/repos/acme/api/dependabot/alerts")
          return {
            body: [
              {
                number: 9,
                state: "open",
                updated_at: RECENT,
                dependency: { package: { name: "left-pad", ecosystem: "npm" } },
                security_advisory: { severity: "high", summary: "Bad things" },
                html_url: "https://github.com/acme/api/security/dependabot/9",
              },
            ],
          };
        return undefined;
      }),
    );
    const output = await program.runWatcher(
      githubInput({
        watchNotifications: "true",
        watchPullRequests: "true",
        watchIssues: "true",
        watchCommits: "true",
        watchFailedRuns: "true",
        watchReleases: "true",
        watchSecurityAlerts: "true",
      }),
      { token: TOKEN, fetchImpl, store: memoryStore().store, now: () => NOW },
    );

    expect(output.hasNextPage).toBe(false);
    expect(output.cursor).toBeNull();
    const byId = Object.fromEntries(output.items.map((item) => [item.id, item]));
    expect(Object.keys(byId)).toEqual([
      "n:42",
      "pr:acme/api#7",
      "pr:acme/api#8",
      "issue:acme/api#3",
      "issue:acme/api#5",
      `c:acme/api@${commit}`,
      `c:acme/api@${sha("commit-two")}`,
      "run:acme/api:900",
      "rel:acme/api:11",
      "alert:acme/api:9",
    ]);
    expect(byId["n:42"]).toMatchObject({
      revision: RECENT,
      actor: "unknown",
      kind: "review_requested",
      type: "PullRequest",
      title: "Fix the bug",
      repository: "acme/api",
    });
    expect(byId["pr:acme/api#7"]).toMatchObject({ actor: "alice", state: "open", kind: "pull_request" });
    expect(byId["pr:acme/api#8"]).toMatchObject({ actor: "unknown", state: "merged" });
    expect(byId["pr:acme/api#8"]?.revision).toBe(`${sha("pr8")}:merged:${RECENT}`);
    expect(byId["issue:acme/api#3"]).toMatchObject({ actor: "unknown", revision: `open:${RECENT}` });
    expect(byId["issue:acme/api#5"]).toMatchObject({ actor: "bob" });
    expect(byId[`c:acme/api@${commit}`]).toMatchObject({
      revision: commit,
      actor: "carol",
      message: "Add thing",
      branches: ["main"],
    });
    expect(byId[`c:acme/api@${sha("commit-two")}`]?.actor).toBe("unknown");
    // The person who started a failed run did not make a change; the failure must still reach the owner.
    expect(byId["run:acme/api:900"]).toMatchObject({ actor: "unknown", revision: "failure:2", triggeredBy: "octocat" });
    expect(byId["rel:acme/api:11"]).toMatchObject({ actor: "dave", tag: "v1.2.0" });
    expect(byId["alert:acme/api:9"]).toMatchObject({ actor: "unknown", severity: "high", package: "left-pad" });

    // Read-only, authenticated, versioned, never following a redirect.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.redirect).toBe("error");
      expect(call.url.origin).toBe("https://api.github.com");
      expect(call.headers["x-github-api-version"]).toBe("2022-11-28");
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
    const query = (path: string) => calls.find((call) => call.url.pathname === path)?.url.searchParams;
    expect(query("/notifications")?.get("all")).toBe("false");
    expect(query("/notifications")?.get("participating")).toBe("false");
    expect(query("/notifications")?.get("since")).toBe(SINCE);
    expect(query("/repos/acme/api/commits")?.get("sha")).toBe("main");
    expect(query("/repos/acme/api/commits")?.get("since")).toBe(SINCE);
    expect(query("/repos/acme/api/actions/runs")?.get("status")).toBe("failure");
    expect(query("/repos/acme/api/actions/runs")?.get("created")?.startsWith(">=")).toBe(true);
    expect(query("/repos/acme/api/dependabot/alerts")?.get("state")).toBe("open");
    // The output holds no token.
    expect(JSON.stringify(output)).not.toContain(TOKEN);
  });

  it("uses the configured branches, merges a commit seen on two branches, and honors participatingOnly", async () => {
    const program = await load<GithubModule>(githubDirectory);
    const shared = sha("shared");
    const { calls, fetchImpl } = fakeFetch(
      githubRouter((url) => {
        if (url.pathname === "/notifications") return { body: [] };
        if (url.pathname === "/repos/acme/api/commits")
          return {
            body: [
              {
                sha: shared,
                author: { login: "carol" },
                commit: { message: "m", author: { name: "C", date: RECENT } },
              },
            ],
          };
        return undefined;
      }),
    );
    const output = await program.runWatcher(
      githubInput({
        watchNotifications: "true",
        participatingOnly: "true",
        watchCommits: "true",
        branches: "main, dev",
      }),
      { token: TOKEN, fetchImpl, store: memoryStore().store, now: () => NOW },
    );
    expect(output.items).toHaveLength(1);
    expect(output.items[0]).toMatchObject({ id: `c:acme/api@${shared}`, branches: ["main", "dev"] });
    const commitCalls = calls.filter((call) => call.url.pathname === "/repos/acme/api/commits");
    expect(commitCalls.map((call) => call.url.searchParams.get("sha"))).toEqual(["main", "dev"]);
    expect(calls.find((call) => call.url.pathname === "/notifications")?.url.searchParams.get("participating")).toBe(
      "true",
    );
    // The default branch call is not needed when branches are listed, but the repository is still proved readable.
    expect(calls.some((call) => call.url.pathname === "/repos/acme/api")).toBe(true);
  });

  it("follows the Link header across pages and stops a newest-first list at the window", async () => {
    const program = await load<GithubModule>(githubDirectory);
    const pages: number[] = [];
    const { fetchImpl } = fakeFetch(
      githubRouter((url) => {
        if (url.pathname !== "/repos/acme/api/pulls") return undefined;
        const page = Number(url.searchParams.get("page"));
        pages.push(page);
        expect(url.searchParams.get("per_page")).toBe("100");
        if (page === 1) return { body: Array.from({ length: 100 }, (_, index) => pullRow(index + 1)), headers: NEXT };
        // The last row is older than the window, so page three is never requested.
        return { body: [pullRow(101), pullRow(102), pullRow(103, { updated_at: OLD })], headers: NEXT };
      }),
    );
    const output = await program.runWatcher(githubInput({ watchPullRequests: "true" }), {
      token: TOKEN,
      fetchImpl,
      store: memoryStore().store,
      now: () => NOW,
    });
    expect(pages).toEqual([1, 2]);
    expect(output.items).toHaveLength(102);
    expect(output.items.some((item) => item.id === "pr:acme/api#103")).toBe(false);
  });

  it("fails instead of cutting a list that is longer than the page cap", async () => {
    const program = await load<GithubModule>(githubDirectory);
    const { calls, fetchImpl } = fakeFetch(
      githubRouter((url) =>
        url.pathname === "/repos/acme/api/issues"
          ? { body: Array.from({ length: 100 }, (_, index) => issueRow(index + 1)), headers: NEXT }
          : undefined,
      ),
    );
    const message = await failure(
      program.runWatcher(githubInput({ watchIssues: "true" }), {
        token: TOKEN,
        fetchImpl,
        store: memoryStore().store,
        now: () => NOW,
      }),
    );
    expect(message).toContain("more than 500 issues");
    expect(calls.filter((call) => call.url.pathname === "/repos/acme/api/issues")).toHaveLength(5);
  });

  it("fails when the combined result is too large", async () => {
    const program = await load<GithubModule>(githubDirectory);
    const longTitle = "x".repeat(400);
    const { fetchImpl } = fakeFetch(
      githubRouter((url) => {
        const page = Number(url.searchParams.get("page"));
        const rows = (offset: number) =>
          Array.from({ length: 100 }, (_, index) => issueRow(offset + index + 1, { title: longTitle }));
        if (url.pathname === "/repos/acme/api/issues")
          return { body: rows(page * 1000), headers: page < 5 ? NEXT : undefined };
        if (url.pathname === "/repos/acme/api/pulls")
          return {
            body: Array.from({ length: 100 }, (_, index) => pullRow(page * 1000 + index + 1, { title: longTitle })),
            headers: page < 5 ? NEXT : undefined,
          };
        if (url.pathname === "/notifications")
          return {
            body: Array.from({ length: 100 }, (_, index) => ({
              id: String(page * 1000 + index),
              updated_at: RECENT,
              reason: "mention",
              subject: {
                title: longTitle,
                type: "Issue",
                url: `https://api.github.com/repos/acme/api/issues/${index}`,
              },
              repository: { full_name: "acme/api" },
            })),
            headers: page < 5 ? NEXT : undefined,
          };
        return undefined;
      }),
    );
    const message = await failure(
      program.runWatcher(githubInput({ watchNotifications: "true", watchIssues: "true", watchPullRequests: "true" }), {
        token: TOKEN,
        fetchImpl,
        store: memoryStore().store,
        now: () => NOW,
      }),
    );
    expect(message).toContain("safe size limit");
  });

  it("refuses a token that belongs to another account, before reading anything else", async () => {
    const program = await load<GithubModule>(githubDirectory);
    const { calls, fetchImpl } = fakeFetch((url) =>
      url.pathname === "/user" ? { body: { login: "someone-else" } } : { body: [] },
    );
    const message = await failure(
      program.runWatcher(githubInput({ watchNotifications: "true" }), {
        token: TOKEN,
        fetchImpl,
        store: memoryStore().store,
        now: () => NOW,
      }),
    );
    expect(message).toContain("does not belong to the configured login");
    expect(message).not.toContain("someone-else");
    expect(calls.map((call) => call.url.pathname)).toEqual(["/user"]);
  });

  it("matches the login without regard to case", async () => {
    const program = await load<GithubModule>(githubDirectory);
    const { fetchImpl } = fakeFetch(githubRouter(() => ({ body: [] })));
    const output = await program.runWatcher(githubInput({ login: "OctoCat", watchNotifications: "true", repos: "" }), {
      token: TOKEN,
      fetchImpl,
      store: memoryStore().store,
      now: () => NOW,
    });
    expect(output.items).toEqual([]);
  });

  describe("rate limits", () => {
    it("saves a cooldown on HTTP 429 and sends nothing while it is active", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { state, store } = memoryStore();
      const limited = fakeFetch((url) =>
        url.pathname === "/user" ? { status: 429, headers: { "retry-after": "120" } } : undefined,
      );
      const message = await failure(
        program.runWatcher(githubInput({ watchNotifications: "true" }), {
          token: TOKEN,
          fetchImpl: limited.fetchImpl,
          store,
          now: () => NOW,
        }),
      );
      expect(message).toContain("rate limit");
      expect(state.writes).toEqual([NOW + 120_000]);

      const quiet = fakeFetch(() => ({ body: {} }));
      const second = await failure(
        program.runWatcher(githubInput({ watchNotifications: "true" }), {
          token: TOKEN,
          fetchImpl: quiet.fetchImpl,
          store,
          now: () => NOW + 60_000,
        }),
      );
      expect(second).toContain("cooldown is active");
      expect(quiet.calls).toHaveLength(0);
    });

    it("sends requests again once the cooldown has passed", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { fetchImpl, calls } = fakeFetch(githubRouter(() => ({ body: [] })));
      await program.runWatcher(githubInput({ watchNotifications: "true", repos: "" }), {
        token: TOKEN,
        fetchImpl,
        store: memoryStore(NOW - 1).store,
        now: () => NOW,
      });
      expect(calls.length).toBeGreaterThan(0);
    });

    it("treats a 403 with no requests left as the primary limit and waits for the reset", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { state, store } = memoryStore();
      const reset = Math.floor((NOW + 600_000) / 1000);
      const { fetchImpl } = fakeFetch(
        githubRouter(() => ({
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        })),
      );
      const message = await failure(
        program.runWatcher(githubInput({ watchNotifications: "true" }), {
          token: TOKEN,
          fetchImpl,
          store,
          now: () => NOW,
        }),
      );
      expect(message).toContain("rate limit");
      expect(state.writes).toEqual([reset * 1000]);
    });

    it("limits a cooldown that a server sets too far ahead", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { state, store } = memoryStore();
      const { fetchImpl } = fakeFetch(() => ({ status: 403, headers: { "retry-after": "999999" } }));
      await failure(
        program.runWatcher(githubInput({ watchNotifications: "true" }), {
          token: TOKEN,
          fetchImpl,
          store,
          now: () => NOW,
        }),
      );
      expect(state.writes).toEqual([NOW + 3_600_000]);
    });

    it("stops before a request that GitHub says would exceed the limit", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { state, store } = memoryStore();
      const reset = Math.floor((NOW + 300_000) / 1000);
      const { calls, fetchImpl } = fakeFetch((url) =>
        url.pathname === "/user"
          ? {
              body: { login: "octocat" },
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            }
          : { body: [] },
      );
      const message = await failure(
        program.runWatcher(githubInput({ watchNotifications: "true" }), {
          token: TOKEN,
          fetchImpl,
          store,
          now: () => NOW,
        }),
      );
      expect(message).toContain("rate limit");
      expect(calls.map((call) => call.url.pathname)).toEqual(["/user"]);
      expect(state.writes).toEqual([reset * 1000]);
    });

    it("does not call a plain permission error a rate limit", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { state, store } = memoryStore();
      const { fetchImpl } = fakeFetch(githubRouter(() => ({ status: 403, body: { message: SERVER_TEXT } })));
      const message = await failure(
        program.runWatcher(githubInput({ watchNotifications: "true" }), {
          token: TOKEN,
          fetchImpl,
          store,
          now: () => NOW,
        }),
      );
      expect(message).toContain("Cannot read notifications");
      expect(state.writes).toEqual([]);
    });
  });

  describe("repositories that cannot be read", () => {
    it("fails and names the repository, without server text", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { fetchImpl } = fakeFetch((url) =>
        url.pathname === "/user" ? { body: { login: "octocat" } } : { status: 404, body: { message: SERVER_TEXT } },
      );
      const message = await failure(
        program.runWatcher(githubInput({ repos: "acme/api,acme/web", watchIssues: "true" }), {
          token: TOKEN,
          fetchImpl,
          store: memoryStore().store,
          now: () => NOW,
        }),
      );
      expect(message).toContain("acme/api");
      expect(message).not.toContain(SERVER_TEXT);
    });

    it("fails for the second repository too, so no partial result is returned", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { fetchImpl } = fakeFetch((url) => {
        if (url.pathname === "/user") return { body: { login: "octocat" } };
        if (url.pathname === "/repos/acme/api") return { body: { full_name: "acme/api", default_branch: "main" } };
        if (url.pathname === "/repos/acme/api/issues") return { body: [] };
        return { status: 404 };
      });
      const message = await failure(
        program.runWatcher(githubInput({ repos: "acme/api,acme/private", watchIssues: "true" }), {
          token: TOKEN,
          fetchImpl,
          store: memoryStore().store,
          now: () => NOW,
        }),
      );
      expect(message).toContain("acme/private");
    });

    it("fails and names the repository when Dependabot alerts are not allowed", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { fetchImpl } = fakeFetch(
        githubRouter((url) =>
          url.pathname.endsWith("/dependabot/alerts") ? { status: 403, body: { message: SERVER_TEXT } } : undefined,
        ),
      );
      const message = await failure(
        program.runWatcher(githubInput({ watchSecurityAlerts: "true" }), {
          token: TOKEN,
          fetchImpl,
          store: memoryStore().store,
          now: () => NOW,
        }),
      );
      expect(message).toContain("Dependabot alerts of acme/api");
      expect(message).not.toContain(SERVER_TEXT);
    });

    it("accepts an empty repository for commits", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { fetchImpl } = fakeFetch(
        githubRouter((url) => (url.pathname.endsWith("/commits") ? { status: 409 } : undefined)),
      );
      const output = await program.runWatcher(githubInput({ watchCommits: "true" }), {
        token: TOKEN,
        fetchImpl,
        store: memoryStore().store,
        now: () => NOW,
      });
      expect(output.items).toEqual([]);
    });

    it("fails when GitHub answers for a different repository than the one asked for", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { fetchImpl } = fakeFetch((url) =>
        url.pathname === "/user"
          ? { body: { login: "octocat" } }
          : { body: { full_name: "other/thing", default_branch: "main" } },
      );
      const message = await failure(
        program.runWatcher(githubInput({ watchIssues: "true" }), {
          token: TOKEN,
          fetchImpl,
          store: memoryStore().store,
          now: () => NOW,
        }),
      );
      expect(message).toContain("different repository");
    });
  });

  describe("safe errors", () => {
    it("never repeats a thrown error, a server body or the token", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const cases: Array<Router | "throw" | "badJson"> = [
        "throw",
        "badJson",
        () => ({ status: 500, body: { message: `${SERVER_TEXT} ${TOKEN}` } }),
        () => ({ status: 401, body: { message: `${SERVER_TEXT} ${TOKEN}` } }),
      ];
      for (const router of cases) {
        const fetchImpl =
          router === "throw"
            ? async () => {
                throw new Error(`connect failed ${SERVER_TEXT} ${TOKEN}`);
              }
            : router === "badJson"
              ? async () => new Response(`not json ${SERVER_TEXT} ${TOKEN}`)
              : fakeFetch(router).fetchImpl;
        const message = await failure(
          program.runWatcher(githubInput({ watchNotifications: "true" }), {
            token: TOKEN,
            fetchImpl,
            store: memoryStore().store,
            now: () => NOW,
          }),
        );
        expect(message).not.toContain(SERVER_TEXT);
        expect(message).not.toContain(TOKEN);
        expect(message.length).toBeLessThan(200);
      }
    });

    it("fails when the check runs out of time", async () => {
      const program = await load<GithubModule>(githubDirectory);
      let clock = NOW;
      const { fetchImpl } = fakeFetch(
        githubRouter(() => ({ body: [] })),
        () => {
          clock += 20_000;
        },
      );
      const message = await failure(
        program.runWatcher(githubInput({ watchPullRequests: "true", watchIssues: "true" }), {
          token: TOKEN,
          fetchImpl,
          store: memoryStore().store,
          now: () => clock,
        }),
      );
      expect(message).toContain("ran out of time");
    });

    it("stops at the request limit instead of reading part of the data", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { calls, fetchImpl } = fakeFetch(githubRouter(() => ({ body: [] })));
      const message = await failure(
        program.runWatcher(
          githubInput({
            maxRequests: "5",
            watchPullRequests: "true",
            watchIssues: "true",
            watchCommits: "true",
            watchFailedRuns: "true",
          }),
          { token: TOKEN, fetchImpl, store: memoryStore().store, now: () => NOW },
        ),
      );
      expect(message).toContain("maxRequests");
      expect(calls).toHaveLength(5);
    });
  });

  describe("input", () => {
    const rejected: Array<[string, Json, string | undefined]> = [
      ["a missing token", {}, ""],
      ["a missing login", { login: "" }, undefined],
      ["a login with a slash", { login: "a/b" }, undefined],
      ["a missing instance name", { instanceId: "" }, undefined],
      ["an http API address", { apiBaseUrl: "http://api.github.com" }, undefined],
      ["an API address with credentials", { apiBaseUrl: "https://user:pass@api.github.com" }, undefined],
      ["an API address with a query", { apiBaseUrl: "https://api.github.com/?x=1" }, undefined],
      ["a repository without an owner", { repos: "api" }, undefined],
      ["a repository path escape", { repos: "acme/.." }, undefined],
      [
        "more than ten repositories",
        { repos: Array.from({ length: 11 }, (_, index) => `a/r${index}`).join(",") },
        undefined,
      ],
      ["a bad branch name", { branches: "a..b" }, undefined],
      ["a bad switch", { watchIssues: "yes" }, undefined],
      ["a request limit that is too small", { maxRequests: "2" }, undefined],
      ["nothing to watch", { watchNotifications: "false", repos: "" }, undefined],
      ["repositories with every repository watch off", { watchNotifications: "false" }, undefined],
    ];
    for (const [name, overrides, token] of rejected) {
      it(`rejects ${name} before sending a request`, async () => {
        const program = await load<GithubModule>(githubDirectory);
        const { calls, fetchImpl } = fakeFetch(githubRouter(() => ({ body: [] })));
        await failure(
          program.runWatcher(githubInput({ watchNotifications: "true", ...overrides }), {
            token: token ?? TOKEN,
            fetchImpl,
            store: memoryStore().store,
            now: () => NOW,
          }),
        );
        expect(calls).toHaveLength(0);
      });
    }

    it("reads a GitHub Enterprise Server address and keeps its path", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { calls, fetchImpl } = fakeFetch((url) =>
        url.pathname === "/api/v3/user" ? { body: { login: "octocat" } } : { body: [] },
      );
      await program.runWatcher(
        githubInput({ apiBaseUrl: "https://ghe.example.com/api/v3/", watchNotifications: "true", repos: "" }),
        {
          token: TOKEN,
          fetchImpl,
          store: memoryStore().store,
          now: () => NOW,
        },
      );
      expect(calls.map((call) => call.url.href.split("?")[0])).toEqual([
        "https://ghe.example.com/api/v3/user",
        "https://ghe.example.com/api/v3/notifications",
      ]);
    });

    it("falls back to a recent window when the host sends no usable start time", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { calls, fetchImpl } = fakeFetch(githubRouter(() => ({ body: [] })));
      await program.runWatcher(githubInput({ since: "nonsense", watchNotifications: "true", repos: "" }), {
        token: TOKEN,
        fetchImpl,
        store: memoryStore().store,
        now: () => NOW,
      });
      expect(calls.find((call) => call.url.pathname === "/notifications")?.url.searchParams.get("since")).toBe(
        "2026-10-09T11:00:00Z",
      );
    });

    it("never asks GitHub for more than three days, even after a long outage", async () => {
      const program = await load<GithubModule>(githubDirectory);
      const { calls, fetchImpl } = fakeFetch(githubRouter(() => ({ body: [] })));
      await program.runWatcher(githubInput({ since: "2026-01-01T00:00:00Z", watchNotifications: "true", repos: "" }), {
        token: TOKEN,
        fetchImpl,
        store: memoryStore().store,
        now: () => NOW,
      });
      expect(calls.find((call) => call.url.pathname === "/notifications")?.url.searchParams.get("since")).toBe(
        "2026-10-06T12:00:00Z",
      );
    });
  });

  describe("as a process", () => {
    const directory = githubDirectory;
    it("prints a safe message and exits 1 for a missing private variable", async () => {
      const result = await runProgram(directory, JSON.stringify(githubInput()), {});
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "GitHub activity watcher: Missing GITHUB_TOKEN private variable.\nopenbot-error: auth\n",
      );
    });
    it("prints a safe message and exits 1 for invalid input, without the token", async () => {
      const bad = await runProgram(directory, "{not json", { GITHUB_TOKEN: TOKEN });
      expect(bad.code).toBe(1);
      expect(bad.stdout).toBe("");
      expect(bad.stderr).toBe("GitHub activity watcher: Invalid watcher input JSON.\n");
      const invalid = await runProgram(directory, JSON.stringify(githubInput({ repos: "nope" })), {
        GITHUB_TOKEN: TOKEN,
      });
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).not.toContain(TOKEN);
      expect(invalid.stderr).toContain("repos must be");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// git-remote-refs
// ---------------------------------------------------------------------------------------------

const REPO = "https://git.example.com/team/project.git";

interface GitCall {
  command: string;
  args: string[];
  options: GitRunOptions;
  homeExisted: boolean;
}
function fakeGit(stdout: string, result: Partial<GitRunResult> = {}) {
  const calls: GitCall[] = [];
  const run = async (command: string, args: string[], options: GitRunOptions): Promise<GitRunResult> => {
    const homeExisted = await stat(options.env.HOME ?? "").then(
      (entry) => entry.isDirectory(),
      () => false,
    );
    calls.push({ command, args, options, homeExisted });
    return { status: 0, stdout, timedOut: false, tooLarge: false, failedToStart: false, ...result };
  };
  return { calls, run };
}
const refLine = (seed: string, ref: string) => `${sha(seed)}\t${ref}`;
function gitInput(overrides: Json = {}) {
  return {
    repoUrl: REPO,
    username: "",
    refPrefixes: "refs/heads/",
    ignorePatterns: "",
    includeTags: "false",
    ...overrides,
  };
}
const BASE_ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", SECRET_FROM_HOST: "must-not-leak" };

describe("git-remote-refs", () => {
  it("lists the current branches as items, with commit revisions and an unknown actor", async () => {
    const program = await load<GitModule>(gitDirectory);
    const { calls, run } = fakeGit(
      [
        refLine("main", "refs/heads/main"),
        refLine("feature", "refs/heads/feature/login"),
        refLine("v1", "refs/tags/v1.0"),
      ].join("\n"),
    );
    const output = await program.runWatcher(gitInput(), { run, baseEnv: BASE_ENV });
    expect(output).toEqual({
      hasNextPage: false,
      cursor: null,
      items: [
        {
          id: "refs/heads/feature/login",
          revision: sha("feature"),
          actor: "unknown",
          kind: "branch",
          name: "feature/login",
          shortSha: sha("feature").slice(0, 7),
          repository: "git.example.com/team/project.git",
        },
        {
          id: "refs/heads/main",
          revision: sha("main"),
          actor: "unknown",
          kind: "branch",
          name: "main",
          shortSha: sha("main").slice(0, 7),
          repository: "git.example.com/team/project.git",
        },
      ],
    });
    // Read-only: exactly one `git ls-remote`, with the address after `--`.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("git");
    expect(calls[0]?.args).toEqual(["ls-remote", "--heads", "--", REPO]);
  });

  it("includes tags when asked and uses the commit an annotated tag points at", async () => {
    const program = await load<GitModule>(gitDirectory);
    const { calls, run } = fakeGit(
      [
        refLine("main", "refs/heads/main"),
        refLine("tag-object", "refs/tags/v1.0"),
        refLine("tag-commit", "refs/tags/v1.0^{}"),
        refLine("light", "refs/tags/v0.9"),
      ].join("\n"),
    );
    const output = await program.runWatcher(gitInput({ includeTags: "true" }), { run, baseEnv: BASE_ENV });
    expect(calls[0]?.args).toEqual(["ls-remote", "--heads", "--tags", "--", REPO]);
    expect(output.items.map((item) => [item.id, item.revision, item.kind])).toEqual([
      ["refs/heads/main", sha("main"), "branch"],
      ["refs/tags/v0.9", sha("light"), "tag"],
      ["refs/tags/v1.0", sha("tag-commit"), "tag"],
    ]);
  });

  it("filters by prefix and ignore pattern, and asks for the full list for other prefixes", async () => {
    const program = await load<GitModule>(gitDirectory);
    const listing = [
      refLine("a", "refs/heads/main"),
      refLine("b", "refs/heads/dependabot/npm/left-pad"),
      refLine("c", "refs/heads/release/1.0"),
      refLine("d", "refs/merge-requests/5/head"),
      refLine("e", "refs/heads/wip-a"),
    ].join("\n");
    const filtered = fakeGit(listing);
    const output = await program.runWatcher(
      gitInput({ refPrefixes: "refs/heads/", ignorePatterns: "dependabot/*, wip-?" }),
      { run: filtered.run, baseEnv: BASE_ENV },
    );
    expect(output.items.map((item) => item.id)).toEqual(["refs/heads/main", "refs/heads/release/1.0"]);

    const merge = fakeGit(listing);
    const requests = await program.runWatcher(gitInput({ refPrefixes: "refs/merge-requests/" }), {
      run: merge.run,
      baseEnv: BASE_ENV,
    });
    expect(merge.calls[0]?.args).toEqual(["ls-remote", "--", REPO]);
    expect(requests.items).toMatchObject([
      { id: "refs/merge-requests/5/head", kind: "ref", name: "refs/merge-requests/5/head" },
    ]);
  });

  it("matches simple globs", async () => {
    const program = await load<GitModule>(gitDirectory);
    expect(program.globMatches("dependabot/*", "dependabot/npm/x")).toBe(true);
    expect(program.globMatches("dependabot/*", "feature/dependabot/x")).toBe(false);
    expect(program.globMatches("*-bot", "renovate-bot")).toBe(true);
    expect(program.globMatches("a?c", "abc")).toBe(true);
    expect(program.globMatches("a?c", "ac")).toBe(false);
    expect(program.globMatches("a*a*a*a*a*b", "a".repeat(60))).toBe(false);
    expect(program.globMatches("", "")).toBe(true);
  });

  it("returns an empty list for an empty repository", async () => {
    const program = await load<GitModule>(gitDirectory);
    const output = await program.runWatcher(gitInput(), { run: fakeGit("").run, baseEnv: BASE_ENV });
    expect(output.items).toEqual([]);
  });

  describe("the token", () => {
    it("is passed only as a Basic header in a config variable of a fresh environment", async () => {
      const program = await load<GitModule>(gitDirectory);
      const { calls, run } = fakeGit(refLine("main", "refs/heads/main"));
      const output = await program.runWatcher(gitInput({ username: "oauth2" }), {
        token: TOKEN,
        run,
        baseEnv: BASE_ENV,
      });
      const call = calls[0];
      const env = call?.options.env ?? {};
      const expected = `Authorization: Basic ${Buffer.from(`oauth2:${TOKEN}`).toString("base64")}`;
      expect(env.GIT_CONFIG_COUNT).toBe("2");
      expect(env.GIT_CONFIG_KEY_0).toBe("http.followRedirects");
      expect(env.GIT_CONFIG_VALUE_0).toBe("false");
      expect(env.GIT_CONFIG_KEY_1).toBe("http.extraHeader");
      expect(env.GIT_CONFIG_VALUE_1).toBe(expected);
      // Never in a command line, never in the result.
      expect(JSON.stringify(call?.args)).not.toContain(TOKEN);
      expect(JSON.stringify(call?.args)).not.toContain(Buffer.from(`oauth2:${TOKEN}`).toString("base64"));
      expect(JSON.stringify(output)).not.toContain(TOKEN);
      // The environment is built from nothing: no host variable, no prompt, no helper, no extra protocol.
      expect(Object.keys(env).sort()).toEqual(
        [
          "GIT_ALLOW_PROTOCOL",
          "GIT_CONFIG_COUNT",
          "GIT_CONFIG_KEY_0",
          "GIT_CONFIG_KEY_1",
          "GIT_CONFIG_NOSYSTEM",
          "GIT_CONFIG_VALUE_0",
          "GIT_CONFIG_VALUE_1",
          "GIT_TERMINAL_PROMPT",
          "HOME",
          "LANG",
          "PATH",
        ].sort(),
      );
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(env.GIT_ALLOW_PROTOCOL).toBe("https");
      expect(env).not.toHaveProperty("GIT_ASKPASS");
      expect(env).not.toHaveProperty("SECRET_FROM_HOST");
      expect(Object.values(env).filter((value) => value.includes(TOKEN))).toEqual([]);
    });

    it("sends no authorization at all without a token, and the default user name is git", async () => {
      const program = await load<GitModule>(gitDirectory);
      const { calls, run } = fakeGit("");
      await program.runWatcher(gitInput(), { run, baseEnv: BASE_ENV });
      const env = calls[0]?.options.env ?? {};
      expect(env.GIT_CONFIG_COUNT).toBe("1");
      expect(Object.values(env).some((value) => value.includes("Authorization"))).toBe(false);

      const withToken = fakeGit("");
      await program.runWatcher(gitInput(), { token: TOKEN, run: withToken.run, baseEnv: BASE_ENV });
      expect(withToken.calls[0]?.options.env.GIT_CONFIG_VALUE_1).toBe(
        `Authorization: Basic ${Buffer.from(`git:${TOKEN}`).toString("base64")}`,
      );
    });

    it("uses a throwaway home that exists during the call and is gone afterwards", async () => {
      const program = await load<GitModule>(gitDirectory);
      const { calls, run } = fakeGit("");
      await program.runWatcher(gitInput(), { run, baseEnv: BASE_ENV });
      const call = calls[0];
      expect(call?.homeExisted).toBe(true);
      expect(call?.options.env.HOME).toContain(tmpdir());
      expect(call?.options.cwd).toBe(call?.options.env.HOME);
      expect(call?.options.timeoutMs).toBeLessThanOrEqual(25_000);
      await expect(stat(call?.options.env.HOME ?? "")).rejects.toThrow();
    });

    it("rejects a token that could split a header", async () => {
      const program = await load<GitModule>(gitDirectory);
      const { calls, run } = fakeGit("");
      await failure(program.runWatcher(gitInput(), { token: `${TOKEN}\nX-Evil: 1`, run, baseEnv: BASE_ENV }));
      expect(calls).toHaveLength(0);
    });
  });

  describe("failures", () => {
    const cases: Array<[string, Partial<GitRunResult>, string]> = [
      ["a git error", { status: 128, stdout: `${SERVER_TEXT} ${TOKEN}` }, "Could not read the repository"],
      ["a timeout", { timedOut: true, status: null }, "timed out"],
      ["too much output", { tooLarge: true, status: null }, "safe size limit"],
      ["git that cannot start", { failedToStart: true, status: null }, "could not be started"],
    ];
    for (const [name, result, expected] of cases) {
      it(`reports ${name} with a fixed message`, async () => {
        const program = await load<GitModule>(gitDirectory);
        const message = await failure(
          program.runWatcher(gitInput(), { token: TOKEN, run: fakeGit("", result).run, baseEnv: BASE_ENV }),
        );
        expect(message).toContain(expected);
        expect(message).not.toContain(TOKEN);
        expect(message).not.toContain(SERVER_TEXT);
      });
    }

    it("never repeats the text of an error that the runner throws", async () => {
      const program = await load<GitModule>(gitDirectory);
      const message = await failure(
        program.runWatcher(gitInput(), {
          token: TOKEN,
          run: async () => {
            throw new Error(`boom ${TOKEN} ${SERVER_TEXT}`);
          },
          baseEnv: BASE_ENV,
        }),
      );
      expect(message).toBe("git could not be run.");
    });

    it("rejects output that is not a ref list, and a repeated ref", async () => {
      const program = await load<GitModule>(gitDirectory);
      const garbage = await failure(
        program.runWatcher(gitInput(), { run: fakeGit(`fatal: ${SERVER_TEXT}`).run, baseEnv: BASE_ENV }),
      );
      expect(garbage).toBe("git returned output that could not be read.");
      const twice = await failure(
        program.runWatcher(gitInput(), {
          run: fakeGit([refLine("a", "refs/heads/main"), refLine("b", "refs/heads/main")].join("\n")).run,
          baseEnv: BASE_ENV,
        }),
      );
      expect(twice).toContain("twice");
    });

    it("fails instead of cutting a list of more than 2000 refs", async () => {
      const program = await load<GitModule>(gitDirectory);
      const many = Array.from({ length: 2001 }, (_, index) => refLine(`b${index}`, `refs/heads/b${index}`)).join("\n");
      const message = await failure(program.runWatcher(gitInput(), { run: fakeGit(many).run, baseEnv: BASE_ENV }));
      expect(message).toContain("more than 2000");
    });

    it("fails when the result would pass the byte limit", async () => {
      const program = await load<GitModule>(gitDirectory);
      const names = Array.from({ length: 1900 }, (_, index) =>
        refLine(`n${index}`, `refs/heads/${"x".repeat(250)}${index}`),
      ).join("\n");
      const message = await failure(program.runWatcher(gitInput(), { run: fakeGit(names).run, baseEnv: BASE_ENV }));
      expect(message).toContain("safe size limit");
    });
  });

  describe("input", () => {
    const rejected: Array<[string, Json]> = [
      ["no address", { repoUrl: "" }],
      ["an http address", { repoUrl: "http://git.example.com/a.git" }],
      ["an ssh address", { repoUrl: "ssh://git@git.example.com/a.git" }],
      ["an scp-style address", { repoUrl: "git@git.example.com:a/b.git" }],
      ["a file address", { repoUrl: "file:///tmp/repo.git" }],
      ["a local path", { repoUrl: "/tmp/repo.git" }],
      ["an option-like address", { repoUrl: "--upload-pack=touch /tmp/x" }],
      ["credentials in the address", { repoUrl: "https://user:pass@git.example.com/a.git" }],
      ["a user name in the address", { repoUrl: "https://user@git.example.com/a.git" }],
      ["an empty user name in the address", { repoUrl: "https://@git.example.com/a.git" }],
      ["a query", { repoUrl: "https://git.example.com/a.git?x=1" }],
      ["a space in the address", { repoUrl: "https://git.example.com/a b.git" }],
      ["a colon in the user name", { username: "a:b" }],
      ["a prefix outside refs/", { refPrefixes: "heads/" }],
      ["a prefix with odd characters", { refPrefixes: "refs/heads/;rm" }],
      ["a bad tag switch", { includeTags: "maybe" }],
      ["too many ignore patterns", { ignorePatterns: Array.from({ length: 51 }, (_, index) => `p${index}`).join(",") }],
    ];
    for (const [name, overrides] of rejected) {
      it(`rejects ${name} without starting git`, async () => {
        const program = await load<GitModule>(gitDirectory);
        const { calls, run } = fakeGit("");
        await failure(program.runWatcher(gitInput(overrides), { run, baseEnv: BASE_ENV }));
        expect(calls).toHaveLength(0);
      });
    }

    it("cannot be sent a file address through input or environment, only through the test-only argument", async () => {
      const program = await load<GitModule>(gitDirectory);
      const { calls, run } = fakeGit("");
      await failure(
        program.runWatcher(gitInput({ repoUrl: "file:///tmp/r.git", testOnlyAllowFileUrl: true }), {
          run,
          baseEnv: { ...BASE_ENV, TEST_ONLY_ALLOW_FILE_URL: "1" },
        }),
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe("as a process", () => {
    it("prints a safe message and exits 1 for an address that is not https, and leaves no output", async () => {
      const result = await runProgram(gitDirectory, JSON.stringify(gitInput({ repoUrl: "file:///tmp/nowhere.git" })), {
        GIT_ACCESS_TOKEN: TOKEN,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Git remote refs watcher: repoUrl must start with https://.\nopenbot-error: config\n");
    });
    it("prints a safe message for invalid JSON and for an invalid private variable", async () => {
      const bad = await runProgram(gitDirectory, "[", {});
      expect(bad.stderr).toBe("Git remote refs watcher: Invalid watcher input JSON.\n");
      expect(bad.code).toBe(1);
      const token = await runProgram(gitDirectory, JSON.stringify(gitInput()), { GIT_ACCESS_TOKEN: "has a space" });
      expect(token.code).toBe(1);
      expect(token.stderr).toBe(
        "Git remote refs watcher: Invalid GIT_ACCESS_TOKEN private variable.\nopenbot-error: auth\n",
      );
      expect(token.stderr).not.toContain("has a space");
    });
  });

  describe("the command runner", () => {
    const options = (overrides: Partial<GitRunOptions>): GitRunOptions => ({
      env: { PATH: process.env.PATH ?? "" },
      cwd: tmpdir(),
      timeoutMs: 10_000,
      maxBytes: 1_000_000,
      ...overrides,
    });
    it("stops a command that runs past the deadline", async () => {
      const program = await load<GitModule>(gitDirectory);
      const result = await program.runCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        options({ timeoutMs: 200 }),
      );
      expect(result.timedOut).toBe(true);
      expect(result.status).not.toBe(0);
    });
    it("stops a command that writes more than the limit", async () => {
      const program = await load<GitModule>(gitDirectory);
      const result = await program.runCommand(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"],
        options({ maxBytes: 1000 }),
      );
      expect(result.tooLarge).toBe(true);
      expect(result.status).not.toBe(0);
    });
    it("reports a command that cannot start, and discards stderr", async () => {
      const program = await load<GitModule>(gitDirectory);
      const missing = await program.runCommand("/nonexistent/git", [], options({}));
      expect(missing.failedToStart).toBe(true);
      const noisy = await program.runCommand(
        process.execPath,
        ["-e", `console.error(${JSON.stringify(SERVER_TEXT)}); process.stdout.write('ok')`],
        options({}),
      );
      expect(noisy).toMatchObject({ status: 0, stdout: "ok", timedOut: false, tooLarge: false });
    });
  });

  describe("against a real bare repository", () => {
    const gitEnvironment = (home: string): Record<string, string> => ({
      PATH: process.env.PATH ?? "",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    });
    const git = (cwd: string, home: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, env: gitEnvironment(home), encoding: "utf8" }).trim();

    it("sees new branches, tags and moved branches, and forgets deleted ones", async () => {
      const program = await load<GitModule>(gitDirectory);
      const root = await temporaryRoot();
      const home = join(root, "home");
      await mkdir(home);
      const bare = join(root, "remote.git");
      const clone = join(root, "clone");
      git(root, home, "init", "--bare", "-b", "main", bare);
      git(root, home, "init", "-q", "-b", "main", clone);
      git(clone, home, "remote", "add", "origin", bare);
      await writeFile(join(clone, "a.txt"), "one");
      git(clone, home, "add", ".");
      git(clone, home, "commit", "-q", "-m", "first");
      git(clone, home, "branch", "-M", "main");
      git(clone, home, "push", "-q", "origin", "main");
      git(clone, home, "push", "-q", "origin", "main:feature/x");
      git(clone, home, "tag", "-a", "v1", "-m", "release one");
      git(clone, home, "push", "-q", "origin", "v1");
      const first = git(clone, home, "rev-parse", "HEAD");

      const url = pathToFileURL(bare).href;
      const options = { testOnlyAllowFileUrl: true, baseEnv: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" } };
      const before = await program.runWatcher(gitInput({ repoUrl: url, includeTags: "true" }), options);
      expect(before.items.map((item) => [item.id, item.revision, item.actor])).toEqual([
        ["refs/heads/feature/x", first, "unknown"],
        ["refs/heads/main", first, "unknown"],
        ["refs/tags/v1", first, "unknown"], // the commit under the annotated tag, not the tag object
      ]);

      await writeFile(join(clone, "a.txt"), "two");
      git(clone, home, "commit", "-q", "-am", "second");
      git(clone, home, "push", "-q", "origin", "main");
      git(clone, home, "push", "-q", "origin", "main:fresh");
      const second = git(clone, home, "rev-parse", "HEAD");
      git(clone, home, "push", "-q", "origin", ":feature/x");

      const after = await program.runWatcher(gitInput({ repoUrl: url, includeTags: "true" }), options);
      expect(after.items.map((item) => [item.id, item.revision])).toEqual([
        ["refs/heads/fresh", second],
        ["refs/heads/main", second],
        ["refs/tags/v1", first],
      ]);

      // Production does not accept the same address.
      const refused = await failure(program.runWatcher(gitInput({ repoUrl: url }), { baseEnv: options.baseEnv }));
      expect(refused).toBe("repoUrl must start with https://.");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Both templates
// ---------------------------------------------------------------------------------------------

describe("watcher templates", () => {
  it("load and install through the same proof as the real catalog build", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "watchers"));
    await cp(githubDirectory, join(root, "watchers", "github-activity"), { recursive: true });
    await cp(gitDirectory, join(root, "watchers", "git-remote-refs"), { recursive: true });
    await writeFile(
      join(root, "catalog.json"),
      JSON.stringify({ schemaVersion: 1, catalogVersion: "v1", order: ["github-activity", "git-remote-refs"] }),
    );

    const { templates, files } = await loadWatcherCatalog(root);
    expect(templates.map((template) => template.slug)).toEqual(["github-activity", "git-remote-refs"]);
    const [github, gitTemplate] = templates;
    expect(github?.app).toBe("github-direct");
    expect(gitTemplate?.app).toBeNull();
    expect(github?.variables.map((variable) => variable.name)).toEqual(["GITHUB_TOKEN"]);
    expect(gitTemplate?.variables.map((variable) => variable.name)).toEqual(["GIT_ACCESS_TOKEN"]);
    for (const template of templates) {
      expect(template.intervalSeconds).toBeGreaterThanOrEqual(30);
      expect(template.actorPointer).toBe("/actor");
      expect(template.instruction).toMatch(/untrusted/i);
      expect(template.instruction).toMatch(/do not (change|push)/i);
      const program = files.find((file) => file.path === `programs/${template.program.file}`);
      expect(
        createHash("sha256")
          .update(program?.content ?? "")
          .digest("hex"),
      ).toBe(template.program.digest);
    }
    // The required fields block an install until they are filled.
    expect(github?.configuration.filter((field) => field.required).map((field) => field.name)).toEqual([
      "instanceId",
      "login",
    ]);
    expect(gitTemplate?.configuration.filter((field) => field.required).map((field) => field.name)).toEqual([
      "repoUrl",
    ]);
  });

  it("ship programs that hold no secret and read no credential from a file", async () => {
    for (const directory of [githubDirectory, gitDirectory]) {
      const program = await readFile(join(directory, "program.mjs"), "utf8");
      expect(program).not.toMatch(/ghp_|github_pat_|-----BEGIN/);
      expect(program).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/i);
    }
  });
});
