#!/usr/bin/env node
// render-sites: a helper that publishes static landing pages on Render.com, for OpenBot agents.
// It has no dependencies and runs on Node.js 18 or later. Every answer is JSON on standard output.
// Errors are JSON on standard error. The three keys (Render, Cloudflare, GitHub) are read from files
// and are never printed. It pushes a landing's files to GitHub, creates the Render static site,
// waits for the deploy, adds custom domains with Cloudflare DNS records, and writes every change to
// an audit log. Run `node render-sites.mjs help` for the commands. The openbot-render-sites skill
// explains the use.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Sources (checked 2026-11-18):
// Render: api-docs.render.com (OpenAPI render-public-api-1.json): Bearer key, cursor/limit pages of
//   [{cursor, <item>}], POST /services answers {service, deployId}, custom domains answer an array
//   (Render adds the www or apex twin), POST .../verify answers 202, deploy statuses below.
//   render.com/docs/monorepo-support: with a root directory, the build command and the publish path
//   are relative to it, and a push deploys only when it changes files under it.
//   render.com/docs/configure-cloudflare-dns: CNAME to <site>.onrender.com, also at the apex
//   (Cloudflare flattens it), "DNS only" until Render issues the certificate, then optionally
//   proxied with SSL/TLS mode Full. render.com/docs/regions: static sites have no region (global CDN).
// Cloudflare: developers.cloudflare.com/api: GET /zones (per_page max 50), GET/POST/PATCH/DELETE
//   /zones/{id}/dns_records, filters such as name.exact and comment.exact; record comments hold at
//   most 100 characters on the Free plan.
// GitHub: docs.github.com/rest: POST /user/repos or /orgs/{org}/repos (Administration or Repository
//   creation: write), the Git database API (blobs, trees, commits, refs; Contents: write).
const RENDER_BASE_URL = "https://api.render.com";
const CLOUDFLARE_BASE_URL = "https://api.cloudflare.com";
const GITHUB_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const REQUEST_TIMEOUT_MS = 60_000;
const MARKER_PREFIX = "openbot-render:";
const EXIT = { ok: 0, error: 1, usage: 2, refused: 3, rateLimited: 4, timeout: 5 };
const DEPLOY_DONE = new Set(["live", "deactivated", "build_failed", "update_failed", "canceled", "pre_deploy_failed"]);
const DEPLOY_FAILED = new Set(["build_failed", "update_failed", "canceled", "pre_deploy_failed"]);
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// Files that hold secrets by their name. `.env.example` and `.env.sample` are allowed.
const SECRET_FILE_NAMES = [
  /^\.env(\.(?!example$|sample$)[^/]*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^credentials(\.json)?$/i,
];
// Values that look like a key. Checked in each text file before it leaves.
const SECRET_PATTERNS = [
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["Render API key", /\brnd_[A-Za-z0-9]{20,}\b/],
  ["Stripe secret key", /\b(sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/],
  ["OpenAI or Anthropic key", /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{32,}\b/],
];
const SKIPPED_FOLDERS = new Set([".git", "node_modules", ".openbot", ".cache"]);
const SKIPPED_FILES = new Set([".DS_Store", "Thumbs.db"]);
const BOOLEAN_FLAGS = new Set([
  "approved",
  "dry-run",
  "help",
  "no-wait",
  "clear-cache",
  "proxied",
  "dns-only",
  "keep-dns",
  "skip-tls-check",
  "all",
  "force",
]);
const REPEATABLE = new Set(["env", "unset-env"]);

const HELP = `render-sites: publish static landing pages on Render.com, with Cloudflare DNS (JSON output).

Setup and reading
  help                                   This text.
  config show | config set <key> <value> Settings: ownerId, githubOwner, repoMode (monorepo|repo-per-site),
                                         landingsRepo, sitesFolder, branch, privateRepos (true|false),
                                         buildCommand, publishPath, proxied (true|false). "none" clears a value.
  whoami                                 Checks each key: the Render user, the GitHub user, the Cloudflare zones.
  owners                                 Render workspaces (ownerId for config set ownerId).
  zones                                  The Cloudflare zones that the token can see.
  sites [--all]                          Static sites of the workspace (--all: of every workspace).
  site <site>                            One site: URL, repo, folder, domains, headers, routes, last deploy.
  deploys <site> [--limit N]             The last deploys.
  deploy-status <site> [<deployId>]      One deploy (default: the last one).
  wait <site> [<deployId>] [--timeout S] Waits until the deploy is live or failed (default 600 seconds).
  logs <site> [--limit N]                Build logs, when Render gives them through the API.
  dns <site>                             The Cloudflare records that this helper made for the site.
  audit [--tail N]                       The last changes from the audit log.

Changes (add --reason; --dry-run shows the plan and changes nothing)
  create <name> --dir <folder> [--repo owner/name] [--root-dir path] [--branch B]
         [--build-command CMD] [--publish-path P] [--no-wait] [--timeout S] [--message TEXT]
                                         Pushes the folder to GitHub, creates the static site, waits for the
                                         first deploy. <name> is lower case letters, digits and dashes.
  deploy <site> [--dir <folder>] [--clear-cache] [--no-wait] [--message TEXT] [--force]
                                         With --dir: pushes the new files (Render deploys the commit).
                                         Without: deploys the last commit again.
  update <site> [--build-command CMD] [--publish-path P] [--branch B] [--root-dir P] [--auto-deploy on|off]
         [--env KEY=VALUE]... [--unset-env KEY]... [--headers @file.json] [--routes @file.json]
                                         --headers and --routes replace all rules of the site.
  suspend <site> --approved              Takes the site offline. resume <site> brings it back.
  delete <site> --approved [--keep-dns]  Deletes the Render site and the DNS records this helper made.
                                         The files stay in GitHub.
  domain add <site> <hostname> [--proxied | --dns-only] [--no-wait] [--timeout S] [--skip-tls-check]
                                         Adds the domain on Render, a CNAME in Cloudflare, and verifies.
  domain list <site>                     Render's domains with their DNS records.
  domain verify <site> <hostname> [--no-wait] [--timeout S]
  domain proxy <site> <hostname> on|off [--skip-tls-check]
                                         Turns the Cloudflare proxy on (after the certificate) or off.
  domain remove <site> <hostname> --approved
                                         Removes the domain from Render and its record from Cloudflare.

<site> is a Render service ID (srv-...) or the site name.

Common options
  --render-key-file P, --cloudflare-token-file P, --github-token-file P
                        Key files (default: RENDER_API_KEY_FILE, CLOUDFLARE_API_TOKEN_FILE, GITHUB_TOKEN_FILE,
                        or the RENDER_API_KEY, ... values).
  --home DIR            Settings and audit folder (default: RENDER_SITES_HOME, else <space shared>/render-sites).
  --owner ID            Render workspace for one command.
  --approved            The person asked for this change (delete, suspend, domain remove).
  --reason TEXT         Why, for the audit log. --actor NAME (or RENDER_SITES_ACTOR) says who.
  --max-wait SECONDS    The longest rate-limit wait before failing (default 120).

Exit codes: 0 ok, 1 error, 2 usage, 3 refused (needs --approved), 4 rate limited, 5 timed out (still running).
`;

class CliError extends Error {
  constructor(message, { exit = EXIT.error, details = undefined } = {}) {
    super(message);
    this.exit = exit;
    this.details = details;
  }
}

/** An answer from Render, Cloudflare or GitHub that is not a success. */
class ApiError extends Error {
  constructor(service, status, body, method, path) {
    super(apiMessage(service, body) ?? `${service} API HTTP ${status}`);
    this.service = service;
    this.status = status;
    this.body = body;
    this.method = method;
    this.path = path;
    this.code = apiCode(service, body);
  }
}

function apiMessage(service, body) {
  if (!body || typeof body !== "object") return null;
  if (service === "Cloudflare") {
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const text = errors.map((error) => `${error?.code ?? ""} ${error?.message ?? ""}`.trim()).join("; ");
    return text || null;
  }
  return typeof body.message === "string" ? body.message : null;
}

function apiCode(service, body) {
  if (!body || typeof body !== "object") return null;
  if (service === "Cloudflare") return body.errors?.[0]?.code ?? null;
  return typeof body.code === "string" ? body.code : null;
}

// ---------- arguments ----------

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  const put = (name, value) => {
    if (!REPEATABLE.has(name)) options[name] = value;
    else if (Array.isArray(options[name])) options[name].push(value);
    else options[name] = [value];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(2, equals) : arg.slice(2);
    if (equals > 0) put(name, arg.slice(equals + 1));
    else if (BOOLEAN_FLAGS.has(name)) options[name] = true;
    else {
      const value = argv[index + 1];
      if (value === undefined) throw new CliError(`--${name} needs a value.`, { exit: EXIT.usage });
      put(name, value);
      index += 1;
    }
  }
  return { positional, options };
}

function readJsonOption(options, name) {
  const value = options[name];
  if (value === undefined) return undefined;
  let text = String(value);
  if (text.startsWith("@")) {
    try {
      text = readFileSync(text.slice(1), "utf8");
    } catch {
      throw new CliError(`Cannot read the file of --${name}.`, { exit: EXIT.usage });
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`--${name} must be JSON (or @file with JSON).`, { exit: EXIT.usage });
  }
}

/** A landing name: the Render site name, its folder and (one repo per site) its repository. */
export function siteName(value) {
  const text = String(value ?? "").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(text))
    throw new CliError("The name must be 1 to 63 lower case letters, digits and dashes, like black-friday-promo.", {
      exit: EXIT.usage,
    });
  return text;
}

