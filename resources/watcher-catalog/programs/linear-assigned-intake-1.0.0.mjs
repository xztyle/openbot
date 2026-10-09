import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENDPOINT = 'https://api.linear.app/graphql';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_ITEMS = 2000;
// Reserve room under OpenBot's 100,000-character event prompt limit for the
// saved intake instruction and native framing. Payloads contain IDs/revisions/authorship.
const MAX_EVENT_DATA_CHARS = 90000;
// Explicit uncertainty marker, never a user identity. The user authorizes delivery
// for mixed/missing authorship; native exclusion compares only real account UUIDs.
export const UNKNOWN_ACTOR = 'unknown';
const HISTORY_SIZE = 10;
const identityFields = `
  organization { id urlKey }
  viewer { id email }
  team(id: $teamId) { id key }
`;

export const ISSUE_QUERY = `query AssignedIntakeIssues(
  $teamId: String!, $filter: IssueFilter!, $first: Int!, $after: String
) {
  ${identityFields}
  issues(first: $first, after: $after, filter: $filter,
         includeArchived: true, orderBy: createdAt) {
    nodes {
      id title description createdAt updatedAt assignee { id } team { id }
      history(last: ${HISTORY_SIZE}, orderBy: updatedAt, includeArchived: true) {
        nodes {
          actorId descriptionUpdatedBy { id } createdAt updatedAt
          fromTitle toTitle updatedDescription toAssigneeId toTeamId
        }
        pageInfo { hasPreviousPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

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

class WatcherError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new WatcherError(message);
}

function requiredString(value, name) {
  requireCondition(typeof value === 'string' && value.length > 0, `Missing or invalid ${name}.`);
  return value;
}

function readConfiguration(input) {
  requireCondition(input && typeof input === 'object' && !Array.isArray(input), 'Expected a JSON object.');
  const config = {};
  for (const name of ['instanceId', 'workspaceId', 'workspaceSlug', 'assigneeId', 'assigneeEmail', 'teamId', 'teamKey']) {
    config[name] = requiredString(input[name], name);
  }
  config.pageSize = Number(input.pageSize ?? 100);
  requireCondition(Number.isInteger(config.pageSize) && config.pageSize >= 1 && config.pageSize <= 100,
    'pageSize must be an integer from 1 to 100.');
  return config;
}

function scopeHash(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function readCursor(raw, scope) {
  if (raw === undefined || raw === null || raw === '') {
    return { phase: 'issues', after: null, pages: 0, total: 0, scope, seen: [], eventChars: 2 };
  }
  requireCondition(typeof raw === 'string' && /^[A-Za-z0-9_-]+$/.test(raw) && raw.length < 8192,
    'Invalid paging cursor.');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { throw new WatcherError('Invalid paging cursor.'); }
  requireCondition(cursor && ['issues', 'projects'].includes(cursor.phase)
    && (cursor.after === null || (typeof cursor.after === 'string' && cursor.after.length > 0))
    && Number.isInteger(cursor.pages) && cursor.pages >= 1 && cursor.pages < MAX_PAGES
    && Number.isInteger(cursor.total) && cursor.total >= 0 && cursor.total <= MAX_ITEMS
    && cursor.scope === scope && Array.isArray(cursor.seen) && cursor.seen.length <= MAX_PAGES
    && Number.isInteger(cursor.eventChars) && cursor.eventChars >= 2 && cursor.eventChars <= MAX_EVENT_DATA_CHARS
    && cursor.seen.every(s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)),
  'Invalid paging cursor.');
  return cursor;
}

async function readResponse(response) {
  requireCondition(response.body && typeof response.body.getReader === 'function', 'Missing API response body.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      requireCondition(total <= MAX_RESPONSE_BYTES, 'API response exceeds the safe size limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new WatcherError('Invalid JSON API response.'); }
}

// Only a server-directed cooldown timestamp persists, separately per saved instance.
// No account contents, credentials, polling checkpoints or AI state are stored here.
const cooldownStore = {
  async read(instanceId) {
    const filename = cooldownFilename(instanceId);
    try {
      const timestamp = Number(await fs.readFile(filename, 'utf8'));
      requireCondition(Number.isFinite(timestamp) && timestamp >= 0, 'Invalid API cooldown state.');
      return timestamp;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw new WatcherError('Cannot read API cooldown state.');
    }
  },
  async write(instanceId, timestamp) {
    const filename = cooldownFilename(instanceId);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, String(timestamp), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
    } catch {
      await fs.unlink(temporary).catch(() => {});
      throw new WatcherError('Cannot save API cooldown state.');
    }
  },
};

function cooldownFilename(instanceId) {
  const key = createHash('sha256').update(instanceId).digest('hex');
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '.linear-intake-cooldowns', key);
}

async function saveCooldown(response, instanceId, store, nowMs) {
  let until = nowMs + 60000;
  const retry = response.headers.get('retry-after');
  if (retry) {
    const seconds = Number(retry);
    const timestamp = Number.isFinite(seconds) ? nowMs + Math.max(0, seconds) * 1000 : Date.parse(retry);
    if (Number.isFinite(timestamp)) until = Math.max(until, timestamp);
  }
  for (const name of ['x-ratelimit-requests-reset', 'x-ratelimit-complexity-reset', 'x-ratelimit-endpoint-requests-reset']) {
    const timestamp = Number(response.headers.get(name));
    if (Number.isFinite(timestamp)) until = Math.max(until, timestamp);
  }
  await store.write(instanceId, until);
  throw new WatcherError('Linear API rate limit reached; server-directed cooldown is active.');
}

function validateIdentity(data, config) {
  requireCondition(data?.organization?.id === config.workspaceId
    && data.organization.urlKey === config.workspaceSlug, 'API token workspace does not match the configured workspace.');
  requireCondition(data.viewer?.id === config.assigneeId
    && data.viewer.email?.toLowerCase() === config.assigneeEmail.toLowerCase(),
  'API token must belong to the configured Alejandro account.');
  requireCondition(data.team?.id === config.teamId && data.team.key === config.teamKey,
    'API team does not match the configured BAZ team.');
}

function authorWindow(input) {
  const since = typeof input.since === 'string' ? Date.parse(input.since) : NaN;
  const until = typeof input.until === 'string' ? Date.parse(input.until) : NaN;
  return Number.isFinite(since) && Number.isFinite(until) && since < until ? { since, until } : null;
}

function userId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

// History is supplementary attribution, not requested content coverage. Insufficient
// history passes through as unknown; it must never hide a content change or stop polling.
function recentHistory(history, window) {
  if (!window || !Array.isArray(history?.nodes) || history.nodes.length > HISTORY_SIZE
    || typeof history.pageInfo?.hasPreviousPage !== 'boolean') return null;
  const rows = history.nodes.map(row => ({ row, created: Date.parse(row?.createdAt), updated: Date.parse(row?.updatedAt) }));
  if (rows.some(({ created, updated }, i) => !Number.isFinite(created) || !Number.isFinite(updated)
    || created > updated || updated > window.until || (i > 0 && updated < rows[i - 1].updated))) return null;
  if (history.pageInfo.hasPreviousPage && (!rows.length || rows[0].updated >= window.since)) return null;
  return rows.filter(({ updated }) => updated >= window.since);
}

function issueActor(node, window) {
  const entityUpdated = Date.parse(node.updatedAt);
  const entityCreated = Date.parse(node.createdAt);
  // A subsequent edit cannot identify who introduced a newly created entity.
  if (!window || !Number.isFinite(entityCreated) || !Number.isFinite(entityUpdated)
    || entityCreated > entityUpdated || entityCreated >= window.since || entityUpdated > window.until) return UNKNOWN_ACTOR;
  const rows = recentHistory(node.history, window);
  if (!rows) return UNKNOWN_ACTOR;
  const authors = new Set();
  let terminalTitle;
  for (const { row, created } of rows) {
    for (const key of ['fromTitle', 'toTitle', 'toAssigneeId', 'toTeamId']) {
      if (row[key] !== null && typeof row[key] !== 'string') return UNKNOWN_ACTOR;
    }
    if (row.updatedDescription !== null && typeof row.updatedDescription !== 'boolean') return UNKNOWN_ACTOR;
    if (row.descriptionUpdatedBy !== null && !Array.isArray(row.descriptionUpdatedBy)) return UNKNOWN_ACTOR;
    if (row.updatedDescription !== true && row.descriptionUpdatedBy?.length) return UNKNOWN_ACTOR;
    const title = row.fromTitle != null || row.toTitle != null;
    const description = row.updatedDescription === true;
    const assignment = row.toAssigneeId != null || row.toTeamId != null;
    if (!title && !description && !assignment) continue; // Status actors do not identify content editors.
    if (title && (typeof row.fromTitle !== 'string' || typeof row.toTitle !== 'string')) return UNKNOWN_ACTOR;
    if ((row.toAssigneeId !== null && row.toAssigneeId !== node.assignee.id)
      || (row.toTeamId !== null && row.toTeamId !== node.team.id)) return UNKNOWN_ACTOR;
    // An old group refreshed recently cannot date its individual content edits.
    if (created < window.since) return UNKNOWN_ACTOR;
    if (title || assignment) {
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
  return authors.size === 1 ? [...authors][0] : UNKNOWN_ACTOR;
}

function projectActor(node, config, window) {
  const entityUpdated = Date.parse(node.updatedAt);
  const entityCreated = Date.parse(node.createdAt);
  if (!window || !Number.isFinite(entityCreated) || !Number.isFinite(entityUpdated)
    || entityCreated > entityUpdated || entityCreated >= window.since || entityUpdated > window.until) return UNKNOWN_ACTOR;
  const rows = recentHistory(node.history, window);
  if (!rows) return UNKNOWN_ACTOR;
  const authors = new Set();
  for (const { row } of rows) {
    if (!Array.isArray(row.entries)) return UNKNOWN_ACTOR;
    for (const entry of row.entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.type !== 'string' || !entry.type.trim()) return UNKNOWN_ACTOR;
      if (entry?.type !== 'leadId') continue;
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

function mapItems(nodes, phase, config, window) {
  const ids = new Set();
  return nodes.map(node => {
    const id = requiredString(node?.id, 'item ID');
    requireCondition(!ids.has(id), 'Duplicate item ID in API page.');
    ids.add(id);
    if (phase === 'issues') {
      requireCondition(node.assignee?.id === config.assigneeId && node.team?.id === config.teamId,
        'API returned an issue outside the assigned BAZ scope.');
      requireCondition(typeof node.title === 'string'
        && (node.description === null || typeof node.description === 'string'), 'Missing complete issue content.');
      return {
        id: `i:${id}`,
        revision: createHash('sha256').update(JSON.stringify([node.title, node.description])).digest('base64url'),
        actor: issueActor(node, window),
      };
    }
    requireCondition(node.lead?.id === config.assigneeId, 'API returned a project led by another user.');
    return {
      id: `p:${id}`,
      revision: 'assigned-project-v1',
      actor: projectActor(node, config, window),
    };
  });
}

/** One read-only page. OpenBot collects every page before comparing its baseline. */
export async function runWatcher(input, {
  token = process.env.LINEAR_API_TOKEN, fetchImpl = fetch,
  store = cooldownStore, now = () => Date.now(),
} = {}) {
  requireCondition(typeof token === 'string' && token.trim().length > 0, 'Missing LINEAR_API_TOKEN private variable.');
  requireCondition(!/[\r\n]/.test(token), 'Invalid LINEAR_API_TOKEN private variable.');
  const config = readConfiguration(input);
  const cursor = readCursor(input.cursor, scopeHash(config));
  requireCondition(await store.read(config.instanceId) <= now(), 'Linear API cooldown is active; no request was sent.');
  const filter = cursor.phase === 'issues'
    ? { assignee: { id: { eq: config.assigneeId } }, team: { id: { eq: config.teamId } } }
    : { lead: { id: { eq: config.assigneeId } }, accessibleTeams: { some: { id: { eq: config.teamId } } } };
  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let result;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: token.trim() },
      body: JSON.stringify({
        query: cursor.phase === 'issues' ? ISSUE_QUERY : PROJECT_QUERY,
        variables: { teamId: config.teamId, filter, first: config.pageSize, after: cursor.after },
      }),
    });
    if (response.status === 429) await saveCooldown(response, config.instanceId, store, now());
    result = await readResponse(response);
  } catch (error) {
    // Only these locally authored messages may reach stderr; never echo fetch/server errors.
    if (error instanceof WatcherError) throw error;
    throw new WatcherError('Linear API request failed or timed out.');
  } finally { clearTimeout(timer); }
  requireCondition(result && typeof result === 'object' && !Array.isArray(result), 'Invalid JSON API result.');
  if (Array.isArray(result.errors) && result.errors.some(e => e?.extensions?.code === 'RATELIMITED')) {
    await saveCooldown(response, config.instanceId, store, now());
  }
  requireCondition(response.ok, `Linear API HTTP ${Number(response.status) || 'error'}.`);
  requireCondition(!result.errors || (Array.isArray(result.errors) && result.errors.length === 0),
    'Linear GraphQL returned errors; partial results were rejected.');
  const data = result.data;
  validateIdentity(data, config);
  const page = data[cursor.phase];
  requireCondition(Array.isArray(page?.nodes) && page.nodes.length <= config.pageSize
    && typeof page.pageInfo?.hasNextPage === 'boolean', 'Missing or invalid API page.');
  const items = mapItems(page.nodes, cursor.phase, config, authorWindow(input));
  const pages = cursor.pages + 1;
  const total = cursor.total + items.length;
  const eventChars = cursor.eventChars + items.reduce((count, item) => count + JSON.stringify(item).length + 1, 0);
  requireCondition(total <= MAX_ITEMS, 'Assigned intake exceeds the 2000-item coverage limit.');
  requireCondition(eventChars <= MAX_EVENT_DATA_CHARS, 'Assigned intake exceeds the native event payload budget.');
  let next = null;
  if (page.pageInfo.hasNextPage) {
    const after = requiredString(page.pageInfo.endCursor, 'nonterminal API cursor');
    const fingerprint = createHash('sha256').update(after).digest('hex');
    requireCondition(items.length > 0 && after !== cursor.after && !cursor.seen.includes(fingerprint), 'API pagination did not advance.');
    next = { phase: cursor.phase, after, pages, total, scope: cursor.scope, seen: [...cursor.seen, fingerprint], eventChars };
  } else if (cursor.phase === 'issues') {
    next = { phase: 'projects', after: null, pages, total, scope: cursor.scope, seen: [], eventChars };
  }
  requireCondition(!next || pages < MAX_PAGES, 'Assigned intake exceeds the 20-page coverage limit.');
  return { items, hasNextPage: next !== null, cursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null };
}

async function main() {
  try {
    let stdin = '';
    for await (const chunk of process.stdin) {
      stdin += chunk.toString('utf8');
      requireCondition(Buffer.byteLength(stdin) <= 32768, 'Watcher input exceeds the safe size limit.');
    }
    let input;
    try { input = JSON.parse(stdin); } catch { throw new WatcherError('Invalid watcher input JSON.'); }
    process.stdout.write(JSON.stringify(await runWatcher(input)));
  } catch (error) {
    process.stderr.write(`Assigned Linear watcher: ${error instanceof WatcherError ? error.message : 'Watcher failed.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
