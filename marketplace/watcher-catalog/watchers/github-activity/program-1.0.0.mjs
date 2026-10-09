import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_INPUT_BYTES = 131072;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 2000;
// The host stops at 512,000 bytes. Keep a margin for the wrapper object.
const MAX_OUTPUT_BYTES = 450000;
// The host stops a program after 40 s. Stop sending requests well before that.
const RUN_BUDGET_MS = 32000;
const REQUEST_TIMEOUT_MS = 10000;
const MIN_REQUEST_MS = 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_REPOS = 10;
const MAX_BRANCHES = 5;
const DEFAULT_MAX_REQUESTS = 60;
const HARD_MAX_REQUESTS = 100;
// After a long outage the host asks for a very old window. Never ask GitHub for more than this.
const MAX_LOOKBACK_MS = 3 * 24 * 3600 * 1000;
const FALLBACK_LOOKBACK_MS = 3600 * 1000;
// A run is listed by its start time but fails later, so look back further for runs.
const RUN_EXTRA_LOOKBACK_MS = 6 * 3600 * 1000;
// Releases are listed by creation time but a draft can be published much later.
const RELEASE_EXTRA_LOOKBACK_MS = 30 * 24 * 3600 * 1000;
const MIN_COOLDOWN_MS = 60000;
const MAX_COOLDOWN_MS = 3600 * 1000;
const TITLE_LENGTH = 200;
const TEXT_LENGTH = 300;
// Explicit uncertainty marker, never a user identity. The host compares only real logins.
export const UNKNOWN_ACTOR = "unknown";

export // Each run of control characters becomes one space.
function controlToSpace(text) {
  let out = "";
  let inRun = false;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) {
      if (!inRun) out += " ";
      inRun = true;
    } else {
      out += ch;
      inRun = false;
    }
  }
  return out;
}

class WatcherError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new WatcherError(message);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function optionalString(value, name, maxLength = 8192) {
  if (value === undefined || value === null) return "";
  requireCondition(typeof value === "string" && value.length <= maxLength, `Invalid ${name}.`);
  return value.trim();
}

function readBoolean(value, name, fallback) {
  const text = optionalString(value, name, 16).toLowerCase();
  if (text === "") return fallback;
  requireCondition(text === "true" || text === "false", `${name} must be true or false.`);
  return text === "true";
}

function readApiBase(value) {
  const raw = optionalString(value, "apiBaseUrl", 2048) || DEFAULT_API;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WatcherError("apiBaseUrl is not a valid address.");
  }
  requireCondition(
    url.protocol === "https:" && url.hostname && !url.username && !url.password && !url.search && !url.hash,
    "apiBaseUrl must be an https address without credentials, query or fragment.",
  );
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function readList(value, name, maximum) {
  const entries = optionalString(value, name)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  requireCondition(entries.length <= maximum, `${name} may list at most ${maximum} entries.`);
  return entries;
}

function readRepos(value) {
  const seen = new Set();
  const repos = [];
  for (const entry of readList(value, "repos", MAX_REPOS)) {
    requireCondition(
      /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(entry) &&
        !/^\.{1,2}\//.test(entry) &&
        !/\/\.{1,2}$/.test(entry),
      "repos must be a comma-separated list of owner/name.",
    );
    if (!seen.has(entry.toLowerCase())) {
      seen.add(entry.toLowerCase());
      repos.push(entry);
    }
  }
  return repos;
}

function readBranches(value) {
  const branches = readList(value, "branches", MAX_BRANCHES);
  for (const branch of branches) {
    requireCondition(
      /^[A-Za-z0-9._/-]{1,200}$/.test(branch) && !branch.includes(".."),
      "branches holds an invalid name.",
    );
  }
  return [...new Set(branches)];
}