/** A host name such as promo.example.com, in lower case, with no scheme, path or final dot. */
export function hostname(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const labels = text.split(".");
  const valid =
    text.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    !/^[0-9]+$/.test(labels.at(-1));
  if (!valid)
    throw new CliError(
      "The hostname must look like promo.example.com (no https://, no path). Use punycode for other alphabets.",
      { exit: EXIT.usage },
    );
  return text;
}

function repoSpec(value) {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(String(value ?? "").trim());
  if (!match || match[2] === "." || match[2] === "..")
    throw new CliError("--repo must look like owner/name.", { exit: EXIT.usage });
  return { owner: match[1], name: match[2] };
}

/** A folder path inside the repository: relative, with / and no . or .. parts. "" is the root. */
export function repoFolder(value, name = "--root-dir") {
  const text = String(value ?? "")
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  if (text === "" || text === ".") return "";
  const parts = text.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || /[\\:*?"<>|]/.test(part)))
    throw new CliError(`${name} must be a folder inside the repository, like sites/promo.`, { exit: EXIT.usage });
  return parts.join("/");
}

function timeoutSeconds(options, fallback) {
  if (options.timeout === undefined) return fallback;
  const value = Number(options.timeout);
  if (!Number.isFinite(value) || value < 0 || value > 7200)
    throw new CliError("--timeout must be a number of seconds from 0 to 7200.", { exit: EXIT.usage });
  return value;
}

function limitOption(options, fallback, max = 100) {
  if (options.limit === undefined) return fallback;
  const value = Number(options.limit);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new CliError(`--limit must be a whole number from 1 to ${max}.`, { exit: EXIT.usage });
  return value;
}

// ---------- settings, keys and audit ----------

/**
 * The shared folder of the space of the agent that runs this helper, and whether it is General's, or null. OpenBot keeps one shared
 * folder per space; an agent runs its commands in its workspace, `OpenBot/Agents/<agent id>`, and
 * `OpenBot/Spaces/index.json` names the shared folder of each agent's space.
 */
function spaceSharedFolder() {
  const parts = process.cwd().split(sep);
  const agents = parts.lastIndexOf("Agents");
  if (agents > 0 && parts[agents + 1]) {
    try {
      const index = JSON.parse(
        readFileSync(join(parts.slice(0, agents).join(sep) || sep, "Spaces", "index.json"), "utf8"),
      );
      const folder = index?.agents?.[parts[agents + 1]] ?? index?.general;
      if (typeof folder === "string" && folder) return { folder, general: folder === index?.general };
    } catch {
      // No index: an OpenBot before spaces.
    }
  }
  const spaces = parts.lastIndexOf("Spaces");
  if (spaces > 0 && parts[spaces + 2] === "Shared")
    return { folder: parts.slice(0, spaces + 3).join(sep), general: parts[spaces + 1] === "general" };
  return null;
}

function defaultHome() {
  if (process.env.RENDER_SITES_HOME) return process.env.RENDER_SITES_HOME;
  const space = spaceSharedFolder();
  if (space) return join(space.folder, "render-sites");
  // An OpenBot before spaces: the server image keeps the shared folder here; on a computer it is ~/OpenBot/Shared.
  return existsSync("/data/OpenBot/Shared")
    ? "/data/OpenBot/Shared/render-sites"
    : join(homedir(), "OpenBot", "Shared", "render-sites");
}

const DEFAULT_SETTINGS = {
  ownerId: "",
  githubOwner: "",
  repoMode: "monorepo",
  landingsRepo: "landings",
  sitesFolder: "sites",
  branch: "main",
  privateRepos: true,
  buildCommand: "",
  publishPath: ".",
  proxied: false,
};

function loadSettings(home) {
  const path = join(home, "settings.json");
  if (!existsSync(path)) return structuredClone(DEFAULT_SETTINGS);
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    throw new CliError(`The settings file ${path} is not valid JSON. Fix it or remove it.`);
  }
}

