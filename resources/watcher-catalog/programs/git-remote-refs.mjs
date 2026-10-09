import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GIT_TIMEOUT_MS = 25000;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_BYTES = 65536;
const MAX_ITEMS = 2000;
// The host stops at 512,000 bytes. Keep a margin for the wrapper object.
const MAX_OUTPUT_BYTES = 450000;
const MAX_LIST_ENTRIES = 50;
const MAX_REF_LENGTH = 300;
const SHORT_SHA_LENGTH = 7;
// Explicit uncertainty marker, never a user identity. `git ls-remote` cannot tell who pushed.
export const UNKNOWN_ACTOR = "unknown";

export function hasControl(text) {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

const ERROR_CODES = ["auth", "rate_limited", "config", "upstream"];

/** A failure with fixed wording. The optional code is one of ERROR_CODES; OpenBot maps it to its own text. */
class WatcherError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = ERROR_CODES.includes(code) ? code : null;
  }
}

function requireCondition(condition, message, code = null) {
  if (!condition) throw new WatcherError(message, code);
}

/** Runs a reader of settings. A failure without a code gets this code, so each check of a setting needs none. */
function tagged(code, read) {
  try {
    return read();
  } catch (error) {
    if (error instanceof WatcherError && error.code === null) error.code = code;
    throw error;
  }
}

