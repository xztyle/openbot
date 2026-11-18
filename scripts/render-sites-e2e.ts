// Runs the render-sites helper of the openbot-render-sites managed skill against fake Render, Cloudflare
// and GitHub APIs on 127.0.0.1 (RENDER_API_BASE_URL, CLOUDFLARE_API_BASE_URL, GITHUB_API_BASE_URL).
// Checks the whole landing flow: the repository is created and the files go into one folder of the
// shared landings repository in one commit, the static site is created and its first deploy is waited
// for, a new push deploys only the site whose folder changed, a domain gets a DNS-only CNAME with the
// helper's marker comment and Render verifies it, the proxy turns on only with a safe SSL mode, and the
// helper never changes a DNS record it did not make. Also checks the errors (Render cannot read the
// repository, no zone, a missing key file, a failed build, files with secrets), the --approved guard for
// delete, suspend and domain remove, the audit log, rate-limit retry, and that no output holds a key.
// `bun scripts/render-sites-e2e.ts`. RENDER_SITES_E2E_NODE selects the Node.js binary (default: node on PATH).
// Writes .openbot-build/render-sites-e2e/report.json.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { decodeTeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import type { EventCheckData } from "../src/backend/event-check-reader";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build/render-sites-e2e");
const CLI = join(ROOT, "resources/managed-skills/openbot-render-sites/render-sites.mjs");
const NODE = process.env.RENDER_SITES_E2E_NODE ?? "node";
const RENDER_KEY = "rnd_e2eRenderKey0123456789abcdef";
const CLOUDFLARE_TOKEN = "e2e-cloudflare-token-7d1c9a0b";
const GITHUB_TOKEN = "github_pat_e2e_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";
const GITHUB_LOGIN = "acme-sales";

// ---------- fake GitHub ----------

type TreeEntry = {
  path: string;
  mode: string;
  type: "blob";
  sha: string;
};
interface Repo {
  defaultBranch: string;
  private: boolean;
  refs: Map<string, string>;
}
const createdRepos: string[] = [];
const github = {
  repos: new Map<string, Repo>(),
  blobs: new Map<string, Buffer>(),
  trees: new Map<string, TreeEntry[]>(),
  commits: new Map<string, { tree: string; parents: string[]; message: string }>(),
  created: createdRepos,
};

/** A request body as parsed JSON, and its string fields. */
function parseBody(body: string): EventCheckData {
  return body ? decodeTeamProtocolV2Json(JSON.parse(body)) : {};
}
function text(value: EventCheckData | undefined): string {
  return typeof value === "string" ? value : "";
}

const sha1 = (text: string | Buffer) => createHash("sha1").update(text).digest("hex");
const blobSha = (content: Buffer) =>
  createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

function saveTree(entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const sha = sha1(JSON.stringify(sorted));
  github.trees.set(sha, sorted);
  return sha;
}

function saveCommit(tree: string, parents: string[], message: string): string {
  const sha = sha1(`${tree}:${parents.join(",")}:${message}:${github.commits.size}`);
  github.commits.set(sha, { tree, parents, message });
  return sha;
}

function initialCommit(repo: Repo, readme: string) {
  const content = Buffer.from(readme);
  github.blobs.set(blobSha(content), content);
  const tree = saveTree([{ path: "README.md", mode: "100644", type: "blob", sha: blobSha(content) }]);
  repo.refs.set(repo.defaultBranch, saveCommit(tree, [], "Initial commit"));
}

/** The files of a branch: path to content. */
function filesOf(full: string, branch = "main"): Map<string, string> {
  const repo = github.repos.get(full);
  const head = repo?.refs.get(branch);
  const commit = head ? github.commits.get(head) : undefined;
  const entries = commit ? (github.trees.get(commit.tree) ?? []) : [];
  return new Map(entries.map((entry) => [entry.path, github.blobs.get(entry.sha)?.toString("utf8") ?? ""]));
}

function changedPaths(oldTree: string | undefined, newTree: string): string[] {
  const before = new Map((oldTree ? (github.trees.get(oldTree) ?? []) : []).map((entry) => [entry.path, entry.sha]));
  const after = new Map((github.trees.get(newTree) ?? []).map((entry) => [entry.path, entry.sha]));
  const paths = new Set<string>();
  for (const [path, sha] of after) if (before.get(path) !== sha) paths.add(path);
  for (const path of before.keys()) if (!after.has(path)) paths.add(path);
  return [...paths];
}