function readConfiguration(input) {
  requireCondition(isObject(input), "Expected a JSON object.");
  const instanceId = optionalString(input.instanceId, "instanceId", 128);
  requireCondition(instanceId.length > 0, "Missing or invalid instanceId.");
  const login = optionalString(input.login, "login", 100);
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(login), "Missing or invalid login.");
  const maxRequests = Number(optionalString(input.maxRequests, "maxRequests", 16) || DEFAULT_MAX_REQUESTS);
  requireCondition(
    Number.isInteger(maxRequests) && maxRequests >= 5 && maxRequests <= HARD_MAX_REQUESTS,
    `maxRequests must be an integer from 5 to ${HARD_MAX_REQUESTS}.`,
  );
  const config = {
    instanceId,
    login,
    maxRequests,
    apiBase: readApiBase(input.apiBaseUrl),
    watchNotifications: readBoolean(input.watchNotifications, "watchNotifications", true),
    participatingOnly: readBoolean(input.participatingOnly, "participatingOnly", false),
    repos: readRepos(input.repos),
    branches: readBranches(input.branches),
    watchPullRequests: readBoolean(input.watchPullRequests, "watchPullRequests", true),
    watchIssues: readBoolean(input.watchIssues, "watchIssues", true),
    watchCommits: readBoolean(input.watchCommits, "watchCommits", true),
    watchFailedRuns: readBoolean(input.watchFailedRuns, "watchFailedRuns", true),
    watchReleases: readBoolean(input.watchReleases, "watchReleases", true),
    watchSecurityAlerts: readBoolean(input.watchSecurityAlerts, "watchSecurityAlerts", false),
  };
  const repoWatches =
    config.watchPullRequests ||
    config.watchIssues ||
    config.watchCommits ||
    config.watchFailedRuns ||
    config.watchReleases ||
    config.watchSecurityAlerts;
  requireCondition(
    config.watchNotifications || (config.repos.length > 0 && repoWatches),
    "Nothing to watch: turn on notifications, or list repos and turn on at least one repository watch.",
  );
  return config;
}

function readToken(token) {
  requireCondition(typeof token === "string" && token.trim().length > 0, "Missing GITHUB_TOKEN private variable.");
  requireCondition(/^[!-~]{1,1024}$/.test(token.trim()), "Invalid GITHUB_TOKEN private variable.");
  return token.trim();
}

function readWindow(input, nowMs) {
  const parsed = typeof input.since === "string" ? Date.parse(input.since) : NaN;
  const since = Number.isFinite(parsed) ? parsed : nowMs - FALLBACK_LOOKBACK_MS;
  return Math.min(Math.max(since, nowMs - MAX_LOOKBACK_MS), nowMs);
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// Only a server-directed cooldown timestamp persists, separately per saved instance.
// No account contents, credentials or polling checkpoints are stored here.
function cooldownFilename(instanceId) {
  const key = createHash("sha256").update(instanceId).digest("hex");
  return path.join(path.dirname(fileURLToPath(import.meta.url)), ".github-activity-cooldowns", key);
}

const cooldownStore = {
  async read(instanceId) {
    try {
      const timestamp = Number(await fs.readFile(cooldownFilename(instanceId), "utf8"));
      return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw new WatcherError("Cannot read API cooldown state.");
    }
  },
  async write(instanceId, timestamp) {
    const filename = cooldownFilename(instanceId);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, String(timestamp), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, filename);
    } catch {
      await fs.unlink(temporary).catch(() => {});
      throw new WatcherError("Cannot save API cooldown state.");
    }
  },
};

async function readJson(response) {
  requireCondition(response.body && typeof response.body.getReader === "function", "Missing API response body.");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      requireCondition(total <= MAX_RESPONSE_BYTES, "API response exceeds the safe size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WatcherError("Invalid JSON API response.");
  }
}