function optionalString(value, name, maxLength) {
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

function readList(value, name) {
  const entries = optionalString(value, name, 8192)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  requireCondition(entries.length <= MAX_LIST_ENTRIES, `${name} has too many entries.`);
  return entries;
}

function readRepoUrl(value, allowFile) {
  const raw = optionalString(value, "repoUrl", 2048);
  requireCondition(raw.length > 0, "Missing or invalid repoUrl.");
  requireCondition(!/[\s\\]/.test(raw) && !hasControl(raw), "repoUrl must not contain spaces or control characters.");
  // `testOnlyAllowFileUrl` is a function argument. Nothing in stdin or the environment can set it.
  if (allowFile && raw.startsWith("file:///")) return raw;
  requireCondition(raw.startsWith("https://"), "repoUrl must start with https://.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WatcherError("repoUrl is not a valid address.");
  }
  requireCondition(url.protocol === "https:" && url.hostname.length > 0, "repoUrl must start with https://.");
  const authority = raw.slice("https://".length).split(/[/?#]/)[0];
  requireCondition(
    !url.username && !url.password && !authority.includes("@"),
    "repoUrl must not contain credentials. Use the username setting and the GIT_ACCESS_TOKEN private variable.",
  );
  requireCondition(!url.search && !url.hash, "repoUrl must not contain a query or a fragment.");
  return raw;
}

function readUsername(value) {
  const username = optionalString(value, "username", 128) || "git";
  requireCondition(
    !username.includes(":") && !hasControl(username),
    "username must not contain a colon or control characters.",
  );
  return username;
}

function readPrefixes(value) {
  const prefixes = readList(value, "refPrefixes");
  if (prefixes.length === 0) return ["refs/heads/"];
  for (const prefix of prefixes) {
    requireCondition(
      prefix.length <= 100 && /^refs\/[A-Za-z0-9._/-]*$/.test(prefix),
      "refPrefixes must be refs/ paths such as refs/heads/.",
    );
  }
  return prefixes;
}

function readIgnorePatterns(value) {
  const patterns = readList(value, "ignorePatterns");
  for (const pattern of patterns) requireCondition(pattern.length <= 200, "An ignore pattern is too long.");
  return patterns;
}

function readConfiguration(input, { allowFile }) {
  requireCondition(input && typeof input === "object" && !Array.isArray(input), "Expected a JSON object.");
  const prefixes = readPrefixes(input.refPrefixes);
  const includeTags = readBoolean(input.includeTags, "includeTags", false);
  if (includeTags && !prefixes.some((prefix) => "refs/tags/".startsWith(prefix) || prefix.startsWith("refs/tags/"))) {
    prefixes.push("refs/tags/");
  }
  return {
    repoUrl: readRepoUrl(input.repoUrl, allowFile),
    username: readUsername(input.username),
    prefixes,
    ignorePatterns: readIgnorePatterns(input.ignorePatterns),
  };
}

function readToken(token) {
  if (token === undefined || token === null || token === "") return null;
  requireCondition(
    typeof token === "string" && /^[!-~]{1,4096}$/.test(token.trim()),
    "Invalid GIT_ACCESS_TOKEN private variable.",
  );
  return token.trim();
}

/** Glob match with `*` (any text, including `/`) and `?` (one character). Linear, no backtracking blowup. */
export function globMatches(pattern, text) {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** Which transport flags can be used. A prefix outside heads and tags needs the full list. */
function listFlags(prefixes) {
  let heads = false;
  let tags = false;
  let other = false;
  for (const prefix of prefixes) {
    if (prefix.startsWith("refs/heads/")) heads = true;
    else if (prefix.startsWith("refs/tags/")) tags = true;
    else other = true;
  }
  if (other) return [];
  return [...(heads ? ["--heads"] : []), ...(tags ? ["--tags"] : [])];
}

/**
 * The only child process this program starts. stderr is discarded, so server text can never reach
 * a log. Resolves with a plain result and never rejects.
 */
export function runCommand(command, args, { env, cwd, timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env, cwd, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve({ status: null, stdout: "", timedOut: false, tooLarge: false, failedToStart: true });
      return;
    }
    const chunks = [];
    let size = 0;
    let timedOut = false;
    let tooLarge = false;
    let failedToStart = false;
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(chunks).toString("utf8"), timedOut, tooLarge, failedToStart });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        tooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => {
      failedToStart = true;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

function authorizationHeader(username, token) {
  return `Authorization: Basic ${Buffer.from(`${username}:${token}`, "utf8").toString("base64")}`;
}

/** A fresh environment. Nothing is inherited, so no provider key or proxy setting reaches git. */
function gitEnvironment({ home, baseEnv, username, token, allowFile }) {
  const settings = [["http.followRedirects", "false"]];
  // A token is only ever sent to the exact address. Git must not follow a redirect to another host with it.
  if (token) settings.push(["http.extraHeader", authorizationHeader(username, token)]);
  const env = {
    PATH: baseEnv.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: baseEnv.LANG || "C.UTF-8",
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: allowFile ? "file" : "https",
    GIT_CONFIG_COUNT: String(settings.length),
  };
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

const REF_LINE = /^([0-9a-f]{40}|[0-9a-f]{64})\t(refs\/[^\s]+)$/;

function parseRefs(stdout) {
  const refs = new Map();
  const peeled = new Map();
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const match = REF_LINE.exec(line);
    requireCondition(match, "git returned output that could not be read.");
    const [, sha, name] = match;
    if (name.endsWith("^{}")) peeled.set(name.slice(0, -3), sha);
    else {
      requireCondition(!refs.has(name), "git returned the same ref twice.");
      refs.set(name, sha);
    }
  }
  // An annotated tag points at a tag object. The commit it names is the better revision.
  for (const [name, sha] of peeled) if (refs.has(name)) refs.set(name, sha);
  return refs;
}

function refKind(ref) {
  if (ref.startsWith("refs/heads/")) return "branch";
  if (ref.startsWith("refs/tags/")) return "tag";
  return "ref";
}

function shortName(ref) {
  for (const prefix of ["refs/heads/", "refs/tags/"]) if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  return ref;
}

function describeRepository(repoUrl) {
  try {
    const url = new URL(repoUrl);
    return `${url.host}${url.pathname}`.slice(0, 200);
  } catch {
    return "";
  }
}

function buildItems(refs, config) {
  const items = [];
  for (const [ref, sha] of [...refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!config.prefixes.some((prefix) => ref.startsWith(prefix))) continue;
    const name = shortName(ref);
    if (config.ignorePatterns.some((pattern) => globMatches(pattern, name) || globMatches(pattern, ref))) continue;
    requireCondition(ref.length <= MAX_REF_LENGTH, "A ref name is too long to report safely.");
    items.push({
      id: ref,
      revision: sha,
      actor: UNKNOWN_ACTOR,
      kind: refKind(ref),
      name,
      shortSha: sha.slice(0, SHORT_SHA_LENGTH),
      repository: describeRepository(config.repoUrl),
    });
  }
  return items;
}

/** One read-only `git ls-remote`. The result is the current ref list, not a history. */
export async function runWatcher(
  input,
  {
    token = process.env.GIT_ACCESS_TOKEN,
    run = runCommand,
    baseEnv = process.env,
    tempRoot = os.tmpdir(),
    testOnlyAllowFileUrl = false,
  } = {},
) {
  const config = tagged("config", () => readConfiguration(input, { allowFile: testOnlyAllowFileUrl === true }));
  const accessToken = tagged("auth", () => readToken(token));
  const home = await fs.mkdtemp(path.join(tempRoot, "git-remote-refs-"));
  let result;
  try {
    const env = gitEnvironment({
      home,
      baseEnv,
      username: config.username,
      token: accessToken,
      allowFile: testOnlyAllowFileUrl === true,
    });
    result = await run("git", ["ls-remote", ...listFlags(config.prefixes), "--", config.repoUrl], {
      env,
      cwd: home,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: MAX_GIT_OUTPUT_BYTES,
    });
  } catch {
    throw new WatcherError("git could not be run.", "upstream");
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
  // Only these fixed messages may reach stderr. git and server text is never repeated.
  requireCondition(!result.failedToStart, "git could not be started.", "upstream");
  requireCondition(!result.timedOut, "git ls-remote timed out.", "upstream");
  requireCondition(!result.tooLarge, "The remote ref list exceeds the safe size limit. Narrow refPrefixes.", "config");
  requireCondition(
    result.status === 0,
    "Could not read the repository. Check repoUrl (use the exact address, usually ending in .git), username and the access token.",
  );
  requireCondition(typeof result.stdout === "string", "git returned output that could not be read.");
  const items = buildItems(parseRefs(result.stdout), config);
  requireCondition(
    items.length <= MAX_ITEMS,
    "The repository has more than 2000 matching refs. Narrow refPrefixes or add ignorePatterns.",
    "config",
  );
  const output = { items, hasNextPage: false, cursor: null };
  requireCondition(
    Buffer.byteLength(JSON.stringify(output)) <= MAX_OUTPUT_BYTES,
    "The ref list exceeds the safe size limit. Narrow refPrefixes or add ignorePatterns.",
    "config",
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
      `Git remote refs watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    // One code, no text from git or the server: OpenBot maps it to its own message.
    if (error instanceof WatcherError && error.code) process.stderr.write(`openbot-error: ${error.code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