function githubHandle(method: string, path: string, query: URLSearchParams, body: string, response: ServerResponse) {
  const send = (status: number, value?: EventCheckData) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(value === undefined ? "" : JSON.stringify(value));
  };
  const input = parseBody(body);
  const field = (name: string) => at(input, name);
  if (method === "GET" && path === "/user") return send(200, { login: GITHUB_LOGIN, type: "User" });
  const user = /^\/users\/([^/]+)$/.exec(path);
  if (method === "GET" && user)
    return send(200, { login: user[1] ?? "", type: user[1] === "acme-org" ? "Organization" : "User" });
  if (method === "POST" && path === "/user/repos") {
    const full = `${GITHUB_LOGIN}/${text(field("name"))}`;
    if (github.repos.has(full))
      return send(422, {
        message: "Repository creation failed.",
        errors: [{ message: "name already exists on this account" }],
      });
    const repo: Repo = { defaultBranch: "main", private: field("private") === true, refs: new Map() };
    github.repos.set(full, repo);
    if (field("auto_init") === true) initialCommit(repo, `# ${text(field("name"))}\n`);
    github.created.push(full);
    return send(201, { full_name: full, default_branch: "main", private: repo.private });
  }
  const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) return send(404, { message: "Not Found" });
  const full = `${match[1]}/${match[2]}`;
  const repo = github.repos.get(full);
  if (!repo) return send(404, { message: "Not Found" });
  const rest = match[3] ?? "";
  if (method === "GET" && rest === "")
    return send(200, { full_name: full, default_branch: repo.defaultBranch, private: repo.private });
  const ref = /^\/git\/refs?\/heads\/(.+)$/.exec(rest);
  if (method === "GET" && ref && rest.startsWith("/git/ref/")) {
    if (repo.refs.size === 0) return send(409, { message: "Git Repository is empty." });
    const sha = repo.refs.get(decodeURIComponent(ref[1] ?? ""));
    return sha
      ? send(200, { ref: `refs/heads/${ref[1]}`, object: { sha, type: "commit" } })
      : send(404, { message: "Not Found" });
  }
  if (method === "PUT" && rest === "/contents/README.md") {
    const content = Buffer.from(text(field("content")), "base64");
    github.blobs.set(blobSha(content), content);
    const tree = saveTree([{ path: "README.md", mode: "100644", type: "blob", sha: blobSha(content) }]);
    repo.refs.set(text(field("branch")) || repo.defaultBranch, saveCommit(tree, [], text(field("message"))));
    return send(201, { content: { path: "README.md" } });
  }
  if (method === "POST" && rest === "/git/refs") {
    repo.refs.set(text(field("ref")).replace("refs/heads/", ""), text(field("sha")));
    return send(201, { ref: text(field("ref")), object: { sha: text(field("sha")) } });
  }
  const commit = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest);
  if (method === "GET" && commit) {
    const found = github.commits.get(commit[1] ?? "");
    return found
      ? send(200, { sha: commit[1] ?? "", tree: { sha: found.tree }, parents: found.parents.map((sha) => ({ sha })) })
      : send(404, { message: "Not Found" });
  }
  const tree = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest);
  if (method === "GET" && tree) {
    if (query.get("recursive") !== "1") return send(400, { message: "The fake answers recursive trees only." });
    const entries = github.trees.get(tree[1] ?? "");
    return entries
      ? send(200, { sha: tree[1] ?? "", tree: entries, truncated: false })
      : send(404, { message: "Not Found" });
  }
  if (method === "POST" && rest === "/git/blobs") {
    assert.equal(field("encoding"), "base64");
    const content = Buffer.from(text(field("content")), "base64");
    github.blobs.set(blobSha(content), content);
    return send(201, { sha: blobSha(content) });
  }
  if (method === "POST" && rest === "/git/trees") {
    const base = new Map((github.trees.get(text(field("base_tree"))) ?? []).map((entry) => [entry.path, entry]));
    for (const change of entries(field("tree"))) {
      const changed = text(at(change, "path"));
      const sha = at(change, "sha");
      if (sha === null) base.delete(changed);
      else {
        assert.ok(github.blobs.has(text(sha)), `The blob of ${changed} was uploaded.`);
        base.set(changed, { path: changed, mode: text(at(change, "mode")), type: "blob", sha: text(sha) });
      }
    }
    return send(201, { sha: saveTree([...base.values()]) });
  }
  if (method === "POST" && rest === "/git/commits")
    return send(201, {
      sha: saveCommit(text(field("tree")), entries(field("parents")).map(text), text(field("message"))),
    });
  if (method === "PATCH" && ref && rest.startsWith("/git/refs/")) {
    const branch = decodeURIComponent(ref[1] ?? "");
    const old = repo.refs.get(branch);
    const sha = text(field("sha"));
    const next = github.commits.get(sha);
    if (!next) return send(422, { message: "Object does not exist" });
    if (old && !next.parents.includes(old) && field("force") !== true)
      return send(422, { message: "Update is not a fast forward" });
    repo.refs.set(branch, sha);
    onPush(full, branch, sha, changedPaths(old ? github.commits.get(old)?.tree : undefined, next.tree));
    return send(200, { ref: `refs/heads/${branch}`, object: { sha } });
  }
  return send(404, { message: "Not Found" });
}

// ---------- fake Render ----------

type Deploy = {
  id: string;
  status: string;
  trigger: string;
  commit: { id: string; message: string } | null;
  createdAt: string;
  reads: number;
  fail: boolean;
};
interface Service {
  id: string;
  name: string;
  ownerId: string;
  repo: string;
  branch: string;
  rootDir: string;
  autoDeployTrigger: string;
  suspended: string;
  buildCommand: string;
  publishPath: string;
  deploys: Deploy[];
  domains: { id: string; name: string; domainType: string; redirectForName: string; verificationStatus: string }[];
  env: Map<string, string>;
  headers: { id: string; path: string; name: string; value: string }[];
  routes: { id: string; type: string; source: string; destination: string; priority: number }[];
}
const serviceBodies: EventCheckData[] = [];
const deployBodies: EventCheckData[] = [];
const render = {
  services: new Map<string, Service>(),
  visibleRepos: new Set<string>(["https://github.com/acme-sales/empty-landing"]),
  failNextBuild: false,
  rateLimitNext: 0,
  serviceBodies,
  deployBodies,
  count: 0,
};

function newDeploy(service: Service, trigger: string, commit: string | null): Deploy {
  render.count += 1;
  const deploy: Deploy = {
    id: `dep-e2e${render.count}`,
    status: "created",
    trigger,
    commit: commit ? { id: commit, message: github.commits.get(commit)?.message ?? "" } : null,
    createdAt: new Date(Date.now() + render.count).toISOString(),
    reads: 0,
    fail: render.failNextBuild,
  };
  render.failNextBuild = false;
  service.deploys.unshift(deploy);
  return deploy;
}

/** Render deploys a site on a push only when the push changes files under its root directory. */
function onPush(full: string, branch: string, sha: string, paths: string[]) {
  for (const service of render.services.values()) {
    if (service.repo !== `https://github.com/${full}` || service.branch !== branch) continue;
    if (service.autoDeployTrigger !== "commit") continue;
    const inside = paths.some((path) => !service.rootDir || path.startsWith(`${service.rootDir}/`));
    if (inside) newDeploy(service, "new_commit", sha);
  }
}

function serviceJson(service: Service) {
  return {
    id: service.id,
    name: service.name,
    ownerId: service.ownerId,
    type: "static_site",
    slug: service.name,
    repo: service.repo,
    branch: service.branch,
    rootDir: service.rootDir,
    autoDeployTrigger: service.autoDeployTrigger,
    suspended: service.suspended,
    dashboardUrl: `https://dashboard.render.com/static/${service.id}`,
    serviceDetails: {
      buildCommand: service.buildCommand,
      publishPath: service.publishPath,
      url: `https://${service.name}.onrender.com`,
    },
  };
}