function headerNumber(response, name) {
  const raw = response.headers.get(name);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The only way this program talks to GitHub: read-only GET requests. Every failure becomes a
 * message written here; no text from GitHub or from a thrown error is ever repeated.
 */
function createClient({ base, token, fetchImpl, store, instanceId, now, maxRequests }) {
  const startedAt = now();
  let requests = 0;
  let remaining = null;
  let resetMs = 0;

  async function coolDown(untilMs) {
    const current = now();
    await store.write(instanceId, Math.min(Math.max(untilMs, current + MIN_COOLDOWN_MS), current + MAX_COOLDOWN_MS));
    throw new WatcherError("GitHub API rate limit reached; a server-directed cooldown is active.");
  }

  async function get(pathname, params, { denied, tolerate = [] }) {
    if (remaining !== null && remaining <= 0) await coolDown(resetMs);
    requireCondition(
      requests < maxRequests,
      "Request limit (maxRequests) reached. Raise it or watch fewer repositories.",
    );
    const left = RUN_BUDGET_MS - (now() - startedAt);
    requireCondition(
      left >= MIN_REQUEST_MS,
      "The check ran out of time. Watch fewer repositories or turn off some watches.",
    );
    const url = new URL(`${base}${pathname}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, left));
    let response;
    let body = null;
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "openbot-github-activity",
        },
      });
      const limit = headerNumber(response, "x-ratelimit-remaining");
      if (limit !== null) {
        remaining = limit;
        resetMs = (headerNumber(response, "x-ratelimit-reset") ?? 0) * 1000;
      }
      if (response.ok) body = await readJson(response);
    } catch (error) {
      if (error instanceof WatcherError) throw error;
      throw new WatcherError("GitHub API request failed or timed out.");
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      return { body, hasNext: /;\s*rel="?next"?\s*(?:[,;]|$)/.test(response.headers.get("link") ?? "") };
    }
    await response.body?.cancel?.().catch(() => {});
    const status = Number(response.status) || 0;
    const retry = headerNumber(response, "retry-after");
    const limitHeader = headerNumber(response, "x-ratelimit-remaining");
    if (status === 429 || (status === 403 && (retry !== null || limitHeader === 0))) {
      const current = now();
      const resetKnown = limitHeader === 0 && resetMs > 0;
      await coolDown(
        retry !== null ? current + Math.max(0, retry) * 1000 : resetKnown ? resetMs : current + MIN_COOLDOWN_MS,
      );
    }
    if (tolerate.includes(status)) return { body: null, hasNext: false };
    requireCondition(status !== 401, "GitHub rejected the token (HTTP 401). Check GITHUB_TOKEN.");
    requireCondition(status !== 403 && status !== 404 && status !== 422, denied);
    throw new WatcherError(`GitHub API request failed (HTTP ${status || "error"}).`);
  }

  /** All pages of one list, following the Link header. Too many pages is an error, never a cut. */
  async function list(pathname, params, { denied, label, key = null, tolerate, stopBefore = null }) {
    const rows = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { body, hasNext } = await get(pathname, { ...params, per_page: PAGE_SIZE, page }, { denied, tolerate });
      if (body === null) return rows;
      const pageRows = key ? body?.[key] : body;
      requireCondition(Array.isArray(pageRows) && pageRows.every(isObject), "GitHub returned an unexpected response.");
      rows.push(...pageRows);
      if (!hasNext) return rows;
      // Newest first lists end once a row is older than the window.
      if (stopBefore && pageRows.length > 0 && stopBefore(pageRows[pageRows.length - 1])) return rows;
    }
    throw new WatcherError(`GitHub returned more than ${MAX_PAGES * PAGE_SIZE} ${label}. Narrow the settings.`);
  }

  return { get, list };
}

// ---- Field helpers. All text from GitHub is data; keep it short and plain.

function plain(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = controlToSpace(value).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function link(value) {
  return typeof value === "string" && value.startsWith("https://") && value.length <= TEXT_LENGTH ? value : null;
}

function userLogin(user) {
  const value = user?.login;
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\[bot\])?$/.test(value) ? value : null;
}

function timestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  requireCondition(Number.isFinite(parsed), "GitHub returned an unexpected response.");
  return parsed;
}

function positiveInteger(value) {
  requireCondition(Number.isSafeInteger(value) && value > 0, "GitHub returned an unexpected response.");
  return value;
}

function commitSha(value) {
  requireCondition(
    typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value),
    "GitHub returned an unexpected response.",
  );
  return value;
}

/**
 * The author is only named when the first event of the item is its creation and nothing
 * happened afterwards, so the creator is the actor. Any later change has an unknown author.
 */
function creationActor(row, sinceMs) {
  const created = timestamp(row.created_at);
  const updated = timestamp(row.updated_at);
  return created >= sinceMs && updated === created ? (userLogin(row.user) ?? UNKNOWN_ACTOR) : UNKNOWN_ACTOR;
}

// ---- Item builders

function notificationItem(thread) {
  requireCondition(
    typeof thread.id === "string" && thread.id.length > 0 && thread.id.length < 64,
    "GitHub returned an unexpected response.",
  );
  timestamp(thread.updated_at);
  return {
    id: `n:${thread.id}`,
    revision: thread.updated_at,
    actor: UNKNOWN_ACTOR, // The notification API does not say who caused it.
    kind: plain(thread.reason, 64) || "notification",
    type: plain(thread.subject?.type, 64),
    title: plain(thread.subject?.title, TITLE_LENGTH),
    repository: plain(thread.repository?.full_name, 200),
    url: link(thread.subject?.url),
    unread: thread.unread === true,
  };
}

function pullItem(repo, pr, sinceMs) {
  const number = positiveInteger(pr.number);
  const updated = timestamp(pr.updated_at);
  if (updated < sinceMs) return null;
  const state = pr.merged_at ? "merged" : pr.state === "open" ? "open" : "closed";
  const head = typeof pr.head?.sha === "string" ? pr.head.sha : "";
  return {
    id: `pr:${repo}#${number}`,
    revision: `${head}:${state}:${pr.updated_at}`,
    actor: creationActor(pr, sinceMs),
    kind: "pull_request",
    repository: repo,
    number,
    title: plain(pr.title, TITLE_LENGTH),
    state,
    draft: pr.draft === true,
    author: userLogin(pr.user),
    headSha: head.slice(0, 7),
    url: link(pr.html_url),
    updatedAt: pr.updated_at,
  };
}

function issueItem(repo, issue, sinceMs) {
  if (issue.pull_request !== undefined) return null; // Pull requests have their own watch.
  const number = positiveInteger(issue.number);
  const updated = timestamp(issue.updated_at);
  if (updated < sinceMs) return null;
  const state = issue.state === "open" ? "open" : "closed";
  return {
    id: `issue:${repo}#${number}`,
    revision: `${state}:${issue.updated_at}`,
    actor: creationActor(issue, sinceMs),
    kind: "issue",
    repository: repo,
    number,
    title: plain(issue.title, TITLE_LENGTH),
    state,
    author: userLogin(issue.user),
    comments: Number.isSafeInteger(issue.comments) ? issue.comments : null,
    url: link(issue.html_url),
    updatedAt: issue.updated_at,
  };
}

function commitItem(repo, branch, commit) {
  const sha = commitSha(commit.sha);
  return {
    id: `c:${repo}@${sha}`,
    revision: sha,
    actor: userLogin(commit.author) ?? UNKNOWN_ACTOR,
    kind: "commit",
    repository: repo,
    branches: [branch],
    sha: sha.slice(0, 7),
    message: plain(String(commit.commit?.message ?? "").split("\n")[0], TITLE_LENGTH),
    authorName: plain(commit.commit?.author?.name, 100),
    url: link(commit.html_url),
    date: typeof commit.commit?.author?.date === "string" ? commit.commit.author.date : null,
  };
}

function runItem(repo, run) {
  const id = positiveInteger(run.id);
  const conclusion = plain(run.conclusion, 32) || "failure";
  return {
    id: `run:${repo}:${id}`,
    revision: `${conclusion}:${Number.isSafeInteger(run.run_attempt) ? run.run_attempt : 1}`,
    // A failed run is not a change by the person who triggered it, so it must not be skipped as theirs.
    actor: UNKNOWN_ACTOR,
    kind: "failed_run",
    repository: repo,
    workflow: plain(run.name, 100),
    title: plain(run.display_title, TITLE_LENGTH),
    branch: plain(run.head_branch, 200),
    event: plain(run.event, 32),
    runNumber: Number.isSafeInteger(run.run_number) ? run.run_number : null,
    attempt: Number.isSafeInteger(run.run_attempt) ? run.run_attempt : 1,
    conclusion,
    triggeredBy: userLogin(run.triggering_actor) ?? userLogin(run.actor),
    sha: typeof run.head_sha === "string" ? run.head_sha.slice(0, 7) : "",
    url: link(run.html_url),
  };
}

function releaseItem(repo, release, sinceMs) {
  if (release.draft === true) return null;
  const id = positiveInteger(release.id);
  const published = timestamp(release.published_at ?? release.created_at);
  if (published < sinceMs) return null;
  return {
    id: `rel:${repo}:${id}`,
    revision: `${plain(release.tag_name, 200)}:${release.published_at ?? release.created_at}`,
    actor: userLogin(release.author) ?? UNKNOWN_ACTOR,
    kind: "release",
    repository: repo,
    tag: plain(release.tag_name, 200),
    name: plain(release.name, TITLE_LENGTH),
    prerelease: release.prerelease === true,
    url: link(release.html_url),
    publishedAt: release.published_at ?? release.created_at,
  };
}

function alertItem(repo, alert, sinceMs) {
  const number = positiveInteger(alert.number);
  if (timestamp(alert.updated_at) < sinceMs) return null;
  return {
    id: `alert:${repo}:${number}`,
    revision: `${plain(alert.state, 32)}:${alert.updated_at}`,
    actor: UNKNOWN_ACTOR,
    kind: "security_alert",
    repository: repo,
    package: plain(alert.dependency?.package?.name, 200),
    ecosystem: plain(alert.dependency?.package?.ecosystem, 64),
    severity: plain(alert.security_advisory?.severity, 32),
    summary: plain(alert.security_advisory?.summary, TEXT_LENGTH),
    url: link(alert.html_url),
    updatedAt: alert.updated_at,
  };
}

// ---- Collectors

async function collectRepository(client, config, repo, sinceMs, out) {
  const base = `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
  const cannot = (what) => hints[what].replace("{repo}", repo);
  const hints = {
    repository: "Cannot read repository {repo}. Check the name, and that the token can see this repository.",
    "pull requests": "Cannot read pull requests of {repo}. The token needs read access to pull requests.",
    issues: "Cannot read issues of {repo}. The token needs read access to issues.",
    commits: "Cannot read commits of {repo}. Check the branch names, and that the token has read access to the code.",
    "workflow runs": "Cannot read workflow runs of {repo}. The token needs read access to Actions.",
    releases: "Cannot read releases of {repo}. The token needs read access to the code.",
    "Dependabot alerts":
      "Cannot read Dependabot alerts of {repo}. The token needs read access to Dependabot alerts, and alerts must be on for the repository.",
  };
  // One cheap call proves the repository is readable and gives the default branch.
  const { body: meta } = await client.get(base, {}, { denied: cannot("repository") });
  requireCondition(
    isObject(meta) && typeof meta.full_name === "string" && meta.full_name.toLowerCase() === repo.toLowerCase(),
    "GitHub returned a different repository than expected.",
  );

  if (config.watchPullRequests) {
    const rows = await client.list(
      `${base}/pulls`,
      { state: "all", sort: "updated", direction: "desc" },
      {
        denied: cannot("pull requests"),
        label: "pull requests",
        stopBefore: (row) => timestamp(row.updated_at) < sinceMs,
      },
    );
    for (const row of rows) {
      const item = pullItem(repo, row, sinceMs);
      if (item) out.push(item);
    }
  }
  if (config.watchIssues) {
    const rows = await client.list(
      `${base}/issues`,
      {
        state: "all",
        sort: "updated",
        direction: "desc",
        since: iso(sinceMs),
      },
      { denied: cannot("issues"), label: "issues" },
    );
    for (const row of rows) {
      const item = issueItem(repo, row, sinceMs);
      if (item) out.push(item);
    }
  }
  if (config.watchCommits) {
    const branches = config.branches.length > 0 ? config.branches : [requiredBranch(meta.default_branch)];
    for (const branch of branches) {
      const rows = await client.list(
        `${base}/commits`,
        { sha: branch, since: iso(sinceMs) },
        {
          denied: cannot("commits"),
          label: "commits",
          tolerate: [409], // 409 is an empty repository.
        },
      );
      for (const row of rows) out.push(commitItem(repo, branch, row));
    }
  }
  if (config.watchFailedRuns) {
    const rows = await client.list(
      `${base}/actions/runs`,
      {
        status: "failure",
        created: `>=${iso(sinceMs - RUN_EXTRA_LOOKBACK_MS)}`,
      },
      { denied: cannot("workflow runs"), label: "workflow runs", key: "workflow_runs" },
    );
    for (const row of rows) out.push(runItem(repo, row));
  }
  if (config.watchReleases) {
    const rows = await client.list(
      `${base}/releases`,
      {},
      {
        denied: cannot("releases"),
        label: "releases",
        stopBefore: (row) => timestamp(row.created_at) < sinceMs - RELEASE_EXTRA_LOOKBACK_MS,
      },
    );
    for (const row of rows) {
      const item = releaseItem(repo, row, sinceMs);
      if (item) out.push(item);
    }
  }
  if (config.watchSecurityAlerts) {
    const rows = await client.list(
      `${base}/dependabot/alerts`,
      { state: "open", sort: "updated", direction: "desc" },
      {
        denied: cannot("Dependabot alerts"),
        label: "Dependabot alerts",
        stopBefore: (row) => timestamp(row.updated_at) < sinceMs,
      },
    );
    for (const row of rows) {
      const item = alertItem(repo, row, sinceMs);
      if (item) out.push(item);
    }
  }
}

function requiredBranch(value) {
  requireCondition(
    typeof value === "string" && /^[A-Za-z0-9._/-]{1,200}$/.test(value),
    "GitHub did not give a default branch. Set branches.",
  );
  return value;
}

/** Merges rows with one ID (a commit on two branches) so the output has each ID once. */
function uniqueItems(items) {
  const byId = new Map();
  for (const item of items) {
    const known = byId.get(item.id);
    if (!known) byId.set(item.id, item);
    else if (Array.isArray(known.branches)) {
      for (const branch of item.branches) if (!known.branches.includes(branch)) known.branches.push(branch);
    }
  }
  return [...byId.values()];
}

/** One read-only pass over everything switched on. The host dedups across runs. */
export async function runWatcher(
  input,
  { token = process.env.GITHUB_TOKEN, fetchImpl = fetch, store = cooldownStore, now = () => Date.now() } = {},
) {
  const accessToken = readToken(token);
  const config = readConfiguration(input);
  requireCondition(
    (await store.read(config.instanceId)) <= now(),
    "GitHub API cooldown is active; no request was sent.",
  );
  const sinceMs = readWindow(input, now());
  const client = createClient({
    base: config.apiBase,
    token: accessToken,
    fetchImpl,
    store,
    instanceId: config.instanceId,
    now,
    maxRequests: config.maxRequests,
  });

  // The token must belong to the configured account, so this check cannot read another one.
  const { body: user } = await client.get("/user", {}, { denied: "GitHub did not allow reading the token owner." });
  requireCondition(
    isObject(user) && typeof user.login === "string" && user.login.toLowerCase() === config.login.toLowerCase(),
    "The GitHub token does not belong to the configured login.",
  );

  const items = [];
  if (config.watchNotifications) {
    const rows = await client.list(
      "/notifications",
      {
        all: "false",
        participating: String(config.participatingOnly),
        since: iso(sinceMs),
      },
      {
        denied:
          "Cannot read notifications. They need a classic token with the notifications scope; turn off watchNotifications to use a fine-grained token.",
        label: "notifications",
      },
    );
    for (const row of rows) items.push(notificationItem(row));
  }
  for (const repo of config.repos) await collectRepository(client, config, repo, sinceMs, items);

  const unique = uniqueItems(items);
  requireCondition(unique.length <= MAX_ITEMS, "More than 2000 items changed. Narrow the settings.");
  const output = { items: unique, hasNextPage: false, cursor: null };
  requireCondition(
    Buffer.byteLength(JSON.stringify(output)) <= MAX_OUTPUT_BYTES,
    "The result exceeds the safe size limit. Narrow the settings.",
  );
  return output;
}

async function main() {
  try {
    let stdin = "";
    for await (const chunk of process.stdin) {
      stdin += chunk.toString("utf8");
      requireCondition(Buffer.byteLength(stdin) <= MAX_INPUT_BYTES, "Watcher input exceeds the safe size limit.");
    }
    let input;
    try {
      input = JSON.parse(stdin);
    } catch {
      throw new WatcherError("Invalid watcher input JSON.");
    }
    process.stdout.write(JSON.stringify(await runWatcher(input)));
  } catch (error) {
    process.stderr.write(
      `GitHub activity watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
