import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENDPOINT = "https://api.linear.app/graphql";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_ITEMS = 2000;
// Reserve room under OpenBot's 100,000-character event prompt limit for the
// saved intake instruction and native framing. Payloads contain IDs/revisions/authorship.
const MAX_EVENT_DATA_CHARS = 90000;
// Explicit uncertainty marker, never a user identity. The user authorizes delivery
// for mixed/missing authorship; native exclusion compares only real account UUIDs.
export const UNKNOWN_ACTOR = "unknown";
const HISTORY_SIZE = 10;
// Comments carry their own page limit. Nested connections raise the query cost, so a check that reads
// comments asks for smaller pages.
const COMMENT_WINDOW = 25;
const COMMENT_PAGE_SIZE = 25;
const MAX_LABELS = 50;
const MAX_FILTER_NAMES = 20;
const MAX_FILTER_NAME_LENGTH = 100;
// The check stops asking when Linear reports this few requests left, until the window resets.
const RATE_LIMIT_FLOOR = 5;
const CODES = ["auth", "rate_limited", "config", "upstream"];

const identityFields = `
  organization { id urlKey }
  viewer { id email }
  team(id: $teamId) { id key }
`;

/** The query for one page of issues. Optional parts are asked for only when a setting needs them. */
export function buildIssueQuery({ delegate = false, state = false, labels = false, comments = false } = {}) {
  const historyExtras = [state ? "fromStateId toStateId" : "", labels ? "addedLabelIds removedLabelIds" : ""]
    .filter(Boolean)
    .join(" ");
  return `query AssignedIntakeIssues(
  $teamId: String!, $filter: IssueFilter!, $first: Int!, $after: String
) {
  ${identityFields}
  issues(first: $first, after: $after, filter: $filter,
         includeArchived: true, orderBy: createdAt) {
    nodes {
      id title description createdAt updatedAt assignee { id } team { id }
      ${delegate ? "delegate { id }" : ""}
      ${state ? "state { id name }" : ""}
      ${labels ? `labels(first: ${MAX_LABELS}) { nodes { id name } pageInfo { hasNextPage } }` : ""}
      ${comments ? `comments(last: ${COMMENT_WINDOW}, orderBy: updatedAt) { nodes { id updatedAt user { id } } pageInfo { hasPreviousPage } }` : ""}
      history(last: ${HISTORY_SIZE}, orderBy: updatedAt, includeArchived: true) {
        nodes {
          actorId descriptionUpdatedBy { id } createdAt updatedAt
          fromTitle toTitle updatedDescription toAssigneeId toTeamId ${historyExtras}
        }
        pageInfo { hasPreviousPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
}

export const PROJECT_QUERY = `query AssignedIntakeProjects(
  $teamId: String!, $filter: ProjectFilter!, $first: Int!, $after: String
) {
  ${identityFields}
  projects(first: $first, after: $after, filter: $filter,
           includeArchived: true, orderBy: createdAt) {
    nodes {
      id createdAt updatedAt lead { id }
      history(last: ${HISTORY_SIZE}, orderBy: updatedAt, includeArchived: true) {
        nodes { entries createdAt updatedAt }
        pageInfo { hasPreviousPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** A failure with fixed wording. The optional code is one of CODES and tells OpenBot why, in its own words. */
class WatcherError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = CODES.includes(code) ? code : null;
  }
}

function requireCondition(condition, message, code = null) {
  if (!condition) throw new WatcherError(message, code);
}

function requiredString(value, name) {
  requireCondition(typeof value === "string" && value.length > 0, `Missing or invalid ${name}.`, "config");
  return value;
}

function booleanSetting(value, name, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  requireCondition(value === "true" || value === "false", `${name} must be true or false.`, "config");
  return value === "true";
}

/** A list setting: names separated by commas or lines. Empty means no filter. */
function nameList(value, name) {
  if (value === undefined || value === null || value === "") return [];
  requireCondition(typeof value === "string", `${name} must be a list of names.`, "config");
  const names = [
    ...new Set(
      value
        .split(/[,\n]/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  requireCondition(
    names.length <= MAX_FILTER_NAMES && names.every((entry) => entry.length <= MAX_FILTER_NAME_LENGTH),
    `${name} has too many names or a name that is too long.`,
    "config",
  );
  return names;
}

function readConfiguration(input) {
  requireCondition(input && typeof input === "object" && !Array.isArray(input), "Expected a JSON object.", "config");
  const config = {};
  for (const name of [
    "instanceId",
    "workspaceId",
    "workspaceSlug",
    "assigneeId",
    "assigneeEmail",
    "teamId",
    "teamKey",
  ]) {
    config[name] = requiredString(input[name], name);
  }
  config.pageSize = Number(input.pageSize ?? 100);
  requireCondition(
    Number.isInteger(config.pageSize) && config.pageSize >= 1 && config.pageSize <= 100,
    "pageSize must be an integer from 1 to 100.",
    "config",
  );
  config.stateFilter = nameList(input.stateFilter, "stateFilter");
  config.labelFilter = nameList(input.labelFilter, "labelFilter");
  const delegate = input.delegateId;
  requireCondition(
    delegate === undefined || delegate === null || typeof delegate === "string",
    "delegateId must be text.",
    "config",
  );
  config.delegateId = typeof delegate === "string" && delegate.trim() ? delegate.trim() : null;
  config.includeComments = booleanSetting(input.includeComments, "includeComments", false);
  config.includeProjects = booleanSetting(input.includeProjects, "includeProjects", true);
  if (config.includeComments) config.pageSize = Math.min(config.pageSize, COMMENT_PAGE_SIZE);
  return config;
}

function scopeHash(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function readCursor(raw, scope) {
  if (raw === undefined || raw === null || raw === "") {
    return { phase: "issues", after: null, pages: 0, total: 0, scope, seen: [], eventChars: 2 };
  }
  requireCondition(
    typeof raw === "string" && /^[A-Za-z0-9_-]+$/.test(raw) && raw.length < 8192,
    "Invalid paging cursor.",
    "upstream",
  );
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new WatcherError("Invalid paging cursor.", "upstream");
  }
  requireCondition(
    cursor &&
      ["issues", "projects"].includes(cursor.phase) &&
      (cursor.after === null || (typeof cursor.after === "string" && cursor.after.length > 0)) &&
      Number.isInteger(cursor.pages) &&
      cursor.pages >= 1 &&
      cursor.pages < MAX_PAGES &&
      Number.isInteger(cursor.total) &&
      cursor.total >= 0 &&
      cursor.total <= MAX_ITEMS &&
      cursor.scope === scope &&
      Array.isArray(cursor.seen) &&
      cursor.seen.length <= MAX_PAGES &&
      Number.isInteger(cursor.eventChars) &&
      cursor.eventChars >= 2 &&
      cursor.eventChars <= MAX_EVENT_DATA_CHARS &&
      cursor.seen.every((s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s)),
    "Invalid paging cursor.",
    "upstream",
  );
  return cursor;
}

async function readResponse(response) {
  requireCondition(
    response.body && typeof response.body.getReader === "function",
    "Missing API response body.",
    "upstream",
  );
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      requireCondition(total <= MAX_RESPONSE_BYTES, "API response exceeds the safe size limit.", "upstream");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WatcherError("Invalid JSON API response.", "upstream");
  }
}

// Only a server-directed cooldown timestamp persists, separately per saved instance.
// No account contents, credentials, polling checkpoints or AI state are stored here.
const cooldownStore = {
  async read(instanceId) {
    const filename = cooldownFilename(instanceId);
    try {
      const timestamp = Number(await fs.readFile(filename, "utf8"));
      requireCondition(Number.isFinite(timestamp) && timestamp >= 0, "Invalid API cooldown state.", "upstream");
      return timestamp;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw new WatcherError("Cannot read API cooldown state.", "upstream");
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
      throw new WatcherError("Cannot save API cooldown state.", "upstream");
    }
  },
};

function cooldownFilename(instanceId) {
  const key = createHash("sha256").update(instanceId).digest("hex");
  return path.join(path.dirname(fileURLToPath(import.meta.url)), ".linear-intake-cooldowns", key);
}

/** The time Linear tells us to wait until, from its headers. At least a minute from now. */
function cooldownUntil(response, nowMs) {
  let until = nowMs + 60000;
  const retry = response.headers.get("retry-after");
  if (retry) {
    const seconds = Number(retry);
    const timestamp = Number.isFinite(seconds) ? nowMs + Math.max(0, seconds) * 1000 : Date.parse(retry);
    if (Number.isFinite(timestamp)) until = Math.max(until, timestamp);
  }
  for (const name of [
    "x-ratelimit-requests-reset",
    "x-ratelimit-complexity-reset",
    "x-ratelimit-endpoint-requests-reset",
  ]) {
    const timestamp = Number(response.headers.get(name));
    if (Number.isFinite(timestamp)) until = Math.max(until, timestamp);
  }
  return until;
}

async function saveCooldown(response, instanceId, store, nowMs) {
  await store.write(instanceId, cooldownUntil(response, nowMs));
  throw new WatcherError("Linear API rate limit reached; server-directed cooldown is active.", "rate_limited");
}

/** Stops the next run early when Linear says almost no requests are left. The current page is still good. */
async function noteRemainingRequests(response, instanceId, store, nowMs) {
  const header = response.headers.get("x-ratelimit-requests-remaining");
  const reset = Number(response.headers.get("x-ratelimit-requests-reset"));
  if (header === null || !(Number(header) <= RATE_LIMIT_FLOOR) || !Number.isFinite(reset) || reset <= nowMs) return;
  await store.write(instanceId, reset);
}

function validateIdentity(data, config) {
  requireCondition(
    data?.organization?.id === config.workspaceId && data.organization.urlKey === config.workspaceSlug,
    "API token workspace does not match the configured workspace.",
    "config",
  );
  requireCondition(
    data.viewer?.id === config.assigneeId && data.viewer.email?.toLowerCase() === config.assigneeEmail.toLowerCase(),
    "API token must belong to the configured user.",
    "config",
  );
  requireCondition(
    data.team?.id === config.teamId && data.team.key === config.teamKey,
    "API team does not match the configured team.",
    "config",
  );
}

function authorWindow(input) {
  const since = typeof input.since === "string" ? Date.parse(input.since) : NaN;
  const until = typeof input.until === "string" ? Date.parse(input.until) : NaN;
  return Number.isFinite(since) && Number.isFinite(until) && since < until ? { since, until } : null;
}

function userId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

// History is supplementary attribution, not requested content coverage. Insufficient
// history passes through as unknown; it must never hide a content change or stop polling.
function recentHistory(history, window) {
  if (
    !window ||
    !Array.isArray(history?.nodes) ||
    history.nodes.length > HISTORY_SIZE ||
    typeof history.pageInfo?.hasPreviousPage !== "boolean"
  )
    return null;
  const rows = history.nodes.map((row) => ({
    row,
    created: Date.parse(row?.createdAt),
    updated: Date.parse(row?.updatedAt),
  }));
  if (
    rows.some(
      ({ created, updated }, i) =>
        !Number.isFinite(created) ||
        !Number.isFinite(updated) ||
        created > updated ||
        updated > window.until ||
        (i > 0 && updated < rows[i - 1].updated),
    )
  )
    return null;
  if (history.pageInfo.hasPreviousPage && (!rows.length || rows[0].updated >= window.since)) return null;
  return rows.filter(({ updated }) => updated >= window.since);
}

function optionalIdList(value) {
  return value === null || value === undefined || (Array.isArray(value) && value.every((id) => typeof id === "string"));
}

// The author of the comments that changed in the window, or UNKNOWN_ACTOR when it cannot be told.
function commentAuthors(node, window) {
  const authors = new Set();
  for (const comment of node.comments?.nodes ?? []) {
    const updated = Date.parse(comment?.updatedAt);
    if (!Number.isFinite(updated)) return null;
    if (updated < window.since) continue;
    const author = userId(comment.user?.id);
    if (!author) return null;
    authors.add(author);
  }
  return authors;
}

function issueActor(node, window, config) {
  const entityUpdated = Date.parse(node.updatedAt);
  const entityCreated = Date.parse(node.createdAt);
  // A subsequent edit cannot identify who introduced a newly created entity.
  if (
    !window ||
    !Number.isFinite(entityCreated) ||
    !Number.isFinite(entityUpdated) ||
    entityCreated > entityUpdated ||
    entityCreated >= window.since ||
    entityUpdated > window.until
  )
    return UNKNOWN_ACTOR;
  const rows = recentHistory(node.history, window);
  if (!rows) return UNKNOWN_ACTOR;
  const authors = new Set();
  let terminalTitle;
  for (const { row, created } of rows) {
    for (const key of ["fromTitle", "toTitle", "toAssigneeId", "toTeamId"]) {
      if (row[key] !== null && typeof row[key] !== "string") return UNKNOWN_ACTOR;
    }
    if (row.updatedDescription !== null && typeof row.updatedDescription !== "boolean") return UNKNOWN_ACTOR;
    if (row.descriptionUpdatedBy !== null && !Array.isArray(row.descriptionUpdatedBy)) return UNKNOWN_ACTOR;
    if (row.updatedDescription !== true && row.descriptionUpdatedBy?.length) return UNKNOWN_ACTOR;
    const title = row.fromTitle != null || row.toTitle != null;
    const description = row.updatedDescription === true;
    const assignment = row.toAssigneeId != null || row.toTeamId != null;
    // A state or label change only counts for a check that puts it in the revision.
    const stateChange = config.stateFilter.length > 0 && row.toStateId != null;
    const labelChange =
      config.labelFilter.length > 0 && (row.addedLabelIds?.length > 0 || row.removedLabelIds?.length > 0);
    if (!optionalIdList(row.addedLabelIds) || !optionalIdList(row.removedLabelIds)) return UNKNOWN_ACTOR;
    if (!title && !description && !assignment && !stateChange && !labelChange) continue; // Other actors do not identify edits.
    if (title && (typeof row.fromTitle !== "string" || typeof row.toTitle !== "string")) return UNKNOWN_ACTOR;
    if (
      (row.toAssigneeId !== null && row.toAssigneeId !== node.assignee.id) ||
      (row.toTeamId !== null && row.toTeamId !== node.team.id) ||
      (stateChange && row.toStateId !== node.state.id)
    )
      return UNKNOWN_ACTOR;
    // An old group refreshed recently cannot date its individual content edits.
    if (created < window.since) return UNKNOWN_ACTOR;
    if (title || assignment || stateChange || labelChange) {
      const actor = userId(row.actorId);
      if (!actor) return UNKNOWN_ACTOR;
      authors.add(actor);
    }
    if (title) terminalTitle = row.toTitle;
    if (description) {
      if (!Array.isArray(row.descriptionUpdatedBy) || !row.descriptionUpdatedBy.length) return UNKNOWN_ACTOR;
      for (const editor of row.descriptionUpdatedBy) {
        const actor = userId(editor?.id);
        if (!actor) return UNKNOWN_ACTOR;
        authors.add(actor);
      }
    }
    if (authors.size > 1) return UNKNOWN_ACTOR;
  }
  if (terminalTitle !== undefined && terminalTitle !== node.title) return UNKNOWN_ACTOR;
  if (config.includeComments) {
    const commenters = commentAuthors(node, window);
    if (!commenters) return UNKNOWN_ACTOR;
    for (const commenter of commenters) authors.add(commenter);
    if (node.comments?.pageInfo?.hasPreviousPage === true && commenters.size === 0) return UNKNOWN_ACTOR;
  }
  return authors.size === 1 ? [...authors][0] : UNKNOWN_ACTOR;
}

function projectActor(node, config, window) {
  const entityUpdated = Date.parse(node.updatedAt);
  const entityCreated = Date.parse(node.createdAt);
  if (
    !window ||
    !Number.isFinite(entityCreated) ||
    !Number.isFinite(entityUpdated) ||
    entityCreated > entityUpdated ||
    entityCreated >= window.since ||
    entityUpdated > window.until
  )
    return UNKNOWN_ACTOR;
  const rows = recentHistory(node.history, window);
  if (!rows) return UNKNOWN_ACTOR;
  const authors = new Set();
  for (const { row } of rows) {
    if (!Array.isArray(row.entries)) return UNKNOWN_ACTOR;
    for (const entry of row.entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.type !== "string" ||
        !entry.type.trim()
      )
        return UNKNOWN_ACTOR;
      if (entry?.type !== "leadId") continue;
      if (!Number.isFinite(entry.at)) return UNKNOWN_ACTOR;
      if (entry.at < window.since) continue;
      if (entry.at > window.until || entry.to !== config.assigneeId) return UNKNOWN_ACTOR;
      const actor = userId(entry.actorId);
      if (!actor) return UNKNOWN_ACTOR;
      authors.add(actor);
      if (authors.size > 1) return UNKNOWN_ACTOR;
    }
  }
  return authors.size === 1 ? [...authors][0] : UNKNOWN_ACTOR;
}

/**
 * The revision of an issue. It always holds the title and the description. A setting adds one part
 * more, so a check that sets none behaves as version 1.0.0 did: a state filter adds the state, a
 * label filter adds the labels, and comments add the ID and update time of each recent comment.
 */
export function issueRevision(node, config) {
  const parts = [node.title, node.description];
  if (config.stateFilter.length) parts.push(["state", node.state.name]);
  if (config.labelFilter.length) parts.push(["labels", node.labels.nodes.map((label) => label.name).sort()]);
  if (config.includeComments)
    parts.push([
      "comments",
      node.comments.nodes.map((comment) => [comment.id, comment.updatedAt]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    ]);
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

function inScope(node, config) {
  if (node.team?.id !== config.teamId) return false;
  if (node.assignee?.id === config.assigneeId) return true;
  return config.delegateId !== null && node.delegate?.id === config.delegateId;
}

function mapItems(nodes, phase, config, window) {
  const ids = new Set();
  return nodes.map((node) => {
    const id = requiredString(node?.id, "item ID");
    requireCondition(!ids.has(id), "Duplicate item ID in API page.", "upstream");
    ids.add(id);
    if (phase === "issues") {
      requireCondition(inScope(node, config), "API returned an issue outside the configured scope.", "upstream");
      requireCondition(
        typeof node.title === "string" && (node.description === null || typeof node.description === "string"),
        "Missing complete issue content.",
        "upstream",
      );
      if (config.stateFilter.length)
        requireCondition(
          typeof node.state?.name === "string" && config.stateFilter.includes(node.state.name),
          "API returned an issue outside the state filter.",
          "upstream",
        );
      if (config.labelFilter.length)
        requireCondition(
          Array.isArray(node.labels?.nodes) &&
            node.labels.nodes.every((label) => typeof label?.name === "string") &&
            node.labels.nodes.some((label) => config.labelFilter.includes(label.name)),
          "API returned an issue outside the label filter.",
          "upstream",
        );
      if (config.includeComments)
        requireCondition(
          Array.isArray(node.comments?.nodes) &&
            node.comments.nodes.every(
              (comment) => typeof comment?.id === "string" && typeof comment?.updatedAt === "string",
            ),
          "Missing complete issue comments.",
          "upstream",
        );
      return { id: `i:${id}`, revision: issueRevision(node, config), actor: issueActor(node, window, config) };
    }
    requireCondition(node.lead?.id === config.assigneeId, "API returned a project led by another user.", "upstream");
    return { id: `p:${id}`, revision: "assigned-project-v1", actor: projectActor(node, config, window) };
  });
}

function issueFilter(config) {
  const scope = config.delegateId
    ? { or: [{ assignee: { id: { eq: config.assigneeId } } }, { delegate: { id: { eq: config.delegateId } } }] }
    : { assignee: { id: { eq: config.assigneeId } } };
  return {
    team: { id: { eq: config.teamId } },
    ...scope,
    ...(config.stateFilter.length ? { state: { name: { in: config.stateFilter } } } : {}),
    ...(config.labelFilter.length ? { labels: { some: { name: { in: config.labelFilter } } } } : {}),
  };
}

function authFailure(result, status) {
  const codes = Array.isArray(result?.errors) ? result.errors.map((error) => error?.extensions?.code) : [];
  return status === 401 || status === 403 || codes.includes("AUTHENTICATION_ERROR") || codes.includes("FORBIDDEN");
}

function httpFailure(status) {
  const code = Number(status);
  if (code === 401 || code === 403) return new WatcherError(`Linear rejected the API key (HTTP ${code}).`, "auth");
  if (code === 429) return new WatcherError("Linear API rate limit reached.", "rate_limited");
  return new WatcherError(`Linear API HTTP ${code || "error"}.`, "upstream");
}

/** One read-only page. OpenBot collects every page before comparing its baseline. */
export async function runWatcher(
  input,
  { token = process.env.LINEAR_API_TOKEN, fetchImpl = fetch, store = cooldownStore, now = () => Date.now() } = {},
) {
  requireCondition(
    typeof token === "string" && token.trim().length > 0,
    "Missing LINEAR_API_TOKEN private variable.",
    "auth",
  );
  requireCondition(!/[\r\n]/.test(token), "Invalid LINEAR_API_TOKEN private variable.", "auth");
  const config = readConfiguration(input);
  const cursor = readCursor(input.cursor, scopeHash(config));
  requireCondition(
    (await store.read(config.instanceId)) <= now(),
    "Linear API cooldown is active; no request was sent.",
    "rate_limited",
  );
  const filter =
    cursor.phase === "issues"
      ? issueFilter(config)
      : { lead: { id: { eq: config.assigneeId } }, accessibleTeams: { some: { id: { eq: config.teamId } } } };
  const query =
    cursor.phase === "issues"
      ? buildIssueQuery({
          delegate: config.delegateId !== null,
          state: config.stateFilter.length > 0,
          labels: config.labelFilter.length > 0,
          comments: config.includeComments,
        })
      : PROJECT_QUERY;
  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let result;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: token.trim() },
      body: JSON.stringify({
        query,
        variables: { teamId: config.teamId, filter, first: config.pageSize, after: cursor.after },
      }),
    });
    if (response.status === 429) await saveCooldown(response, config.instanceId, store, now());
    try {
      result = await readResponse(response);
    } catch (error) {
      // A rejected key can come with a body that is not JSON.
      if (response.status === 401 || response.status === 403) throw httpFailure(response.status);
      throw error;
    }
  } catch (error) {
    // Only these locally authored messages may reach stderr; never echo fetch/server errors.
    if (error instanceof WatcherError) throw error;
    throw new WatcherError("Linear API request failed or timed out.", "upstream");
  } finally {
    clearTimeout(timer);
  }
  requireCondition(
    result && typeof result === "object" && !Array.isArray(result),
    "Invalid JSON API result.",
    "upstream",
  );
  if (Array.isArray(result.errors) && result.errors.some((e) => e?.extensions?.code === "RATELIMITED")) {
    await saveCooldown(response, config.instanceId, store, now());
  }
  if (authFailure(result, Number(response.status))) throw httpFailure(401);
  if (!response.ok) throw httpFailure(response.status);
  requireCondition(
    !result.errors || (Array.isArray(result.errors) && result.errors.length === 0),
    "Linear GraphQL returned errors; partial results were rejected.",
    "upstream",
  );
  const data = result.data;
  validateIdentity(data, config);
  const page = data[cursor.phase];
  requireCondition(
    Array.isArray(page?.nodes) &&
      page.nodes.length <= config.pageSize &&
      typeof page.pageInfo?.hasNextPage === "boolean",
    "Missing or invalid API page.",
    "upstream",
  );
  const items = mapItems(page.nodes, cursor.phase, config, authorWindow(input));
  const pages = cursor.pages + 1;
  const total = cursor.total + items.length;
  const eventChars = cursor.eventChars + items.reduce((count, item) => count + JSON.stringify(item).length + 1, 0);
  requireCondition(total <= MAX_ITEMS, "Assigned intake exceeds the 2000-item coverage limit.", "config");
  requireCondition(
    eventChars <= MAX_EVENT_DATA_CHARS,
    "Assigned intake exceeds the native event payload budget.",
    "config",
  );
  let next = null;
  if (page.pageInfo.hasNextPage) {
    const after = requiredString(page.pageInfo.endCursor, "nonterminal API cursor");
    const fingerprint = createHash("sha256").update(after).digest("hex");
    requireCondition(
      items.length > 0 && after !== cursor.after && !cursor.seen.includes(fingerprint),
      "API pagination did not advance.",
      "upstream",
    );
    next = {
      phase: cursor.phase,
      after,
      pages,
      total,
      scope: cursor.scope,
      seen: [...cursor.seen, fingerprint],
      eventChars,
    };
  } else if (cursor.phase === "issues" && config.includeProjects) {
    next = { phase: "projects", after: null, pages, total, scope: cursor.scope, seen: [], eventChars };
  }
  requireCondition(!next || pages < MAX_PAGES, "Assigned intake exceeds the 20-page coverage limit.", "config");
  await noteRemainingRequests(response, config.instanceId, store, now());
  return {
    items,
    hasNextPage: next !== null,
    cursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : null,
  };
}

async function main() {
  try {
    let stdin = "";
    for await (const chunk of process.stdin) {
      stdin += chunk.toString("utf8");
      requireCondition(Buffer.byteLength(stdin) <= 32768, "Watcher input exceeds the safe size limit.", "config");
    }
    let input;
    try {
      input = JSON.parse(stdin);
    } catch {
      throw new WatcherError("Invalid watcher input JSON.", "config");
    }
    process.stdout.write(JSON.stringify(await runWatcher(input)));
  } catch (error) {
    // The first line is for the log. The second line is the one code OpenBot reads and maps to its own text.
    process.stderr.write(
      `Assigned Linear watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`,
    );
    if (error instanceof WatcherError && error.code) process.stderr.write(`openbot-error: ${error.code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