function deployJson(deploy: Deploy) {
  return {
    id: deploy.id,
    status: deploy.status,
    trigger: deploy.trigger,
    commit: deploy.commit,
    createdAt: deploy.createdAt,
  };
}

/** A deploy moves one step each time it is read: created, build_in_progress, then live or build_failed. */
function advance(deploy: Deploy) {
  deploy.reads += 1;
  if (deploy.status === "created") deploy.status = "build_in_progress";
  else if (deploy.status === "build_in_progress") deploy.status = deploy.fail ? "build_failed" : "live";
}

function paged(rows: EventCheckData[], key: string, query: URLSearchParams): EventCheckData[] {
  const limit = Math.min(Number(query.get("limit") ?? 20), 100);
  const offset = Number(query.get("cursor") ?? 0);
  return rows.slice(offset, offset + limit).map((row, index) => ({ cursor: String(offset + index + 1), [key]: row }));
}

/** Render verifies a domain when Cloudflare has a CNAME of the name to the site's onrender.com host. */
function cnameReady(service: Service, name: string): boolean {
  for (const zone of cloudflare.zones)
    for (const record of zone.records)
      if (record.name === name && record.type === "CNAME" && record.content === `${service.name}.onrender.com`)
        return true;
  return false;
}

function renderHandle(method: string, path: string, query: URLSearchParams, body: string, response: ServerResponse) {
  const send = (status: number, value?: EventCheckData, headers: Record<string, string> = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(value === undefined ? "" : JSON.stringify(value));
  };
  if (render.rateLimitNext > 0 && method === "GET") {
    render.rateLimitNext -= 1;
    return send(429, { message: "rate limit exceeded" }, { "retry-after": "0" });
  }
  const input = parseBody(body);
  const field = (...names: string[]) => at(input, ...names);
  if (method === "GET" && path === "/v1/users")
    return send(200, { id: "usr-e2e", name: "E2E Seller", email: "seller@example.com" });
  if (method === "GET" && path === "/v1/owners")
    return send(
      200,
      paged(
        [
          { id: "tea-sales1", name: "Sales", email: "seller@example.com", type: "team" },
          { id: "usr-e2e", name: "E2E Seller", email: "seller@example.com", type: "user" },
        ],
        "owner",
        query,
      ),
    );
  if (method === "GET" && path === "/v1/services") {
    const names = (query.get("name") ?? "").split(",").filter(Boolean);
    const owners = (query.get("ownerId") ?? "").split(",").filter(Boolean);
    const types = (query.get("type") ?? "").split(",").filter(Boolean);
    const rows = [...render.services.values()]
      .filter((service) => names.length === 0 || names.includes(service.name))
      .filter((service) => owners.length === 0 || owners.includes(service.ownerId))
      .filter(() => types.length === 0 || types.includes("static_site"))
      .map(serviceJson);
    return send(200, paged(rows, "service", query));
  }
  if (method === "POST" && path === "/v1/services") {
    render.serviceBodies.push(input);
    if (!render.visibleRepos.has(text(field("repo"))))
      return send(400, {
        id: "bad-request",
        message:
          "invalid repo: Render could not access the repository. Check that the Render GitHub App has access to it.",
      });
    if (
      [...render.services.values()].some(
        (service) => service.name === field("name") && service.ownerId === field("ownerId"),
      )
    )
      return send(409, { message: "service name already in use" });
    render.count += 1;
    const service: Service = {
      id: `srv-e2e${render.count}`,
      name: text(field("name")),
      ownerId: text(field("ownerId")),
      repo: text(field("repo")),
      branch: text(field("branch")),
      rootDir: text(field("rootDir")),
      autoDeployTrigger: text(field("autoDeployTrigger")) || "commit",
      suspended: "not_suspended",
      buildCommand: text(field("serviceDetails", "buildCommand")),
      publishPath: text(field("serviceDetails", "publishPath")) || "public",
      deploys: [],
      domains: [],
      env: new Map(),
      headers: [],
      routes: [],
    };
    render.services.set(service.id, service);
    const repoName = service.repo.replace("https://github.com/", "");
    const deploy = newDeploy(service, "api", github.repos.get(repoName)?.refs.get(service.branch) ?? null);
    return send(201, { service: serviceJson(service), deployId: deploy.id });
  }
  if (method === "GET" && path === "/v1/logs") {
    const service = render.services.get(String(query.get("resource")));
    if (!service || query.get("ownerId") !== service.ownerId) return send(400, { message: "invalid resource" });
    return send(200, {
      hasMore: false,
      nextStartTime: "",
      nextEndTime: "",
      logs: [
        { id: "l2", message: "==> Your site is live", timestamp: "2026-11-18T10:00:02Z", labels: [] },
        { id: "l1", message: "==> Uploading build...", timestamp: "2026-11-18T10:00:01Z", labels: [] },
      ],
    });
  }
  const match = /^\/v1\/services\/(srv-[a-z0-9]+)(\/.*)?$/.exec(path);
  const service = match ? render.services.get(match[1] ?? "") : undefined;
  if (!service) return send(404, { message: "not found" });
  const rest = match?.[2] ?? "";
  if (method === "GET" && rest === "") return send(200, serviceJson(service));
  if (method === "PATCH" && rest === "") {
    const build = field("serviceDetails", "buildCommand");
    const publish = field("serviceDetails", "publishPath");
    const trigger = field("autoDeployTrigger");
    if (typeof build === "string") service.buildCommand = build;
    if (typeof publish === "string") service.publishPath = publish;
    if (typeof trigger === "string") service.autoDeployTrigger = trigger;
    return send(200, serviceJson(service));
  }
  if (method === "DELETE" && rest === "") {
    render.services.delete(service.id);
    return send(204);
  }
  if (method === "POST" && (rest === "/suspend" || rest === "/resume")) {
    service.suspended = rest === "/suspend" ? "suspended" : "not_suspended";
    return send(202);
  }
  if (rest === "/deploys" && method === "GET")
    return send(200, paged(service.deploys.map(deployJson), "deploy", query));
  if (rest === "/deploys" && method === "POST") {
    render.deployBodies.push(input);
    const head = github.repos.get(service.repo.replace("https://github.com/", ""))?.refs.get(service.branch) ?? null;
    newDeploy(service, "api", text(field("commitId")) || head);
    // Render may answer 202 Queued with no body.
    return send(202);
  }
  const deploy = /^\/deploys\/(dep-[a-z0-9]+)$/.exec(rest);
  if (deploy && method === "GET") {
    const found = service.deploys.find((entry) => entry.id === deploy[1]);
    if (!found) return send(404, { message: "not found" });
    advance(found);
    return send(200, deployJson(found));
  }
  if (rest === "/custom-domains" && method === "GET") return send(200, paged(service.domains, "customDomain", query));
  if (rest === "/custom-domains" && method === "POST") {
    const name = text(field("name"));
    if ([...render.services.values()].some((other) => other.domains.some((domain) => domain.name === name)))
      return send(409, { message: "custom domain already exists" });
    const apex = name.split(".").length === 2;
    const twin = apex ? `www.${name}` : name.startsWith("www.") ? name.slice(4) : null;
    const added = [
      {
        id: `cdm-${name}`,
        name,
        domainType: apex ? "apex" : "subdomain",
        redirectForName: "",
        verificationStatus: "unverified",
      },
    ];
    if (twin)
      added.push({
        id: `cdm-${twin}`,
        name: twin,
        domainType: apex ? "subdomain" : "apex",
        redirectForName: name,
        verificationStatus: "unverified",
      });
    service.domains.push(...added);
    return send(
      201,
      added.map((domain) => ({ ...domain, publicSuffix: "test", createdAt: "2026-11-18T10:00:00Z" })),
    );
  }
  const domain = /^\/custom-domains\/([^/]+)(\/verify)?$/.exec(rest);
  if (domain) {
    const name = decodeURIComponent(domain[1] ?? "");
    const found = service.domains.find((entry) => entry.name === name || entry.id === name);
    if (!found) return send(404, { message: "custom domain not found" });
    if (domain[2] && method === "POST") {
      if (cnameReady(service, found.name)) found.verificationStatus = "verified";
      return send(202);
    }
    if (method === "GET") return send(200, found);
    if (method === "DELETE") {
      service.domains = service.domains.filter((entry) => entry !== found);
      return send(204);
    }
  }
  const env = /^\/env-vars\/([A-Za-z0-9_]+)$/.exec(rest);
  if (env && method === "PUT") {
    service.env.set(env[1] ?? "", text(field("value")));
    return send(200, { key: env[1] ?? "", value: text(field("value")) });
  }
  if (env && method === "DELETE")
    return service.env.delete(env[1] ?? "") ? send(204) : send(404, { message: "not found" });
  if (rest === "/headers" && method === "GET") return send(200, paged(service.headers, "header", query));
  if (rest === "/headers" && method === "PUT") {
    service.headers = entries(input).map((rule, index) => ({
      id: `hdr-${index}`,
      path: text(at(rule, "path")),
      name: text(at(rule, "name")),
      value: text(at(rule, "value")),
    }));
    return send(200, service.headers);
  }
  if (rest === "/routes" && method === "GET") return send(200, paged(service.routes, "route", query));
  if (rest === "/routes" && method === "PUT") {
    service.routes = entries(input).map((rule, index) => ({
      id: `rdr-${index}`,
      priority: index,
      type: text(at(rule, "type")),
      source: text(at(rule, "source")),
      destination: text(at(rule, "destination")),
    }));
    return send(200, service.routes);
  }
  return send(404, { message: "not found" });
}