function writePrivate(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

function saveSettings(home, settings) {
  mkdirSync(home, { recursive: true });
  writePrivate(join(home, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

const KEYS = {
  render: { name: "RENDER_API_KEY", flag: "render-key-file" },
  cloudflare: { name: "CLOUDFLARE_API_TOKEN", flag: "cloudflare-token-file" },
  github: { name: "GITHUB_TOKEN", flag: "github-token-file" },
};

/** A key from its file (or its value in the environment), or null when none is given. */
function optionalKey(options, which) {
  const { name, flag } = KEYS[which];
  const file = options[flag] ?? process.env[`${name}_FILE`];
  let value;
  if (file) {
    try {
      value = readFileSync(String(file), "utf8").trim();
    } catch {
      throw new CliError(`Cannot read the ${name} file. Check the path from openbot.list_api_keys.`, {
        details: { key: name, hint: `Set ${name}_FILE to the path of the shared key ${name}.` },
      });
    }
  } else value = (process.env[name] ?? "").trim();
  if (!value) return null;
  if (/\s/.test(value)) throw new CliError(`${name} must hold one value with no spaces.`);
  return value;
}

function requiredKey(options, which) {
  const value = optionalKey(options, which);
  if (value) return value;
  const { name, flag } = KEYS[which];
  throw new CliError(`No ${name}.`, {
    details: {
      key: name,
      hint: `Set ${name}_FILE to the path of the shared key ${name} (openbot.list_api_keys), or pass --${flag}. If the key is not saved, ask the user with openbot.request_api_key (name "${name}", shared: true).`,
    },
  });
}

function auditPath(home) {
  return join(home, "audit.jsonl");
}

function appendAudit(home, entry) {
  mkdirSync(home, { recursive: true });
  appendFileSync(auditPath(home), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

function readAudit(home) {
  const path = auditPath(home);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

// ---------- HTTP ----------

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/** An origin from an environment override: https, or http on this computer for tests. */
function baseOverride(name, fallback) {
  const override = process.env[name];
  if (!override) return fallback;
  let url;
  try {
    url = new URL(override);
  } catch {
    throw new CliError(`${name} is not a valid address.`);
  }
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new CliError(`${name} must use https.`);
  return url.origin;
}

/** Seconds to wait from Retry-After, or from RateLimit-Reset (seconds left, or an epoch time). */
function retrySeconds(headers) {
  const after = Number(headers?.get?.("retry-after"));
  if (Number.isFinite(after) && after >= 0) return after;
  const reset = Number(headers?.get?.("ratelimit-reset") ?? headers?.get?.("x-ratelimit-reset"));
  if (!Number.isFinite(reset) || reset < 0) return null;
  return reset > 1e9 ? Math.max(0, Math.ceil(reset - Date.now() / 1000)) : reset;
}

class Api {
  constructor({ service, base, prefix, key, headers, maxWaitSeconds, backoffBaseMs }) {
    this.service = service;
    this.base = base;
    this.prefix = prefix;
    this.key = key;
    this.headers = headers;
    this.maxWaitSeconds = maxWaitSeconds;
    this.backoffBaseMs = backoffBaseMs;
    this.waitedSeconds = 0;
  }

  url(path, query = {}) {
    const url = new URL(`${this.base}${this.prefix}${path}`);
    if (url.origin !== this.base)
      throw new CliError(`A request address left the ${this.service} API host; it was not sent.`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
    return url;
  }

  /** One request. Answers {status, body, headers}. Reads repeat after a network or 5xx error. */
  async request(method, path, { query = {}, body = undefined, allow = [] } = {}) {
    const url = this.url(path, query);
    for (let attempt = 0; ; attempt += 1) {
      let response;
      let text;
      try {
        response = await fetch(url, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${this.key}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...this.headers,
          },
        });
        text = await response.text();
      } catch {
        // A change that timed out may have happened, so only a read is sent again.
        if (method === "GET" && attempt < 2) {
          await sleep(this.backoffBaseMs * 2 ** attempt);
          continue;
        }
        throw new CliError(`The ${this.service} API did not answer (network error or timeout).`);
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (response.ok || allow.includes(response.status))
        return { status: response.status, body: json, headers: response.headers };
      const limited =
        response.status === 429 ||
        (response.status === 403 && this.service === "GitHub" && /rate limit/i.test(String(json?.message ?? "")));
      if (limited) {
        const wait = Math.max(retrySeconds(response.headers) ?? 0, (this.backoffBaseMs / 1000) * 2 ** attempt);
        if (attempt >= 5 || this.waitedSeconds + wait > this.maxWaitSeconds)
          throw new CliError(
            `${this.service} rate limit reached. Wait ${Math.max(1, Math.ceil(wait / 60))} minute(s), then try again.`,
            { exit: EXIT.rateLimited, details: { service: this.service, status: response.status } },
          );
        this.waitedSeconds += wait;
        await sleep(wait * 1000);
        continue;
      }
      if (method === "GET" && [500, 502, 503, 504].includes(response.status) && attempt < 2) {
        await sleep(this.backoffBaseMs * 2 ** attempt);
        continue;
      }
      throw new ApiError(this.service, response.status, json, method, path);
    }
  }

  async get(path, query) {
    return (await this.request("GET", path, { query })).body;
  }

  async send(method, path, body) {
    return (await this.request(method, path, { body })).body;
  }
}

class Render extends Api {
  /** Every item of a Render list: arrays of {cursor, <key>}, next page from the last cursor. */
  async list(path, key, query = {}, max = 1000) {
    const rows = [];
    let cursor;
    for (;;) {
      const page = await this.get(path, { ...query, limit: 100, cursor });
      if (!Array.isArray(page)) throw new CliError("Render sent an unexpected list answer.");
      for (const entry of page) if (entry?.[key]) rows.push(entry[key]);
      const last = page.at(-1)?.cursor;
      if (rows.length >= max || page.length < 100 || typeof last !== "string" || !last) return rows.slice(0, max);
      cursor = last;
    }
  }
}

class Cloudflare extends Api {
  async call(method, path, { query, body, allow } = {}) {
    const { status, body: json } = await this.request(method, path, { query, body, allow });
    if (json && json.success === false) throw new ApiError("Cloudflare", status, json, method, path);
    return json?.result ?? null;
  }

  /** Every item of a Cloudflare list (page and per_page, result_info.total_pages). */
  async list(path, query = {}, perPage = 50) {
    const rows = [];
    for (let page = 1; page <= 200; page += 1) {
      const { body } = await this.request("GET", path, { query: { ...query, page, per_page: perPage } });
      const result = Array.isArray(body?.result) ? body.result : [];
      rows.push(...result);
      const pages = Number(body?.result_info?.total_pages);
      if (result.length < perPage || (Number.isFinite(pages) && page >= pages)) break;
    }
    return rows;
  }
}

// ---------- errors ----------

/** The steps the user takes once so that Render can read a GitHub repository. */
function repoAccessSteps(repo) {
  const settings =
    repo.ownerType === "org"
      ? `https://github.com/organizations/${repo.owner}/settings/installations`
      : "https://github.com/settings/installations";
  return [
    `Render cannot read github.com/${repo.owner}/${repo.name}. The user must give Render's GitHub app access once:`,
    `1. Open ${settings} and choose Configure next to Render.`,
    `2. Under Repository access, add ${repo.owner}/${repo.name} (or choose All repositories, needed when each landing has its own repository). Save.`,
    "3. If Render is not in that list: in the Render dashboard choose New > Static Site > Connect GitHub (or Account settings > Git credentials) and install the app on this account or organization, then do step 2.",
    "Then run the same command again.",
  ].join("\n");
}

function looksLikeRepoAccess(error) {
  return (
    error instanceof ApiError &&
    error.service === "Render" &&
    [400, 401, 403, 404, 422].includes(error.status) &&
    /repo|repository|github|git provider|git credential|installation|access/i.test(error.message)
  );
}

function describeApiError(error) {
  const hints = {
    Render: {
      401: "The Render API key is not valid. Ask the user for a new key with openbot.request_api_key (RENDER_API_KEY).",
      402: "Render wants a payment method or a higher plan for this (for example more custom domains).",
      403: "The Render key may not do this in this workspace. Check ownerId (render-sites owners).",
      404: "Render did not find this. Check the site ID or name.",
      409: "It already exists on Render (a site name or a domain). Use another name, or the existing one.",
    },
    Cloudflare: {
      400: "Cloudflare refused the request. Read the message.",
      401: "The Cloudflare token is not valid. Ask the user for a new one (CLOUDFLARE_API_TOKEN).",
      403: "The Cloudflare token may not do this. It needs Zone > Zone > Read and Zone > DNS > Edit on this zone.",
      404: "Cloudflare did not find this zone or record.",
    },
    GitHub: {
      401: "The GitHub token is not valid or expired. Ask the user for a new one (GITHUB_TOKEN).",
      403: "The GitHub token may not do this. It needs Contents: Read and write on the repository (and Administration: write to create one).",
      404: "GitHub did not find the repository, or the token cannot see it. Check githubOwner and the token's repository access.",
      409: "The repository is empty or the branch moved. Run the command again.",
      422: "GitHub refused the request (for example the repository name exists). Read the message.",
    },
  };
  let hint = hints[error.service]?.[error.status] ?? null;
  if (!hint && error.status >= 500) hint = `${error.service} had an internal error. Try again later.`;
  return {
    service: error.service,
    status: error.status,
    code: error.code,
    message: error.message,
    request: `${error.method} ${error.path}`,
    hint,
  };
}

// ---------- local files ----------

function gitBlobSha(buffer) {
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

function isText(buffer) {
  return !buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}

/**
 * The files of a landing folder, with their git blob IDs. Refuses secret files, values that look like
 * keys, the helper's own keys, symbolic links that leave the folder, and folders that are too large.
 */
export function readLanding(folder, keys = []) {
  let root;
  try {
    root = realpathSync(resolve(folder));
  } catch {
    throw new CliError(`The folder ${folder} does not exist.`, { exit: EXIT.usage });
  }
  if (!lstatSync(root).isDirectory()) throw new CliError(`${folder} is not a folder.`, { exit: EXIT.usage });
  const files = [];
  const refused = [];
  const skipped = [];
  let total = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        skipped.push({ path: name, why: "symbolic link" });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIPPED_FOLDERS.has(entry.name)) skipped.push({ path: `${name}/`, why: "not published" });
        else walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIPPED_FILES.has(entry.name)) continue;
      if (SECRET_FILE_NAMES.some((pattern) => pattern.test(entry.name))) {
        refused.push({ path: name, why: "a file of this name usually holds secrets" });
        continue;
      }
      const stats = lstatSync(path);
      if (stats.size > MAX_FILE_BYTES) {
        refused.push({ path: name, why: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` });
        continue;
      }
      total += stats.size;
      if (files.length >= MAX_FILES || total > MAX_TOTAL_BYTES)
        throw new CliError(
          `The folder is too large (more than ${MAX_FILES} files or ${MAX_TOTAL_BYTES / 1024 / 1024} MB). Publish only the built site.`,
          { exit: EXIT.usage },
        );
      const content = readFileSync(path);
      if (isText(content)) {
        const text = content.toString("utf8");
        const found = SECRET_PATTERNS.find(([, pattern]) => pattern.test(text));
        if (found) refused.push({ path: name, why: `holds what looks like a ${found[0]}` });
        else if (keys.some((key) => key && key.length >= 8 && text.includes(key)))
          refused.push({ path: name, why: "holds one of the helper's own keys" });
      }
      files.push({ path: name, content, sha: gitBlobSha(content), executable: (stats.mode & 0o111) !== 0 });
    }
  };
  walk(root);
  if (refused.length > 0)
    throw new CliError("Some files must not be published. Remove them (or the secret in them) and try again.", {
      details: { refused, hint: "Never commit keys or passwords. Pages that need a key call a server, not the page." },
    });
  if (files.length === 0) throw new CliError(`The folder ${folder} has no files to publish.`, { exit: EXIT.usage });
  if (!files.some((file) => /(^|\/)index\.html?$/i.test(file.path)))
    skipped.push({ path: "index.html", why: "missing: a static site needs an index.html in its publish folder" });
  return { root, files, skipped, bytes: total };
}

// ---------- context ----------

function safeUser() {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

class Context {
  constructor(options) {
    this.options = options;
    this.home = String(options.home ?? defaultHome());
    this.settings = loadSettings(this.home);
    this.actor = String(options.actor ?? process.env.RENDER_SITES_ACTOR ?? safeUser());
    this.clients = {};
    this.keys = [];
    const maxWait = options["max-wait"] === undefined ? 120 : Number(options["max-wait"]);
    this.maxWaitSeconds = Number.isFinite(maxWait) && maxWait >= 0 ? maxWait : 120;
    this.backoffBaseMs = Number(process.env.RENDER_SITES_BACKOFF_BASE_MS) || 2000;
    this.pollMs = Number(process.env.RENDER_SITES_POLL_MS) || 5000;
  }

  /** Every key that a command read, for the redaction of its output. */
  remember(key) {
    if (key) this.keys.push(key);
    return key;
  }

  get render() {
    this.clients.render ??= new Render({
      service: "Render",
      base: baseOverride("RENDER_API_BASE_URL", RENDER_BASE_URL),
      prefix: "/v1",
      key: this.remember(requiredKey(this.options, "render")),
      headers: {},
      maxWaitSeconds: this.maxWaitSeconds,
      backoffBaseMs: this.backoffBaseMs,
    });
    return this.clients.render;
  }

  get cloudflare() {
    this.clients.cloudflare ??= new Cloudflare({
      service: "Cloudflare",
      base: baseOverride("CLOUDFLARE_API_BASE_URL", CLOUDFLARE_BASE_URL),
      prefix: "/client/v4",
      key: this.remember(requiredKey(this.options, "cloudflare")),
      headers: {},
      maxWaitSeconds: this.maxWaitSeconds,
      backoffBaseMs: this.backoffBaseMs,
    });
    return this.clients.cloudflare;
  }

  get github() {
    this.clients.github ??= new Api({
      service: "GitHub",
      base: baseOverride("GITHUB_API_BASE_URL", GITHUB_BASE_URL),
      prefix: "",
      key: this.remember(requiredKey(this.options, "github")),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "openbot-render-sites",
      },
      maxWaitSeconds: this.maxWaitSeconds,
      backoffBaseMs: this.backoffBaseMs,
    });
    return this.clients.github;
  }

  /** All keys that are set, read without failing, for the secret scan of a landing folder. */
  knownKeys() {
    const keys = [];
    for (const which of Object.keys(KEYS)) {
      try {
        keys.push(this.remember(optionalKey(this.options, which)));
      } catch {
        // A key file that cannot be read fails later, in the command that needs it.
      }
    }
    return keys.filter(Boolean);
  }

  audit(entry) {
    appendAudit(this.home, { actor: this.actor, reason: this.options.reason ?? null, ...entry });
  }

  /** Runs one change and writes it to the audit log, also when it fails. */
  async change(action, target, details, run) {
    try {
      const result = await run();
      this.audit({ action, target, details, result: "ok" });
      return result;
    } catch (error) {
      this.audit({
        action,
        target,
        details,
        result: "error",
        error: error instanceof ApiError ? { service: error.service, status: error.status } : String(error.message),
      });
      throw error;
    }
  }

  /** Refuses a change that the person must ask for, and writes the refusal to the audit log. */
  requireApproval(action, target, why) {
    if (this.options.approved === true) return;
    this.audit({ action, target, result: "refused", details: { why } });
    throw new CliError(`${action} needs --approved.`, {
      exit: EXIT.refused,
      details: {
        refused: true,
        why,
        hint: "Do this only when the user asked for it in this conversation. Confirm with openbot.ask_ui, then run the same command with --approved.",
      },
    });
  }

  async ownerId() {
    const chosen = this.options.owner ?? this.settings.ownerId;
    if (chosen) return String(chosen);
    const owners = await this.render.list("/owners", "owner");
    if (owners.length === 1) return owners[0].id;
    throw new CliError("Choose the Render workspace first.", {
      details: {
        owners: owners.map((owner) => ({ id: owner.id, name: owner.name, type: owner.type })),
        hint: "Ask the user which workspace to use, then: render-sites config set ownerId <id>.",
      },
    });
  }
}

// ---------- Render sites ----------

function siteRow(service) {
  const details = service?.serviceDetails ?? {};
  return {
    id: service?.id ?? null,
    name: service?.name ?? null,
    url: details.url ?? null,
    repo: service?.repo ?? null,
    branch: service?.branch ?? null,
    rootDir: service?.rootDir ?? "",
    buildCommand: details.buildCommand ?? null,
    publishPath: details.publishPath ?? null,
    autoDeploy: service?.autoDeployTrigger ?? service?.autoDeploy ?? null,
    suspended: service?.suspended === "suspended",
    dashboardUrl: service?.dashboardUrl ?? null,
    ownerId: service?.ownerId ?? null,
    updatedAt: service?.updatedAt ?? null,
  };
}

function deployRow(deploy) {
  return {
    id: deploy?.id ?? null,
    status: deploy?.status ?? null,
    trigger: deploy?.trigger ?? null,
    commit: deploy?.commit?.id ? { id: deploy.commit.id, message: deploy.commit.message ?? null } : null,
    createdAt: deploy?.createdAt ?? null,
    finishedAt: deploy?.finishedAt ?? null,
  };
}

/** The onrender.com host of a site, the target of its CNAME records. */
function renderHost(service) {
  const url = service?.serviceDetails?.url;
  try {
    const host = new URL(String(url)).hostname;
    if (host) return host;
  } catch {
    // Below.
  }
  if (service?.slug) return `${service.slug}.onrender.com`;
  throw new CliError("Render did not give the site's onrender.com address.");
}

async function findSite(context, value) {
  const text = String(value ?? "").trim();
  if (!text) throw new CliError("Name the site: its srv- ID or its name.", { exit: EXIT.usage });
  let service;
  if (/^srv-[a-z0-9]+$/i.test(text)) {
    try {
      service = await context.render.get(`/services/${encodeURIComponent(text)}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw new CliError(`Render has no site ${text}.`);
      throw error;
    }
  } else {
    const owner = context.options.owner ?? context.settings.ownerId;
    const matches = (
      await context.render.list("/services", "service", {
        name: text,
        type: "static_site",
        ownerId: owner || undefined,
      })
    ).filter((candidate) => candidate?.name === text);
    if (matches.length === 0)
      throw new CliError(`Render has no static site named ${text}.`, {
        details: { hint: "render-sites sites lists them." },
      });
    if (matches.length > 1)
      throw new CliError(`More than one site is named ${text}. Use its srv- ID.`, {
        details: { sites: matches.map(siteRow) },
      });
    service = matches[0];
  }
  if (service?.type && service.type !== "static_site")
    throw new CliError(
      `${text} is a Render ${service.type}, not a static site. This helper changes static sites only.`,
    );
  return service;
}

async function waitForDeploy(context, serviceId, deployId, timeout) {
  const end = Date.now() + timeout * 1000;
  for (;;) {
    const deploy = await context.render.get(
      `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
    );
    if (DEPLOY_DONE.has(deploy?.status) || Date.now() >= end) return deployRow(deploy);
    await sleep(Math.min(context.pollMs, Math.max(0, end - Date.now())));
  }
}

async function latestDeploy(context, serviceId) {
  const page = await context.render.get(`/services/${encodeURIComponent(serviceId)}/deploys`, { limit: 1 });
  return Array.isArray(page) ? (page[0]?.deploy ?? null) : null;
}

/** The deploy that Render started for a commit (auto-deploy), waited for a short time. */
async function deployForCommit(context, serviceId, sha) {
  const end = Date.now() + Math.max(context.pollMs * 12, 1000);
  for (;;) {
    const page = await context.render.get(`/services/${encodeURIComponent(serviceId)}/deploys`, { limit: 10 });
    const found = (Array.isArray(page) ? page : []).map((entry) => entry?.deploy).find((d) => d?.commit?.id === sha);
    if (found || Date.now() >= end) return found ?? null;
    await sleep(context.pollMs);
  }
}

/** The result of a deploy wait: an exit code for a failed or unfinished deploy. */
function deployOutcome(service, deploy, extra = {}) {
  const result = {
    site: { id: service.id, name: service.name, url: service.serviceDetails?.url ?? null },
    deploy,
    dashboardUrl: service.dashboardUrl ?? null,
    ...extra,
  };
  if (deploy && DEPLOY_FAILED.has(deploy.status))
    throw new CliError(`The deploy ended with ${deploy.status}.`, {
      details: {
        ...result,
        hint: "Read render-sites logs <site>, or the deploy in the dashboard. Fix the files or the build settings, then deploy again.",
      },
    });
  if (deploy && !DEPLOY_DONE.has(deploy.status))
    throw new CliError("The deploy is still running.", {
      exit: EXIT.timeout,
      details: { ...result, hint: `Run render-sites wait ${service.name} ${deploy.id}.` },
    });
  return result;
}

// ---------- GitHub ----------

async function githubOwner(context) {
  const configured = context.settings.githubOwner;
  const me = await context.github.get("/user");
  const login = me?.login;
  if (!configured || configured.toLowerCase() === String(login).toLowerCase())
    return { owner: login, ownerType: "user" };
  const account = await context.github.get(`/users/${encodeURIComponent(configured)}`);
  return { owner: configured, ownerType: account?.type === "Organization" ? "org" : "user", login };
}

/** The repository and folder of a new landing, from the settings, --repo and --root-dir. */
async function landingTarget(context, name) {
  const { options, settings } = context;
  const account = await githubOwner(context);
  let repo;
  if (options.repo !== undefined) {
    const spec = repoSpec(options.repo);
    repo = {
      ...spec,
      ownerType: spec.owner.toLowerCase() === String(account.owner).toLowerCase() ? account.ownerType : "unknown",
    };
  } else if (settings.repoMode === "repo-per-site") repo = { owner: account.owner, name, ownerType: account.ownerType };
  else repo = { owner: account.owner, name: settings.landingsRepo || "landings", ownerType: account.ownerType };
  const monorepo = options.repo === undefined && settings.repoMode !== "repo-per-site";
  const rootDir =
    options["root-dir"] !== undefined
      ? repoFolder(options["root-dir"])
      : monorepo
        ? repoFolder([repoFolder(settings.sitesFolder, "sitesFolder"), name].filter(Boolean).join("/"))
        : "";
  return { repo, rootDir, branch: String(options.branch ?? settings.branch ?? "main"), login: account.login };
}

/** Creates the repository when it does not exist. Answers whether it was created. */
async function ensureRepo(context, repo) {
  const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const found = await context.github.request("GET", path, { allow: [404] });
  if (found.status === 200) return { created: false, defaultBranch: found.body?.default_branch ?? "main" };
  if (repo.ownerType === "unknown")
    throw new CliError(`The repository ${repo.owner}/${repo.name} does not exist, or the GitHub token cannot see it.`, {
      details: { hint: "Create it in GitHub, or set githubOwner and let the helper create it." },
    });
  const body = {
    name: repo.name,
    private: context.settings.privateRepos !== false,
    auto_init: true,
    description: "Landing pages published on Render by OpenBot.",
    has_issues: false,
    has_wiki: false,
    has_projects: false,
  };
  const created = await context.change("repo-create", `${repo.owner}/${repo.name}`, { private: body.private }, () =>
    context.github.send(
      "POST",
      repo.ownerType === "org" ? `/orgs/${encodeURIComponent(repo.owner)}/repos` : "/user/repos",
      body,
    ),
  );
  return { created: true, defaultBranch: created?.default_branch ?? "main" };
}

/**
 * Makes the folder `prefix` of the branch hold exactly the landing's files, in one commit. Files of
 * the folder that the landing no longer has are deleted; files outside the folder stay. Answers the
 * new commit, or the old one when nothing changed.
 */
async function pushLanding(context, { repo, branch, prefix, files, message }) {
  const gh = context.github;
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const refPath = `${base}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  let ref = await gh.request("GET", refPath, { allow: [404, 409] });
  if (ref.status === 409) {
    // An empty repository has no commit for the Git database API. The contents API makes the first one.
    await gh.send("PUT", `${base}/contents/README.md`, {
      message: "Start the landings repository",
      content: Buffer.from(`# ${repo.name}\n\nLanding pages published on Render by OpenBot.\n`).toString("base64"),
      branch,
    });
    ref = await gh.request("GET", refPath, { allow: [404] });
  }
  if (ref.status === 404) {
    const info = await gh.get(base);
    const from = await gh.get(
      `${base}/git/ref/heads/${String(info?.default_branch ?? "main")
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    );
    await gh.send("POST", `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: from?.object?.sha });
    ref = await gh.request("GET", refPath);
  }
  const parent = ref.body?.object?.sha;
  if (!parent) throw new CliError("GitHub did not give the branch's last commit.");
  const commit = await gh.get(`${base}/git/commits/${parent}`);
  const tree = await gh.get(`${base}/git/trees/${commit?.tree?.sha}`, { recursive: 1 });
  const inFolder = (path) => (prefix ? path.startsWith(`${prefix}/`) : true);
  const existing = new Map(
    (Array.isArray(tree?.tree) ? tree.tree : [])
      .filter((entry) => entry?.type === "blob" && inFolder(entry.path))
      .map((entry) => [entry.path, entry]),
  );
  const changes = [];
  const wanted = new Set();
  let uploaded = 0;
  for (const file of files) {
    const path = prefix ? `${prefix}/${file.path}` : file.path;
    const mode = file.executable ? "100755" : "100644";
    wanted.add(path);
    const old = existing.get(path);
    if (old && old.sha === file.sha && old.mode === mode) continue;
    let sha = file.sha;
    if (!old || old.sha !== file.sha) {
      const blob = await gh.send("POST", `${base}/git/blobs`, {
        content: file.content.toString("base64"),
        encoding: "base64",
      });
      sha = blob?.sha ?? file.sha;
      uploaded += 1;
    }
    changes.push({ path, mode, type: "blob", sha });
  }
  let deleted = 0;
  // A truncated tree does not list every file, so nothing is deleted from it.
  if (tree?.truncated !== true)
    for (const path of existing.keys())
      if (!wanted.has(path)) {
        changes.push({ path, mode: "100644", type: "blob", sha: null });
        deleted += 1;
      }
  if (changes.length === 0) return { changed: false, commit: parent, uploaded: 0, deleted: 0, files: files.length };
  const newTree = await gh.send("POST", `${base}/git/trees`, { base_tree: commit.tree.sha, tree: changes });
  const newCommit = await gh.send("POST", `${base}/git/commits`, {
    message,
    tree: newTree?.sha,
    parents: [parent],
  });
  await gh.send("PATCH", `${base}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, {
    sha: newCommit?.sha,
    force: false,
  });
  return {
    changed: true,
    commit: newCommit?.sha,
    uploaded,
    deleted,
    files: files.length,
    truncatedTree: tree?.truncated === true || undefined,
  };
}

/** The owner, name and folder of the repository that a site builds from. */
function siteRepo(service) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(String(service?.repo ?? ""));
  if (!match)
    throw new CliError("This site does not build from a GitHub repository, so the helper cannot push files to it.", {
      details: { repo: service?.repo ?? null },
    });
  return { owner: match[1], name: match[2] };
}

// ---------- Cloudflare DNS ----------

function marker(service) {
  return `${MARKER_PREFIX}${service.id}`;
}

/** The zone that holds a hostname: the longest zone name that is the hostname or ends it. */
async function zoneFor(context, host) {
  const zones = await context.cloudflare.list("/zones", {}, 50);
  const matches = zones
    .filter((zone) => host === zone.name || host.endsWith(`.${zone.name}`))
    .sort((a, b) => b.name.length - a.name.length);
  if (matches.length === 0)
    throw new CliError(`No Cloudflare zone that the token can see holds ${host}.`, {
      details: {
        code: "zone_not_found",
        zones: zones.map((zone) => zone.name),
        hint: "Add the domain to Cloudflare, or give the token access to its zone (Zone > Zone > Read and Zone > DNS > Edit), then try again.",
      },
    });
  return matches[0];
}

async function recordsNamed(context, zone, name) {
  return context.cloudflare.list(`/zones/${zone.id}/dns_records`, { "name.exact": name }, 100);
}

/** This site's CNAME of a name, and the other A, AAAA and CNAME records of the name (a conflict). */
async function dnsState(context, zone, service, name) {
  const tag = marker(service);
  const records = await recordsNamed(context, zone, name);
  const ours = records.find((record) => record.type === "CNAME" && record.comment === tag);
  const others = records.filter((record) => record !== ours && ["A", "AAAA", "CNAME"].includes(record.type));
  return {
    ours,
    conflict:
      others.length > 0
        ? others.map((record) => ({
            type: record.type,
            content: record.content,
            proxied: record.proxied,
            comment: record.comment ?? null,
          }))
        : null,
  };
}

/**
 * Makes `name` a CNAME to the site's onrender.com host. Changes only a record with this site's
 * marker; any other A, AAAA or CNAME record of the name is a conflict that the user resolves.
 */
async function ensureCname(context, zone, service, name, proxied) {
  const target = renderHost(service);
  const tag = marker(service);
  const { ours, conflict } = await dnsState(context, zone, service, name);
  if (conflict) return { name, action: "conflict", records: conflict };
  const body = { type: "CNAME", name, content: target, proxied, ttl: 1, comment: tag };
  if (ours) {
    if (ours.content === target && ours.proxied === proxied) return { name, action: "kept", id: ours.id, target };
    await context.change("dns-update", name, { zone: zone.name, target, proxied }, () =>
      context.cloudflare.call("PATCH", `/zones/${zone.id}/dns_records/${ours.id}`, { body }),
    );
    return { name, action: "updated", id: ours.id, target, proxied };
  }
  const created = await context.change("dns-create", name, { zone: zone.name, target, proxied, comment: tag }, () =>
    context.cloudflare.call("POST", `/zones/${zone.id}/dns_records`, { body }),
  );
  return { name, action: "created", id: created?.id ?? null, target, proxied };
}

/** The records with this site's marker, in every zone the token can see (or in one zone). */
async function markedRecords(context, service, zones = null) {
  const list = zones ?? (await context.cloudflare.list("/zones", {}, 50));
  const rows = [];
  for (const zone of list) {
    const records = await context.cloudflare.list(
      `/zones/${zone.id}/dns_records`,
      { "comment.exact": marker(service) },
      100,
    );
    for (const record of records) if (record.comment === marker(service)) rows.push({ zone, record });
  }
  return rows;
}

async function tlsCheck(context, host) {
  if (context.options["skip-tls-check"] === true || process.env.RENDER_SITES_TLS_CHECK === "off") return "skipped";
  try {
    await fetch(`https://${host}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return "ok";
  } catch {
    return "pending";
  }
}

async function customDomain(context, service, name) {
  const found = await context.render.request(
    "GET",
    `/services/${encodeURIComponent(service.id)}/custom-domains/${encodeURIComponent(name)}`,
    { allow: [404] },
  );
  return found.status === 404 ? null : found.body;
}

/** Asks Render to verify the domains, then reads them until each one is verified or the time is over. */
async function verifyDomains(context, service, names, timeout) {
  const end = Date.now() + timeout * 1000;
  const status = new Map();
  let asked = 0;
  for (;;) {
    // Render allows 50 verify calls an hour, so the helper asks again at most every 2 minutes.
    if (Date.now() - asked >= 120_000) {
      for (const name of names)
        if (status.get(name) !== "verified")
          await context.render.request(
            "POST",
            `/services/${encodeURIComponent(service.id)}/custom-domains/${encodeURIComponent(name)}/verify`,
            { allow: [400, 409] },
          );
      asked = Date.now();
    }
    for (const name of names) {
      const domain = await customDomain(context, service, name);
      status.set(name, domain?.verificationStatus ?? "missing");
    }
    if (names.every((name) => status.get(name) === "verified") || Date.now() >= end) break;
    await sleep(Math.min(context.pollMs, Math.max(0, end - Date.now())));
  }
  return Object.fromEntries(status);
}

async function sslMode(context, zone) {
  try {
    const setting = await context.cloudflare.call("GET", `/zones/${zone.id}/settings/ssl`);
    return setting?.value ?? null;
  } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) return "unknown";
    throw error;
  }
}

/** Turns the Cloudflare proxy on or off for the site's records of a hostname. */
async function setProxy(context, service, host, on) {
  const zone = await zoneFor(context, host);
  const tag = marker(service);
  const records = (await recordsNamed(context, zone, host)).filter(
    (record) => record.type === "CNAME" && record.comment === tag,
  );
  if (records.length === 0)
    throw new CliError(`This helper made no record for ${host}, so it does not change it.`, {
      details: { hint: `Run render-sites domain add ${service.name} ${host} first.` },
    });
  const warnings = [];
  if (on) {
    const domain = await customDomain(context, service, host);
    if (domain?.verificationStatus !== "verified")
      throw new CliError(`Render has not verified ${host} yet. Keep it DNS only until it is verified.`, {
        details: { hint: `Run render-sites domain verify ${service.name} ${host}.` },
      });
    const tls = await tlsCheck(context, host);
    if (tls === "pending")
      throw new CliError(`https://${host} does not answer with a valid certificate yet. Try again in a few minutes.`);
    const mode = await sslMode(context, zone);
    if (mode === "off" || mode === "flexible")
      throw new CliError(
        `The zone ${zone.name} uses SSL/TLS mode ${mode}. With the proxy on, the site would not load.`,
        {
          details: {
            hint: "Ask the user to set SSL/TLS > Overview > Full in Cloudflare for this zone (it changes every site of the zone), then try again.",
          },
        },
      );
    if (mode === "unknown")
      warnings.push("The token cannot read the zone's SSL/TLS mode. It must be Full (or Full (strict)), not Flexible.");
  }
  const changed = [];
  for (const record of records) {
    if (record.proxied === on) continue;
    await context.change("dns-proxy", host, { zone: zone.name, proxied: on }, () =>
      context.cloudflare.call("PATCH", `/zones/${zone.id}/dns_records/${record.id}`, { body: { proxied: on } }),
    );
    changed.push(record.id);
  }
  return { hostname: host, proxied: on, changed: changed.length, warnings };
}

// ---------- commands ----------

const SETTING_KEYS = {
  ownerId: (value) => {
    if (value && !/^(usr|tea)-[a-z0-9]+$/i.test(value))
      throw new CliError("ownerId looks like tea-... or usr-... (render-sites owners).", { exit: EXIT.usage });
    return value;
  },
  githubOwner: (value) => {
    if (value && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value))
      throw new CliError("githubOwner is a GitHub user or organization name.", { exit: EXIT.usage });
    return value;
  },
  repoMode: (value) => {
    if (!["monorepo", "repo-per-site"].includes(value))
      throw new CliError("repoMode is monorepo or repo-per-site.", { exit: EXIT.usage });
    return value;
  },
  landingsRepo: (value) => repoSpec(`x/${value || "landings"}`).name,
  sitesFolder: (value) => repoFolder(value, "sitesFolder"),
  branch: (value) => {
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(value) || value.includes(".."))
      throw new CliError("branch is a git branch name such as main.", { exit: EXIT.usage });
    return value;
  },
  privateRepos: (value) => {
    if (value !== "true" && value !== "false")
      throw new CliError("privateRepos is true or false.", { exit: EXIT.usage });
    return value === "true";
  },
  buildCommand: (value) => value,
  publishPath: (value) => repoFolder(value, "publishPath") || ".",
  proxied: (value) => {
    if (value !== "true" && value !== "false") throw new CliError("proxied is true or false.", { exit: EXIT.usage });
    return value === "true";
  },
};

function envAssignments(values) {
  return (values ?? []).map((text) => {
    const index = String(text).indexOf("=");
    const key = index > 0 ? String(text).slice(0, index) : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new CliError("--env takes KEY=VALUE, with a key of letters, digits and _.", { exit: EXIT.usage });
    return { key, value: String(text).slice(index + 1) };
  });
}

const commands = {
  help: async () => ({ help: HELP }),

  async config(context, args) {
    const [sub, key, ...rest] = args;
    const show = () => ({
      home: context.home,
      settings: context.settings,
      auditLog: auditPath(context.home),
      keys: Object.fromEntries(
        Object.values(KEYS).map(({ name, flag }) => [
          name,
          context.options[flag] || process.env[`${name}_FILE`] ? "file" : process.env[name] ? "environment" : "missing",
        ]),
      ),
    });
    if (sub === "show" || sub === undefined) return show();
    if (sub !== "set" || !key || rest.length === 0)
      throw new CliError("Use: config show, or config set <key> <value>.", { exit: EXIT.usage });
    if (!Object.hasOwn(SETTING_KEYS, key))
      throw new CliError(`Unknown setting ${key}. Use: ${Object.keys(SETTING_KEYS).join(", ")}.`, { exit: EXIT.usage });
    const raw = rest.join(" ");
    const settings = structuredClone(context.settings);
    settings[key] = raw === "none" ? DEFAULT_SETTINGS[key] : SETTING_KEYS[key](raw);
    saveSettings(context.home, settings);
    context.settings = settings;
    context.audit({ action: "config", target: key, details: { [key]: settings[key] }, result: "ok" });
    return show();
  },

  async whoami(context) {
    const result = {};
    const probe = async (which, run) => {
      try {
        if (!optionalKey(context.options, which)) {
          result[which] = { key: "missing" };
          return;
        }
        result[which] = { key: "ok", ...(await run()) };
      } catch (error) {
        if (error instanceof CliError && error.exit === EXIT.rateLimited) throw error;
        result[which] = {
          key: "error",
          error: error instanceof ApiError ? describeApiError(error) : String(error.message),
        };
      }
    };
    await probe("render", async () => {
      const user = await context.render.get("/users");
      const owners = await context.render.list("/owners", "owner");
      return {
        user: { name: user?.name ?? null, email: user?.email ?? null },
        workspaces: owners.map((owner) => ({ id: owner.id, name: owner.name, type: owner.type })),
        ownerId: context.settings.ownerId || null,
      };
    });
    await probe("github", async () => {
      const user = await context.github.get("/user");
      return { login: user?.login ?? null, githubOwner: context.settings.githubOwner || user?.login || null };
    });
    await probe("cloudflare", async () => {
      const zones = await context.cloudflare.list("/zones", {}, 50);
      return { zones: zones.map((zone) => ({ name: zone.name, status: zone.status })) };
    });
    return result;
  },

  async owners(context) {
    const owners = await context.render.list("/owners", "owner");
    return {
      ownerId: context.settings.ownerId || null,
      data: owners.map((owner) => ({ id: owner.id, name: owner.name, email: owner.email, type: owner.type })),
    };
  },

  async zones(context) {
    const zones = await context.cloudflare.list("/zones", {}, 50);
    return { count: zones.length, data: zones.map((zone) => ({ id: zone.id, name: zone.name, status: zone.status })) };
  },

  async sites(context) {
    const owner = context.options.all === true ? undefined : await context.ownerId();
    const services = await context.render.list("/services", "service", { type: "static_site", ownerId: owner });
    return { ownerId: owner ?? "all", count: services.length, data: services.map(siteRow) };
  },

  async site(context, args) {
    const service = await findSite(context, args[0]);
    const path = `/services/${encodeURIComponent(service.id)}`;
    const domains = await context.render.list(`${path}/custom-domains`, "customDomain");
    const headers = await context.render.list(`${path}/headers`, "header");
    const routes = await context.render.list(`${path}/routes`, "route");
    const last = await latestDeploy(context, service.id);
    return {
      site: siteRow(service),
      lastDeploy: last ? deployRow(last) : null,
      domains: domains.map((domain) => ({
        name: domain.name,
        type: domain.domainType,
        verificationStatus: domain.verificationStatus,
        redirectForName: domain.redirectForName || null,
      })),
      headers: headers.map(({ path: rule, name, value }) => ({ path: rule, name, value })),
      routes: routes.map(({ type, source, destination, priority }) => ({ type, source, destination, priority })),
    };
  },

  async deploys(context, args) {
    const service = await findSite(context, args[0]);
    const page = await context.render.get(`/services/${encodeURIComponent(service.id)}/deploys`, {
      limit: limitOption(context.options, 10),
    });
    return {
      site: { id: service.id, name: service.name },
      data: (Array.isArray(page) ? page : []).map((entry) => deployRow(entry?.deploy)),
    };
  },

  async "deploy-status"(context, args) {
    const service = await findSite(context, args[0]);
    const deploy = args[1]
      ? await context.render.get(`/services/${encodeURIComponent(service.id)}/deploys/${encodeURIComponent(args[1])}`)
      : await latestDeploy(context, service.id);
    if (!deploy) throw new CliError("The site has no deploy yet.");
    return {
      site: { id: service.id, name: service.name, url: service.serviceDetails?.url ?? null },
      deploy: deployRow(deploy),
    };
  },

  async wait(context, args) {
    const service = await findSite(context, args[0]);
    const id = args[1] ?? (await latestDeploy(context, service.id))?.id;
    if (!id) throw new CliError("The site has no deploy yet.");
    const deploy = await waitForDeploy(context, service.id, id, timeoutSeconds(context.options, 600));
    return deployOutcome(service, deploy);
  },

  async logs(context, args) {
    const service = await findSite(context, args[0]);
    const limit = limitOption(context.options, 100);
    try {
      const answer = await context.render.get("/logs", {
        ownerId: service.ownerId,
        resource: service.id,
        type: "build",
        direction: "backward",
        limit,
      });
      const logs = Array.isArray(answer?.logs) ? answer.logs : [];
      return {
        site: { id: service.id, name: service.name },
        count: logs.length,
        logs: logs.map((line) => ({ time: line?.timestamp ?? null, message: line?.message ?? "" })).reverse(),
        ...(logs.length === 0
          ? {
              note: "Render gave no build logs through the API for this site. Read them in the dashboard.",
              dashboardUrl: service.dashboardUrl,
            }
          : {}),
      };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return {
        site: { id: service.id, name: service.name },
        count: 0,
        logs: [],
        note: "Render does not give this site's build logs through the API. Read them in the dashboard (Events > the deploy).",
        dashboardUrl: service.dashboardUrl,
        error: describeApiError(error),
      };
    }
  },

  async dns(context, args) {
    const service = await findSite(context, args[0]);
    const rows = await markedRecords(context, service);
    return {
      site: { id: service.id, name: service.name },
      marker: marker(service),
      data: rows.map(({ zone, record }) => ({
        zone: zone.name,
        name: record.name,
        type: record.type,
        content: record.content,
        proxied: record.proxied,
      })),
    };
  },

  async audit(context) {
    const tail = Number(context.options.tail ?? 20);
    const lines = readAudit(context.home);
    return { path: auditPath(context.home), count: lines.length, data: lines.slice(-Math.max(1, tail)) };
  },

  async create(context, args) {
    const { options, settings } = context;
    const name = siteName(args[0]);
    if (options.dir === undefined)
      throw new CliError("Use: create <name> --dir <folder with index.html>.", { exit: EXIT.usage });
    const landing = readLanding(String(options.dir), context.knownKeys());
    const ownerId = await context.ownerId();
    const existing = (await context.render.list("/services", "service", { name, ownerId })).filter(
      (service) => service?.name === name,
    );
    if (existing.length > 0)
      throw new CliError(`A Render service named ${name} already exists.`, {
        details: {
          site: siteRow(existing[0]),
          hint: `To publish new files to it: render-sites deploy ${name} --dir <folder>. For a new landing, use another name.`,
        },
      });
    const target = await landingTarget(context, name);
    const serviceBody = {
      type: "static_site",
      name,
      ownerId,
      repo: `https://github.com/${target.repo.owner}/${target.repo.name}`,
      branch: target.branch,
      ...(target.rootDir ? { rootDir: target.rootDir } : {}),
      autoDeployTrigger: "commit",
      serviceDetails: {
        buildCommand: String(options["build-command"] ?? settings.buildCommand ?? ""),
        publishPath: repoFolder(options["publish-path"] ?? settings.publishPath ?? ".", "--publish-path") || ".",
        previews: { generation: "off" },
      },
    };
    const plan = {
      repo: `${target.repo.owner}/${target.repo.name}`,
      branch: target.branch,
      folder: target.rootDir || "(repository root)",
      files: landing.files.length,
      bytes: landing.bytes,
      skipped: landing.skipped,
      service: serviceBody,
    };
    if (options["dry-run"] === true) return { dryRun: true, plan };
    const repo = await ensureRepo(context, target.repo);
    const push = await context.change(
      "push",
      `${target.repo.owner}/${target.repo.name}:${target.rootDir || "/"}`,
      { site: name, files: landing.files.length },
      () =>
        pushLanding(context, {
          repo: target.repo,
          branch: target.branch,
          prefix: target.rootDir,
          files: landing.files,
          message: String(options.message ?? `Publish landing ${name}`),
        }),
    );
    let created;
    try {
      created = await context.change("site-create", name, { repo: plan.repo, rootDir: target.rootDir, ownerId }, () =>
        context.render.send("POST", "/services", serviceBody),
      );
    } catch (error) {
      if (looksLikeRepoAccess(error))
        throw new CliError("Render cannot read the GitHub repository.", {
          details: {
            code: "repo_not_accessible",
            repo: plan.repo,
            render: describeApiError(error),
            hint: repoAccessSteps(target.repo),
            pushed: { commit: push.commit },
          },
        });
      throw error;
    }
    const service = created?.service ?? created;
    if (!service?.id) throw new CliError("Render did not answer with the new site.");
    const extra = {
      repo: { name: plan.repo, created: repo.created, folder: target.rootDir, commit: push.commit },
      skipped: landing.skipped.length > 0 ? landing.skipped : undefined,
      next: `render-sites domain add ${name} <hostname>`,
    };
    const deployId = created?.deployId ?? (await latestDeploy(context, service.id))?.id;
    if (options["no-wait"] === true || !deployId)
      return { site: siteRow(service), deploy: deployId ? { id: deployId, status: "created" } : null, ...extra };
    const deploy = await waitForDeploy(context, service.id, deployId, timeoutSeconds(options, 600));
    return deployOutcome(service, deploy, extra);
  },

  async deploy(context, args) {
    const { options } = context;
    const service = await findSite(context, args[0]);
    if (options.dir === undefined) {
      const body = { clearCache: options["clear-cache"] === true ? "clear" : "do_not_clear" };
      if (options["dry-run"] === true) return { dryRun: true, site: siteRow(service), request: body };
      const answer = await context.change("deploy", service.name, body, () =>
        context.render.request("POST", `/services/${encodeURIComponent(service.id)}/deploys`, { body }),
      );
      const deployId = answer.body?.id ?? (await latestDeploy(context, service.id))?.id;
      if (options["no-wait"] === true || !deployId)
        return {
          site: siteRow(service),
          deploy: deployId ? { id: deployId, status: answer.body?.status ?? "queued" } : null,
        };
      return deployOutcome(service, await waitForDeploy(context, service.id, deployId, timeoutSeconds(options, 600)));
    }
    const landing = readLanding(String(options.dir), context.knownKeys());
    const repo = siteRepo(service);
    const prefix = repoFolder(service.rootDir ?? "");
    const branch = String(service.branch ?? context.settings.branch ?? "main");
    if (options["dry-run"] === true)
      return {
        dryRun: true,
        site: siteRow(service),
        plan: {
          repo: `${repo.owner}/${repo.name}`,
          branch,
          folder: prefix || "(repository root)",
          files: landing.files.length,
        },
      };
    const push = await context.change(
      "push",
      `${repo.owner}/${repo.name}:${prefix || "/"}`,
      { site: service.name, files: landing.files.length },
      () =>
        pushLanding(context, {
          repo,
          branch,
          prefix,
          files: landing.files,
          message: String(options.message ?? `Update landing ${service.name}`),
        }),
    );
    if (!push.changed && options.force !== true)
      return {
        site: siteRow(service),
        push,
        deploy: null,
        note: "The files did not change, so nothing was deployed. Add --force to deploy the same files again.",
      };
    const auto = (service.autoDeployTrigger ?? (service.autoDeploy === "yes" ? "commit" : "off")) !== "off";
    let deploy = push.changed && auto ? await deployForCommit(context, service.id, push.commit) : null;
    if (!deploy) {
      const body = { clearCache: options["clear-cache"] === true ? "clear" : "do_not_clear", commitId: push.commit };
      const answer = await context.change("deploy", service.name, body, () =>
        context.render.request("POST", `/services/${encodeURIComponent(service.id)}/deploys`, { body }),
      );
      deploy = answer.body ?? (await latestDeploy(context, service.id));
    }
    if (options["no-wait"] === true || !deploy?.id) return { site: siteRow(service), push, deploy: deployRow(deploy) };
    const finished = await waitForDeploy(context, service.id, deploy.id, timeoutSeconds(options, 600));
    return deployOutcome(service, finished, { push });
  },

  async update(context, args) {
    const { options } = context;
    const service = await findSite(context, args[0]);
    const path = `/services/${encodeURIComponent(service.id)}`;
    const patch = {};
    const details = {};
    if (options["build-command"] !== undefined) details.buildCommand = String(options["build-command"]);
    if (options["publish-path"] !== undefined)
      details.publishPath = repoFolder(options["publish-path"], "--publish-path") || ".";
    if (Object.keys(details).length > 0) patch.serviceDetails = details;
    if (options.branch !== undefined) patch.branch = SETTING_KEYS.branch(String(options.branch));
    if (options["root-dir"] !== undefined) patch.rootDir = repoFolder(options["root-dir"]);
    if (options["auto-deploy"] !== undefined) {
      const value = String(options["auto-deploy"]);
      if (!["on", "off"].includes(value)) throw new CliError("--auto-deploy is on or off.", { exit: EXIT.usage });
      patch.autoDeployTrigger = value === "on" ? "commit" : "off";
    }
    const env = envAssignments(options.env);
    const unset = (options["unset-env"] ?? []).map(String);
    const headers = readJsonOption(options, "headers");
    const routes = readJsonOption(options, "routes");
    if (headers !== undefined && !Array.isArray(headers))
      throw new CliError('--headers is a JSON list like [{"path":"/*","name":"X-Frame-Options","value":"DENY"}].', {
        exit: EXIT.usage,
      });
    if (routes !== undefined && !Array.isArray(routes))
      throw new CliError('--routes is a JSON list like [{"type":"redirect","source":"/old","destination":"/"}].', {
        exit: EXIT.usage,
      });
    const nothing = Object.keys(patch).length === 0 && env.length === 0 && unset.length === 0 && !headers && !routes;
    if (nothing) throw new CliError("Name at least one change. Run render-sites help.", { exit: EXIT.usage });
    const plan = {
      patch,
      env: env.map(({ key }) => key),
      unsetEnv: unset,
      headers: headers ?? undefined,
      routes: routes ?? undefined,
    };
    if (options["dry-run"] === true) return { dryRun: true, site: siteRow(service), plan };
    const done = [];
    if (Object.keys(patch).length > 0) {
      await context.change("update", service.name, patch, () => context.render.send("PATCH", path, patch));
      done.push("settings");
    }
    for (const { key, value } of env) {
      // Only the key goes into the audit log: a value can be a secret.
      await context.change("env-set", service.name, { key }, () =>
        context.render.send("PUT", `${path}/env-vars/${encodeURIComponent(key)}`, { value }),
      );
      done.push(`env ${key}`);
    }
    for (const key of unset) {
      await context.change("env-unset", service.name, { key }, () =>
        context.render.request("DELETE", `${path}/env-vars/${encodeURIComponent(key)}`, { allow: [404] }),
      );
      done.push(`unset ${key}`);
    }
    if (headers) {
      await context.change("headers", service.name, { count: headers.length }, () =>
        context.render.send(
          "PUT",
          `${path}/headers`,
          headers.map(({ path: rule, name, value }) => ({ path: rule, name, value })),
        ),
      );
      done.push("headers");
    }
    if (routes) {
      await context.change("routes", service.name, { count: routes.length }, () =>
        context.render.send(
          "PUT",
          `${path}/routes`,
          routes.map(({ type, source, destination }) => ({ type, source, destination })),
        ),
      );
      done.push("routes");
    }
    return {
      site: siteRow(await context.render.get(path)),
      changed: done,
      note: "Build settings and environment variables apply from the next deploy: render-sites deploy <site>.",
    };
  },

  async suspend(context, args) {
    const service = await findSite(context, args[0]);
    context.requireApproval("suspend", service.name, "The landing goes offline until it is resumed.");
    if (context.options["dry-run"] === true) return { dryRun: true, site: siteRow(service) };
    await context.change("suspend", service.name, { id: service.id }, () =>
      context.render.request("POST", `/services/${encodeURIComponent(service.id)}/suspend`),
    );
    return { site: { id: service.id, name: service.name }, suspended: true };
  },

  async resume(context, args) {
    const service = await findSite(context, args[0]);
    await context.change("resume", service.name, { id: service.id }, () =>
      context.render.request("POST", `/services/${encodeURIComponent(service.id)}/resume`),
    );
    return { site: { id: service.id, name: service.name }, suspended: false };
  },

  async delete(context, args) {
    const service = await findSite(context, args[0]);
    context.requireApproval(
      "delete",
      service.name,
      "The Render site, its URL and its custom domains are removed. It cannot be undone.",
    );
    const records = context.options["keep-dns"] === true ? [] : await markedRecords(context, service);
    if (context.options["dry-run"] === true)
      return {
        dryRun: true,
        site: siteRow(service),
        dnsRecords: records.map(({ zone, record }) => ({ zone: zone.name, name: record.name })),
      };
    await context.change("delete", service.name, { id: service.id, repo: service.repo, rootDir: service.rootDir }, () =>
      context.render.request("DELETE", `/services/${encodeURIComponent(service.id)}`),
    );
    const removed = [];
    for (const { zone, record } of records) {
      await context.change("dns-delete", record.name, { zone: zone.name, id: record.id }, () =>
        context.cloudflare.call("DELETE", `/zones/${zone.id}/dns_records/${record.id}`),
      );
      removed.push(record.name);
    }
    return {
      deleted: { id: service.id, name: service.name },
      dnsRemoved: removed,
      note: "The files stay in the GitHub repository.",
    };
  },

  async domain(context, args) {
    const [sub, site, host, toggle] = args;
    const run = DOMAIN_COMMANDS[sub];
    if (!run) throw new CliError("Use: domain add|list|verify|proxy|remove <site> [<hostname>].", { exit: EXIT.usage });
    return run(context, site, host, toggle);
  },
};

function dnsConflict(service, name, records) {
  return new CliError(`${name} already has DNS records that this helper did not make. It does not change them.`, {
    details: {
      code: "dns_conflict",
      records,
      hint: `Ask the user to delete or change these records in Cloudflare (or to choose another hostname), then run: render-sites domain add ${service.name} ${name}.`,
    },
  });
}

const DOMAIN_COMMANDS = {
  async add(context, site, host) {
    const { options } = context;
    const service = await findSite(context, site);
    const name = hostname(host);
    const proxied =
      options.proxied === true ? true : options["dns-only"] === true ? false : context.settings.proxied === true;
    const zone = await zoneFor(context, name);
    const target = renderHost(service);
    if (options["dry-run"] === true)
      return {
        dryRun: true,
        site: { id: service.id, name: service.name },
        plan: {
          zone: zone.name,
          cname: { name, target, proxied: false, comment: marker(service) },
          thenProxied: proxied,
        },
      };
    // A record that the helper did not make stops the command before Render gets the domain.
    const before = await dnsState(context, zone, service, name);
    if (before.conflict) throw dnsConflict(service, name, before.conflict);
    // Render adds the twin (www for an apex, the apex for www) and answers both.
    let domains;
    const existing = await customDomain(context, service, name);
    if (existing) domains = [existing];
    else {
      const added = await context.change("domain-add", name, { site: service.name }, () =>
        context.render.send("POST", `/services/${encodeURIComponent(service.id)}/custom-domains`, { name }),
      );
      domains = Array.isArray(added) ? added : added ? [added] : [];
      if (!domains.some((domain) => domain?.name === name)) domains.push({ name, verificationStatus: "unverified" });
    }
    const names = [...new Set(domains.map((domain) => String(domain?.name ?? "").toLowerCase()).filter(Boolean))];
    // DNS only until Render has verified the domain and issued the certificate (Render's Cloudflare guide).
    const dns = [];
    for (const entry of names) {
      if (entry !== zone.name && !entry.endsWith(`.${zone.name}`)) {
        dns.push({ name: entry, action: "other-zone" });
        continue;
      }
      dns.push(await ensureCname(context, zone, service, entry, false));
    }
    const conflict = dns.find((row) => row.name === name && row.action === "conflict");
    if (conflict) throw dnsConflict(service, name, conflict.records);
    const verifiable = dns.filter((row) => ["created", "updated", "kept"].includes(row.action)).map((row) => row.name);
    const result = {
      site: { id: service.id, name: service.name, url: service.serviceDetails?.url ?? null },
      zone: zone.name,
      dns,
      domains: names,
    };
    if (options["no-wait"] === true) {
      for (const entry of verifiable)
        await context.render.request(
          "POST",
          `/services/${encodeURIComponent(service.id)}/custom-domains/${encodeURIComponent(entry)}/verify`,
          { allow: [400, 409] },
        );
      return { ...result, verification: "requested", next: `render-sites domain verify ${service.name} ${name}` };
    }
    const verification = await verifyDomains(context, service, verifiable, timeoutSeconds(options, 300));
    result.verification = verification;
    if (verification[name] !== "verified")
      throw new CliError(`Render has not verified ${name} yet. DNS changes can take some minutes.`, {
        exit: EXIT.timeout,
        details: { ...result, hint: `Run render-sites domain verify ${service.name} ${name} later.` },
      });
    result.https = await tlsCheck(context, name);
    result.link = `https://${name}`;
    if (proxied) {
      try {
        result.proxy = await setProxy(context, service, name, true);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        result.proxy = {
          proxied: false,
          why: error.message,
          later: `render-sites domain proxy ${service.name} ${name} on`,
        };
      }
    }
    return result;
  },

  async list(context, site) {
    const service = await findSite(context, site);
    const domains = await context.render.list(
      `/services/${encodeURIComponent(service.id)}/custom-domains`,
      "customDomain",
    );
    let records = [];
    let dnsError = null;
    try {
      if (optionalKey(context.options, "cloudflare")) records = await markedRecords(context, service);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      dnsError = describeApiError(error);
    }
    return {
      site: { id: service.id, name: service.name, url: service.serviceDetails?.url ?? null },
      data: domains.map((domain) => {
        const record = records.find(({ record: row }) => row.name === domain.name)?.record;
        return {
          name: domain.name,
          type: domain.domainType,
          verificationStatus: domain.verificationStatus,
          redirectForName: domain.redirectForName || null,
          dns: record ? { type: record.type, content: record.content, proxied: record.proxied, byHelper: true } : null,
        };
      }),
      ...(dnsError ? { dnsError } : {}),
    };
  },

  async verify(context, site, host) {
    const service = await findSite(context, site);
    const name = hostname(host);
    if (!(await customDomain(context, service, name)))
      throw new CliError(`${name} is not a domain of ${service.name}.`, {
        details: { hint: `render-sites domain add ${service.name} ${name}` },
      });
    if (context.options["no-wait"] === true) {
      await context.render.request(
        "POST",
        `/services/${encodeURIComponent(service.id)}/custom-domains/${encodeURIComponent(name)}/verify`,
        { allow: [400, 409] },
      );
      return { hostname: name, verification: "requested" };
    }
    const verification = await verifyDomains(context, service, [name], timeoutSeconds(context.options, 300));
    if (verification[name] !== "verified")
      throw new CliError(`Render has not verified ${name} yet.`, {
        exit: EXIT.timeout,
        details: {
          verification,
          hint: "Check with render-sites domain list that the CNAME exists, and that no AAAA record or old A record remains.",
        },
      });
    return {
      hostname: name,
      verification: verification[name],
      https: await tlsCheck(context, name),
      link: `https://${name}`,
    };
  },

  async proxy(context, site, host, toggle) {
    if (!["on", "off"].includes(String(toggle)))
      throw new CliError("Use: domain proxy <site> <hostname> on|off.", { exit: EXIT.usage });
    const service = await findSite(context, site);
    return setProxy(context, service, hostname(host), toggle === "on");
  },

  async remove(context, site, host) {
    const service = await findSite(context, site);
    const name = hostname(host);
    context.requireApproval("domain-remove", name, `The landing stops answering on ${name}.`);
    const domain = await customDomain(context, service, name);
    let records = [];
    let zone = null;
    try {
      zone = await zoneFor(context, name);
      records = (await recordsNamed(context, zone, name)).filter((record) => record.comment === marker(service));
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
    }
    if (context.options["dry-run"] === true)
      return { dryRun: true, renderDomain: domain?.name ?? null, dnsRecords: records.map((record) => record.name) };
    if (domain)
      await context.change("domain-remove", name, { site: service.name }, () =>
        context.render.request(
          "DELETE",
          `/services/${encodeURIComponent(service.id)}/custom-domains/${encodeURIComponent(name)}`,
        ),
      );
    for (const record of records)
      await context.change("dns-delete", name, { zone: zone?.name, id: record.id }, () =>
        context.cloudflare.call("DELETE", `/zones/${zone.id}/dns_records/${record.id}`),
      );
    const left = await context.render.list(
      `/services/${encodeURIComponent(service.id)}/custom-domains`,
      "customDomain",
    );
    return {
      removed: name,
      render: domain ? "removed" : "was not on Render",
      dnsRemoved: records.length,
      remainingDomains: left.map((entry) => entry.name),
    };
  },
};

// ---------- main ----------

function redact(text, secrets) {
  let result = String(text);
  for (const secret of secrets) if (secret && secret.length >= 8) result = result.split(secret).join("[REDACTED]");
  return result;
}

export async function main(argv) {
  let context = null;
  const write = (stream, value) => {
    stream.write(`${redact(JSON.stringify(value, null, 2), context?.keys ?? [])}\n`);
  };
  try {
    const { positional, options } = parseArgs(argv);
    const [name = "help", ...args] = positional;
    if (options.help || name === "help" || name === "--help") {
      process.stdout.write(HELP);
      return EXIT.ok;
    }
    const command = Object.hasOwn(commands, name) ? commands[name] : null;
    if (!command) throw new CliError(`Unknown command ${name}. Run: render-sites help`, { exit: EXIT.usage });
    context = new Context(options);
    write(process.stdout, await command(context, args));
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) {
      if (error.exit === EXIT.refused) {
        write(process.stdout, { error: error.message, ...error.details });
        return EXIT.refused;
      }
      write(process.stderr, {
        error: { message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
      return error.exit;
    }
    if (error instanceof ApiError) {
      write(process.stderr, { error: describeApiError(error) });
      return EXIT.error;
    }
    write(process.stderr, {
      error: { message: "Unexpected failure in render-sites.", detail: String(error?.message ?? error) },
    });
    return EXIT.error;
  }
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (invokedDirectly()) process.exitCode = await main(process.argv.slice(2));