// ---------- fake Cloudflare ----------

type DnsRecord = {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string | null;
};
const shopRecords: DnsRecord[] = [];
const brandRecords: DnsRecord[] = [];
const cloudflare = {
  zones: [
    { id: "zone0shop", name: "shop.test", status: "active", records: shopRecords, ssl: "full" },
    { id: "zone1brand", name: "brand.test", status: "active", records: brandRecords, ssl: "strict" },
  ],
  count: 0,
};
// The user's own records: the helper must never change them.
const USER_RECORDS: DnsRecord[] = [
  {
    id: "user-a",
    name: "taken.shop.test",
    type: "A",
    content: "203.0.113.7",
    proxied: true,
    ttl: 1,
    comment: "the old shop",
  },
  { id: "user-mx", name: "shop.test", type: "MX", content: "mail.shop.test", proxied: false, ttl: 1, comment: null },
  {
    id: "user-cname",
    name: "blog.shop.test",
    type: "CNAME",
    content: "blog.example.net",
    proxied: false,
    ttl: 1,
    comment: null,
  },
];
cloudflare.zones[0]?.records.push(...USER_RECORDS.map((record) => ({ ...record })));

function cloudflareHandle(
  method: string,
  path: string,
  query: URLSearchParams,
  body: string,
  response: ServerResponse,
) {
  const send = (status: number, result: EventCheckData, errors: EventCheckData[] = []) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: errors.length === 0, errors, messages: [], result }));
  };
  const list = (rows: EventCheckData[]) => {
    const page = Number(query.get("page") ?? 1);
    const perPage = Number(query.get("per_page") ?? 20);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: rows.slice((page - 1) * perPage, page * perPage),
        result_info: {
          page,
          per_page: perPage,
          count: rows.length,
          total_count: rows.length,
          total_pages: Math.max(1, Math.ceil(rows.length / perPage)),
        },
      }),
    );
  };
  if (method === "GET" && path === "/client/v4/zones") {
    assert.ok(Number(query.get("per_page")) <= 50, "Cloudflare lists at most 50 zones a page.");
    return list(
      cloudflare.zones.map(({ id, name, status }) => ({ id, name, status, account: { id: "acc", name: "Acme" } })),
    );
  }
  const match = /^\/client\/v4\/zones\/([a-z0-9]+)(\/.*)$/.exec(path);
  const zone = cloudflare.zones.find((entry) => entry.id === match?.[1]);
  if (!zone)
    return send(404, null, [
      { code: 7003, message: "Could not route to /zones, perhaps your object identifier is invalid?" },
    ]);
  const rest = match?.[2] ?? "";
  if (method === "GET" && rest === "/settings/ssl") return send(200, { id: "ssl", value: zone.ssl, editable: true });
  if (method === "GET" && rest === "/dns_records") {
    const name = query.get("name.exact");
    const comment = query.get("comment.exact");
    return list(
      zone.records.filter(
        (record) => (name === null || record.name === name) && (comment === null || record.comment === comment),
      ),
    );
  }
  const input = parseBody(body);
  const field = (name: string) => at(input, name);
  if (method === "POST" && rest === "/dns_records") {
    if (text(field("comment")).length > 100) return send(400, null, [{ code: 9102, message: "comment too long" }]);
    const name = text(field("name"));
    if (zone.records.some((record) => record.name === name && ["A", "AAAA", "CNAME"].includes(record.type)))
      return send(400, null, [{ code: 81053, message: "An A, AAAA, or CNAME record with that host already exists." }]);
    cloudflare.count += 1;
    const record: DnsRecord = {
      id: `rec${cloudflare.count}`,
      name,
      type: text(field("type")),
      content: text(field("content")),
      proxied: field("proxied") === true,
      ttl: Number(field("ttl")),
      comment: text(field("comment")) || null,
    };
    zone.records.push(record);
    return send(200, record);
  }
  const one = /^\/dns_records\/([a-z0-9-]+)$/.exec(rest);
  const record = zone.records.find((entry) => entry.id === one?.[1]);
  if (!record) return send(404, null, [{ code: 81044, message: "Record does not exist." }]);
  if (USER_RECORDS.some((user) => user.id === record.id))
    throw new Error(`The helper changed the user's record ${record.id}.`);
  if (method === "PATCH") {
    const content = field("content");
    const proxied = field("proxied");
    const comment = field("comment");
    if (typeof content === "string") record.content = content;
    if (typeof proxied === "boolean") record.proxied = proxied;
    if (typeof comment === "string") record.comment = comment;
    return send(200, record);
  }
  if (method === "DELETE") {
    zone.records = zone.records.filter((entry) => entry !== record);
    return send(200, { id: record.id });
  }
  return send(404, null, [{ code: 7000, message: "No route for that URI" }]);
}

// ---------- servers ----------

interface Recorded {
  service: string;
  method: string;
  path: string;
  auth: string;
}
const requests: Recorded[] = [];

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

type Handler = (method: string, path: string, query: URLSearchParams, body: string, response: ServerResponse) => void;

async function serve(service: string, token: string, handler: Handler): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    readBody(request)
      .then((body) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const auth = String(request.headers.authorization ?? "");
        const method = request.method ?? "GET";
        requests.push({ service, method, path: url.pathname, auth });
        if (auth !== `Bearer ${token}`) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              message: "Unauthorized",
              success: false,
              errors: [{ code: 10000, message: "Authentication error" }],
            }),
          );
          return;
        }
        handler(method, url.pathname, url.searchParams, body, response);
      })
      .catch((error) => {
        failures.push(`${service}: ${error instanceof Error ? error.message : String(error)}`);
        response.writeHead(500);
        response.end(String(error));
      });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}` };
}
const failures: string[] = [];

// ---------- helpers ----------

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: EventCheckData;
}

function run(env: Record<string, string>, args: string[], cwd?: string): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", TZ: "UTC", ...env }, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let json: EventCheckData = {};
      try {
        json = decodeTeamProtocolV2Json(JSON.parse(stdout || stderr));
      } catch {
        json = {};
      }
      resolvePromise({ code: code ?? -1, stdout, stderr, json });
    });
  });
}

function at(value: EventCheckData | undefined, ...path: (string | number)[]): EventCheckData | undefined {
  let current = value;
  for (const key of path) {
    if (current === undefined || current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) current = typeof key === "number" ? current[key] : undefined;
    else current = typeof key === "string" && Object.hasOwn(current, key) ? current[key] : undefined;
  }
  return current;
}

function entries(value: EventCheckData | undefined): EventCheckData[] {
  return Array.isArray(value) ? value : [];
}

async function auditLines(home: string): Promise<EventCheckData[]> {
  const text = await readFile(join(home, "audit.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => decodeTeamProtocolV2Json(JSON.parse(line)));
}

async function writeFiles(folder: string, files: Record<string, string>) {
  await rm(folder, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), content);
  }
}

function serviceNamed(name: string): Service {
  const found = [...render.services.values()].find((service) => service.name === name);
  assert.ok(found, `Render has the site ${name}.`);
  return found;
}

function zoneRecords(zoneName: string): DnsRecord[] {
  return cloudflare.zones.find((zone) => zone.name === zoneName)?.records ?? [];
}

// ---------- the test ----------

const report: { passed: boolean; checks: string[]; failure?: string } = { passed: false, checks: [] };
const check = (name: string) => report.checks.push(name);
const scratch = await mkdtemp(join(tmpdir(), "openbot-render-sites-e2e-"));
const renderServer = await serve("Render", RENDER_KEY, renderHandle);
const cloudflareServer = await serve("Cloudflare", CLOUDFLARE_TOKEN, cloudflareHandle);
const githubServer = await serve("GitHub", GITHUB_TOKEN, githubHandle);

try {
  const home = join(scratch, "home");
  const secretFile = async (name: string, value: string) => {
    const path = join(scratch, name);
    await writeFile(path, `${value}\n`, { mode: 0o600 });
    return path;
  };
  const env = {
    RENDER_API_BASE_URL: renderServer.url,
    CLOUDFLARE_API_BASE_URL: cloudflareServer.url,
    GITHUB_API_BASE_URL: githubServer.url,
    RENDER_API_KEY_FILE: await secretFile("RENDER_API_KEY", RENDER_KEY),
    CLOUDFLARE_API_TOKEN_FILE: await secretFile("CLOUDFLARE_API_TOKEN", CLOUDFLARE_TOKEN),
    GITHUB_TOKEN_FILE: await secretFile("GITHUB_TOKEN", GITHUB_TOKEN),
    RENDER_SITES_HOME: home,
    RENDER_SITES_ACTOR: "e2e-cso",
    RENDER_SITES_POLL_MS: "5",
    RENDER_SITES_BACKOFF_BASE_MS: "5",
    RENDER_SITES_TLS_CHECK: "off",
  };
  const outputs: string[] = [];
  const cli = async (...args: string[]) => {
    const result = await run(env, args);
    outputs.push(result.stdout, result.stderr);
    return result;
  };
  const landingA = join(scratch, "promo-a");
  const landingB = join(scratch, "promo-b");
  await writeFiles(landingA, {
    "index.html": "<h1>Promo A</h1>",
    "styles.css": "h1 { color: red; }",
    "img/hero.svg": "<svg/>",
    "old.html": "<p>old</p>",
  });
  await writeFiles(landingB, { "index.html": "<h1>Promo B</h1>" });

  // Settings, space folder, https only.
  let result = await run({}, ["config", "show"], scratch);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "keys", "RENDER_API_KEY"), "missing");
  const spaceRoot = join(scratch, "OpenBot");
  await mkdir(join(spaceRoot, "Agents", "agent-cso"), { recursive: true });
  await mkdir(join(spaceRoot, "Spaces"), { recursive: true });
  await writeFile(
    join(spaceRoot, "Spaces", "index.json"),
    JSON.stringify({
      general: join(spaceRoot, "Spaces", "general", "Shared"),
      agents: { "agent-cso": join(spaceRoot, "Spaces", "sales", "Shared") },
    }),
  );
  result = await run({}, ["config", "show"], join(spaceRoot, "Agents", "agent-cso"));
  assert.equal(
    at(result.json, "home"),
    join(spaceRoot, "Spaces", "sales", "Shared", "render-sites"),
    "The settings live in the space's shared folder.",
  );
  result = await run({ ...env, RENDER_API_BASE_URL: "http://example.com" }, ["owners"]);
  assert.equal(result.code, 1, "A plain-http address other than this computer is refused.");
  check("config: space shared folder, keys shown as missing, https only");

  // Keys: missing and unreadable files.
  result = await run({ ...env, RENDER_API_KEY_FILE: "" }, ["owners"]);
  assert.equal(result.code, 1);
  assert.match(String(at(result.json, "error", "details", "hint")), /request_api_key/);
  result = await run({ ...env, RENDER_API_KEY_FILE: join(scratch, "nope") }, ["owners"]);
  assert.equal(result.code, 1);
  assert.match(String(at(result.json, "error", "message")), /Cannot read the RENDER_API_KEY file/);
  result = await cli("whoami");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "render", "key"), "ok");
  assert.equal(at(result.json, "github", "login"), GITHUB_LOGIN);
  assert.deepEqual(
    entries(at(result.json, "cloudflare", "zones")).map((zone) => at(zone, "name")),
    ["shop.test", "brand.test"],
  );
  result = await run({ ...env, CLOUDFLARE_API_TOKEN_FILE: await secretFile("bad-cf", "e2e-wrong-cloudflare-token") }, [
    "whoami",
  ]);
  assert.equal(at(result.json, "cloudflare", "key"), "error");
  assert.equal(at(result.json, "cloudflare", "error", "status"), 401);
  assert.equal(at(result.json, "render", "key"), "ok", "One bad key does not hide the others.");
  check("keys: missing key hint, unreadable key file, whoami per key");

  // Two workspaces: the helper asks for one.
  result = await cli("create", "promo-a", "--dir", landingA);
  assert.equal(result.code, 1);
  assert.equal(entries(at(result.json, "error", "details", "owners")).length, 2);
  assert.equal(github.created.length, 0, "Nothing is pushed before the workspace is known.");
  result = await cli("config", "set", "ownerId", "tea-sales1");
  assert.equal(result.code, 0, result.stderr);
  check("owners: two workspaces need config set ownerId");

  // Files with secrets never leave.
  await writeFile(join(landingA, ".env"), "API_KEY=abc");
  result = await cli("create", "promo-a", "--dir", landingA);
  assert.equal(result.code, 1);
  assert.equal(at(result.json, "error", "details", "refused", 0, "path"), ".env");
  await rm(join(landingA, ".env"));
  await writeFile(join(landingA, "config.js"), `const token = "${GITHUB_TOKEN}";`);
  result = await cli("create", "promo-a", "--dir", landingA);
  assert.equal(result.code, 1);
  assert.equal(at(result.json, "error", "details", "refused", 0, "path"), "config.js");
  assert.ok(!result.stderr.includes(GITHUB_TOKEN));
  await rm(join(landingA, "config.js"));
  assert.equal(github.created.length, 0, "No repository is created for a refused folder.");
  check("secrets: .env files and key values in files are refused before any push");

  // Dry run.
  result = await cli("create", "promo-a", "--dir", landingA, "--dry-run");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "plan", "repo"), "acme-sales/landings");
  assert.equal(at(result.json, "plan", "folder"), "sites/promo-a");
  assert.equal(github.created.length, 0);
  check("create --dry-run: shows repo, folder and service body, changes nothing");

  // Render cannot read the repository yet.
  result = await cli("create", "promo-a", "--dir", landingA, "--reason", "Black Friday landing");
  assert.equal(result.code, 1);
  assert.equal(at(result.json, "error", "details", "code"), "repo_not_accessible");
  assert.match(String(at(result.json, "error", "details", "hint")), /github\.com\/settings\/installations/);
  assert.deepEqual(github.created, ["acme-sales/landings"]);
  assert.equal(github.repos.get("acme-sales/landings")?.private, true, "Landing repositories are private by default.");
  assert.equal(filesOf("acme-sales/landings").get("sites/promo-a/index.html"), "<h1>Promo A</h1>");
  check("errors: Render cannot read the repository, with the user's one-time steps");

  // The user gives Render access; the same command now works.
  render.visibleRepos.add("https://github.com/acme-sales/landings");
  const commitsBefore = github.commits.size;
  result = await cli("create", "promo-a", "--dir", landingA, "--reason", "Black Friday landing");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(github.commits.size, commitsBefore, "Unchanged files make no new commit.");
  assert.equal(at(result.json, "deploy", "status"), "live");
  assert.equal(at(result.json, "site", "url"), "https://promo-a.onrender.com");
  const body = render.serviceBodies.at(-1);
  assert.equal(at(body, "type"), "static_site");
  assert.equal(at(body, "ownerId"), "tea-sales1");
  assert.equal(at(body, "repo"), "https://github.com/acme-sales/landings");
  assert.equal(at(body, "branch"), "main");
  assert.equal(at(body, "rootDir"), "sites/promo-a");
  assert.equal(at(body, "autoDeployTrigger"), "commit");
  assert.equal(at(body, "serviceDetails", "publishPath"), ".");
  assert.equal(at(body, "serviceDetails", "buildCommand"), "");
  result = await cli("create", "promo-a", "--dir", landingA);
  assert.equal(result.code, 1, "A second site with the same name is refused.");
  assert.match(String(at(result.json, "error", "details", "hint")), /deploy promo-a/);
  result = await cli("create", "promo-b", "--dir", landingB);
  assert.equal(result.code, 0, result.stderr);
  const files = filesOf("acme-sales/landings");
  assert.equal(files.get("sites/promo-b/index.html"), "<h1>Promo B</h1>");
  assert.equal(files.get("sites/promo-a/img/hero.svg"), "<svg/>", "A new landing leaves the other folders alone.");
  check("create: repo, one folder per landing, static site body, first deploy live, duplicate refused");

  // Redeploy with new files: only promo-a deploys.
  const promoB = serviceNamed("promo-b");
  const promoBDeploys = promoB.deploys.length;
  await writeFiles(landingA, {
    "index.html": "<h1>Promo A v2</h1>",
    "styles.css": "h1 { color: red; }",
    "img/hero.svg": "<svg/>",
  });
  result = await cli("deploy", "promo-a", "--dir", landingA, "--message", "New headline");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "deploy", "status"), "live");
  assert.equal(
    at(result.json, "deploy", "trigger"),
    "new_commit",
    "The helper waits for Render's auto-deploy of the commit.",
  );
  assert.equal(at(result.json, "push", "uploaded"), 1, "Only the changed file is uploaded.");
  assert.equal(at(result.json, "push", "deleted"), 1);
  const after = filesOf("acme-sales/landings");
  assert.equal(after.get("sites/promo-a/index.html"), "<h1>Promo A v2</h1>");
  assert.equal(after.has("sites/promo-a/old.html"), false, "A file that the landing no longer has is deleted.");
  assert.equal(after.get("sites/promo-b/index.html"), "<h1>Promo B</h1>");
  assert.equal(after.get("README.md"), "# landings\n");
  assert.equal(promoB.deploys.length, promoBDeploys, "A push to promo-a's folder does not deploy promo-b.");
  result = await cli("deploy", "promo-a", "--dir", landingA);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "deploy"), null, "The same files deploy nothing.");
  result = await cli("deploy", "promo-a");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "deploy", "status"), "live", "A 202 with no body is followed by the last deploy.");
  render.failNextBuild = true;
  result = await cli("deploy", "promo-a", "--clear-cache");
  assert.equal(result.code, 1, "A failed build is an error.");
  assert.equal(at(result.json, "error", "details", "deploy", "status"), "build_failed");
  assert.equal(at(render.deployBodies.at(-1), "clearCache"), "clear");
  result = await cli("logs", "promo-a");
  assert.equal(at(result.json, "logs", 1, "message"), "==> Your site is live");
  check("deploy: one commit, only changed blobs, deletions in the folder, per-folder auto-deploy, failed build, logs");

  // Rate limit.
  render.rateLimitNext = 1;
  result = await cli("deploys", "promo-a");
  assert.equal(result.code, 0, result.stderr);
  assert.ok(entries(at(result.json, "data")).length >= 3);
  check("rate limit: a 429 with Retry-After is waited out");

  // Domains.
  const promoA = serviceNamed("promo-a");
  result = await cli("domain", "add", "promo-a", "go.shop.test", "--dry-run");
  assert.equal(at(result.json, "plan", "zone"), "shop.test");
  assert.equal(promoA.domains.length, 0);
  result = await cli("domain", "add", "promo-a", "go.shop.test", "--reason", "Black Friday URL");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(at(result.json, "verification", "go.shop.test"), "verified");
  assert.equal(at(result.json, "link"), "https://go.shop.test");
  const record = zoneRecords("shop.test").find((entry) => entry.name === "go.shop.test");
  assert.deepEqual(
    record && { type: record.type, content: record.content, proxied: record.proxied, comment: record.comment },
    { type: "CNAME", content: "promo-a.onrender.com", proxied: false, comment: `openbot-render:${promoA.id}` },
    "A DNS-only CNAME to the onrender.com host, with the helper's marker.",
  );
  result = await cli("domain", "add", "promo-a", "go.shop.test");
  assert.equal(result.code, 0, `Adding the same domain again is safe: ${result.stderr}`);
  assert.equal(zoneRecords("shop.test").filter((entry) => entry.name === "go.shop.test").length, 1);
  result = await cli("domain", "add", "promo-b", "brand.test");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(entries(at(result.json, "domains")).sort(), ["brand.test", "www.brand.test"]);
  assert.equal(at(result.json, "verification", "www.brand.test"), "verified", "Render's www twin gets its record too.");
  assert.equal(
    zoneRecords("brand.test").filter((entry) => entry.type === "CNAME").length,
    2,
    "The apex uses a CNAME (Cloudflare flattens it).",
  );
  check("domain add: zone found, DNS-only CNAME with marker, Render verifies, repeat is safe, apex with www twin");

  result = await cli("domain", "add", "promo-a", "taken.shop.test");
  assert.equal(result.code, 1);
  assert.equal(at(result.json, "error", "details", "code"), "dns_conflict");
  assert.equal(
    promoA.domains.some((domain) => domain.name === "taken.shop.test"),
    false,
    "A conflict stops before Render.",
  );
  result = await cli("domain", "add", "promo-a", "go.unknown.test");
  assert.equal(result.code, 1);
  assert.equal(at(result.json, "error", "details", "code"), "zone_not_found");
  assert.deepEqual(entries(at(result.json, "error", "details", "zones")), ["shop.test", "brand.test"]);
  result = await cli("domain", "add", "promo-a", "https://bad/path");
  assert.equal(result.code, 2);
  check("domain errors: another record is a conflict, zone not found, bad hostname");

  result = await cli("domain", "proxy", "promo-a", "go.shop.test", "on");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(record?.proxied, true);
  const shop = cloudflare.zones.find((zone) => zone.name === "shop.test");
  if (shop) shop.ssl = "flexible";
  result = await cli("domain", "proxy", "promo-a", "go.shop.test", "off");
  assert.equal(record?.proxied, false);
  result = await cli("domain", "proxy", "promo-a", "go.shop.test", "on");
  assert.equal(result.code, 1, "The proxy stays off with SSL mode Flexible.");
  assert.equal(record?.proxied, false);
  result = await cli("domain", "proxy", "promo-a", "blog.shop.test", "on");
  assert.equal(result.code, 1, "The helper does not proxy a record it did not make.");
  result = await cli("domain", "list", "promo-a");
  assert.equal(at(result.json, "data", 0, "dns", "byHelper"), true);
  check("domain proxy: only after verification, refused with SSL Flexible, never on the user's records");

  // Updates.
  const headersFile = join(scratch, "headers.json");
  await writeFile(headersFile, JSON.stringify([{ path: "/*", name: "X-Frame-Options", value: "DENY" }]));
  result = await cli(
    "update",
    "promo-a",
    "--build-command",
    "npm run build",
    "--publish-path",
    "dist",
    "--env",
    "PUBLIC_API=https://api.shop.test/e2e-env-value",
    "--headers",
    `@${headersFile}`,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(promoA.buildCommand, "npm run build");
  assert.equal(promoA.publishPath, "dist");
  assert.equal(promoA.env.get("PUBLIC_API"), "https://api.shop.test/e2e-env-value");
  assert.equal(promoA.headers[0]?.name, "X-Frame-Options");
  const updateAudit = await readFile(join(home, "audit.jsonl"), "utf8");
  assert.ok(!updateAudit.includes("e2e-env-value"), "Environment values stay out of the audit log.");
  check("update: build settings, env var, headers; env values not audited");

  // Refusals and approved changes.
  result = await cli("suspend", "promo-a");
  assert.equal(result.code, 3);
  assert.equal(promoA.suspended, "not_suspended");
  result = await cli("suspend", "promo-a", "--approved");
  assert.equal(promoA.suspended, "suspended");
  result = await cli("resume", "promo-a");
  assert.equal(promoA.suspended, "not_suspended");
  result = await cli("domain", "remove", "promo-a", "go.shop.test");
  assert.equal(result.code, 3);
  assert.ok(zoneRecords("shop.test").some((entry) => entry.name === "go.shop.test"));
  result = await cli("delete", "promo-b");
  assert.equal(result.code, 3, "delete without --approved is refused.");
  assert.equal(at(result.json, "refused"), true);
  assert.ok(render.services.has(promoB.id));
  result = await cli("delete", "promo-b", "--approved", "--reason", "the user asked to remove promo-b");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(render.services.has(promoB.id), false);
  assert.deepEqual(entries(at(result.json, "dnsRemoved")).sort(), ["brand.test", "www.brand.test"]);
  assert.equal(zoneRecords("brand.test").length, 0);
  result = await cli("domain", "remove", "promo-a", "go.shop.test", "--approved");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    zoneRecords("shop.test").some((entry) => entry.name === "go.shop.test"),
    false,
  );
  for (const user of USER_RECORDS)
    assert.deepEqual(
      zoneRecords("shop.test").find((entry) => entry.id === user.id),
      user,
      `The user's record ${user.name} is unchanged.`,
    );
  check("approval: suspend, delete and domain remove need --approved; delete removes only the helper's records");

  // One repository per landing, into an empty repository the user made.
  github.repos.set("acme-sales/empty-landing", { defaultBranch: "main", private: true, refs: new Map() });
  result = await cli("create", "solo", "--dir", landingB, "--repo", "acme-sales/empty-landing", "--no-wait");
  assert.equal(result.code, 0, result.stderr);
  serviceNamed("solo");
  assert.equal(
    at(render.serviceBodies.at(-1), "rootDir"),
    undefined,
    "One repository per landing builds from its root.",
  );
  assert.equal(filesOf("acme-sales/empty-landing").get("index.html"), "<h1>Promo B</h1>");
  assert.equal(at(result.json, "deploy", "status"), "created");
  result = await cli("wait", "solo");
  assert.equal(at(result.json, "deploy", "status"), "live");
  check("repo-per-site: an empty repository gets a first commit, the site builds from its root, wait");

  // The audit log.
  const audit = await auditLines(home);
  const actions = audit.map((line) => `${at(line, "action")}:${at(line, "result")}`);
  for (const expected of [
    "repo-create:ok",
    "push:ok",
    "site-create:error",
    "site-create:ok",
    "deploy:ok",
    "domain-add:ok",
    "dns-create:ok",
    "dns-proxy:ok",
    "env-set:ok",
    "suspend:refused",
    "delete:refused",
    "delete:ok",
    "dns-delete:ok",
    "domain-remove:refused",
    "domain-remove:ok",
  ])
    assert.ok(actions.includes(expected), `The audit log has ${expected}.`);
  const created = audit.find((line) => at(line, "action") === "site-create" && at(line, "result") === "ok");
  assert.equal(at(created, "actor"), "e2e-cso");
  assert.equal(at(created, "reason"), "Black Friday landing");
  check(`audit: every change, refusal and error with actor and reason (${audit.length} lines)`);

  const auditText = await readFile(join(home, "audit.jsonl"), "utf8");
  for (const text of [...outputs, auditText])
    for (const secret of [RENDER_KEY, CLOUDFLARE_TOKEN, GITHUB_TOKEN])
      assert.ok(!text.includes(secret), "An output holds a key.");
  for (const request of requests)
    assert.ok(
      request.auth === `Bearer ${RENDER_KEY}` ||
        request.auth === `Bearer ${CLOUDFLARE_TOKEN}` ||
        request.auth === `Bearer ${GITHUB_TOKEN}` ||
        request.auth.startsWith("Bearer e2e-wrong"),
      "Each request carries its own service's key.",
    );
  assert.ok(
    requests.filter((request) => request.service === "Render").every((request) => !request.auth.includes(GITHUB_TOKEN)),
  );
  check("secrets: no output or audit line holds a key; each key goes only to its own service");

  assert.deepEqual(failures, [], "The fake servers saw no failure.");
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  for (const { server } of [renderServer, cloudflareServer, githubServer]) server.close();
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(scratch, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
