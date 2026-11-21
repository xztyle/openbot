import type { WorkspaceView } from "@openbot/ui/features/workspace/WorkspaceSidebar";

/**
 * The address of a place in the web client, as Slack has one: a reload, Back and Forward, a new tab
 * and a shared link open the same place.
 *
 * ```
 * /app[/s/<server>]/<space>                          the space, on its first view
 * /app[/s/<server>]/<space>/c/<channel>[/t/<root>]   a channel, DM or group, and its open thread
 * /app[/s/<server>]/<space>/dm/<agent>               the chat with an agent
 * /app[/s/<server>]/<space>/<view>[/<agent>]         a view: activity, threads, fleet, org, artifacts,
 *                                                    between-agents (of one agent), storage,
 *                                                    routines, secrets, agents (of the space),
 *                                                    unreads, later, dms, search
 * …/m/<message>                                      a message to show, after a channel, thread or DM
 * …?page=<page>[&section=<section>]                  a page over the place: settings,
 *                                                    server-settings, usage, schedule, tasks
 * ```
 *
 * The server shows only when the account has more than one, or when the space slug is `s`. The
 * space is its slug. Each part is URI-encoded. The module has no DOM and no state.
 */
export const WEB_APP_PATH = "/app";

/** The page that covers the workspace. Settings is the account's; server-settings is the server's. */
export type WebLocationPageKind = "settings" | "server-settings" | "usage" | "schedule" | "tasks";

export interface WebLocationPage {
  kind: WebLocationPageKind;
  /** A section of the page, such as `members` of the server settings. */
  section: string | null;
}

export type WebLocationTarget =
  | { kind: "channel"; channelId: string; threadRootId: string | null }
  | { kind: "agent"; agentId: string }
  /** `agentId` is the agent of the Between agents view, or null for all agents. */
  | { kind: "view"; view: WorkspaceView; agentId: string | null };

export interface WebLocation {
  /** The server (host) id, or null when the address does not name one. */
  hostId: string | null;
  /** The space slug (or id), or null when the address does not name one. */
  space: string | null;
  target: WebLocationTarget | null;
  /** A message of the channel, thread or chat to show and mark. */
  messageId: string | null;
  page: WebLocationPage | null;
}

const SERVER_SEGMENT = "s";
const CHANNEL_SEGMENT = "c";
const THREAD_SEGMENT = "t";
const DM_SEGMENT = "dm";
const MESSAGE_SEGMENT = "m";
const PAGE_PARAM = "page";
const SECTION_PARAM = "section";
/** No id of the app is this long; a longer part is not an id. */
const MAX_PART_LENGTH = 200;

const VIEW_SEGMENTS = {
  activity: "activity",
  threads: "threads",
  fleet: "fleet",
  org: "org",
  artifacts: "artifacts",
  agents: "between-agents",
  storage: "storage",
  routines: "routines",
  secrets: "secrets",
  reviews: "reviews",
  "space-agents": "agents",
  drafts: "drafts",
  unreads: "unreads",
  later: "later",
  dms: "dms",
  search: "search",
} as const satisfies Record<WorkspaceView, string>;

const VIEWS: readonly WorkspaceView[] = [
  "activity",
  "threads",
  "fleet",
  "org",
  "artifacts",
  "agents",
  "storage",
  "routines",
  "secrets",
  "reviews",
  "space-agents",
  "drafts",
  "unreads",
  "later",
  "dms",
  "search",
];

function viewOfSegment(segment: string): WorkspaceView | undefined {
  return VIEWS.find((view) => VIEW_SEGMENTS[view] === segment);
}

const PAGES: readonly WebLocationPageKind[] = ["settings", "server-settings", "usage", "schedule", "tasks"];

function pageKindOf(value: string | null): WebLocationPageKind | undefined {
  return PAGES.find((page) => page === value);
}

export function emptyWebLocation(): WebLocation {
  return { hostId: null, space: null, target: null, messageId: null, page: null };
}

function part(value: string): string {
  return encodeURIComponent(value);
}

/** A decoded path part, or null when it is empty, too long or not valid URI text. */
function decodePart(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded && decoded.length <= MAX_PART_LENGTH && !decoded.includes("/") ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * The address of a location. `includeHost` adds the server; it is added anyway when the space slug
 * would read as the server mark.
 */
export function formatWebLocation(location: WebLocation, options: { includeHost: boolean }): string {
  const parts: string[] = [];
  const space = location.space;
  if (location.hostId && (options.includeHost || space === SERVER_SEGMENT || !space))
    parts.push(SERVER_SEGMENT, part(location.hostId));
  if (space) {
    parts.push(part(space));
    const target = location.target;
    if (target?.kind === "channel") {
      parts.push(CHANNEL_SEGMENT, part(target.channelId));
      if (target.threadRootId) parts.push(THREAD_SEGMENT, part(target.threadRootId));
    } else if (target?.kind === "agent") parts.push(DM_SEGMENT, part(target.agentId));
    else if (target?.kind === "view") {
      parts.push(VIEW_SEGMENTS[target.view]);
      if (target.view === "agents" && target.agentId) parts.push(part(target.agentId));
    }
    if (location.messageId && (target?.kind === "channel" || target?.kind === "agent"))
      parts.push(MESSAGE_SEGMENT, part(location.messageId));
  }
  const path = parts.length ? `${WEB_APP_PATH}/${parts.join("/")}` : WEB_APP_PATH;
  if (!location.page) return path;
  const search = new URLSearchParams({ [PAGE_PARAM]: location.page.kind });
  if (location.page.section) search.set(SECTION_PARAM, location.page.section);
  return `${path}?${search.toString()}`;
}

/**
 * The location of an address of the web client, or null when the path is not under `/app`. Parts
 * that do not read are left out: the address still opens the server and space it names.
 */
export function parseWebLocation(pathname: string, search = ""): WebLocation | null {
  if (pathname !== WEB_APP_PATH && !pathname.startsWith(`${WEB_APP_PATH}/`)) return null;
  const location = emptyWebLocation();
  const params = new URLSearchParams(search);
  const page = pageKindOf(params.get(PAGE_PARAM));
  if (page) {
    const section = params.get(SECTION_PARAM);
    location.page = {
      kind: page,
      section: section && section.length <= MAX_PART_LENGTH && /^[a-z0-9-]+$/u.test(section) ? section : null,
    };
  }
  const segments = pathname.slice(WEB_APP_PATH.length).split("/").filter(Boolean);
  let index = 0;
  if (segments[0] === SERVER_SEGMENT) {
    location.hostId = decodePart(segments[1]);
    if (!location.hostId) return location;
    index = 2;
  }
  const space = decodePart(segments[index]);
  if (!space) return location;
  location.space = space;
  index += 1;
  const kind = segments[index];
  if (kind === CHANNEL_SEGMENT) {
    const channelId = decodePart(segments[index + 1]);
    if (!channelId) return location;
    index += 2;
    let threadRootId: string | null = null;
    if (segments[index] === THREAD_SEGMENT) {
      threadRootId = decodePart(segments[index + 1]);
      index += 2;
    }
    location.target = { kind: "channel", channelId, threadRootId };
  } else if (kind === DM_SEGMENT) {
    const agentId = decodePart(segments[index + 1]);
    if (!agentId) return location;
    location.target = { kind: "agent", agentId };
    index += 2;
  } else if (kind !== undefined) {
    const view = viewOfSegment(kind);
    if (!view) return location;
    index += 1;
    let agentId: string | null = null;
    if (view === "agents" && segments[index] !== undefined && segments[index] !== MESSAGE_SEGMENT) {
      agentId = decodePart(segments[index]);
      index += 1;
    }
    location.target = { kind: "view", view, agentId };
    return location;
  }
  if (location.target && segments[index] === MESSAGE_SEGMENT) location.messageId = decodePart(segments[index + 1]);
  return location;
}

/**
 * A copied workspace message link of an older web client, `…#ws=<server>/<channel>/<message>`. The
 * message is the root of a thread, or a message of the channel; it opens as that thread.
 */
export function parseLegacyWebMessageHash(hash: string): WebLocation | null {
  const match = /^#ws=([^/]+)\/([^/]+)\/([^/]+)$/u.exec(hash);
  if (!match) return null;
  const hostId = decodePart(match[1]);
  const channelId = decodePart(match[2]);
  const messageId = decodePart(match[3]);
  if (!hostId || !channelId || !messageId) return null;
  return { ...emptyWebLocation(), hostId, target: { kind: "channel", channelId, threadRootId: messageId } };
}

/** The same place: server, space, target and page. The message to show does not count. */
export function sameWebPlace(left: WebLocation, right: WebLocation): boolean {
  return (
    left.hostId === right.hostId &&
    left.space === right.space &&
    sameTarget(left.target, right.target) &&
    left.page?.kind === right.page?.kind
  );
}

export function sameTarget(left: WebLocationTarget | null, right: WebLocationTarget | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === "channel")
    return right.kind === "channel" && left.channelId === right.channelId && left.threadRootId === right.threadRootId;
  if (left.kind === "agent") return right.kind === "agent" && left.agentId === right.agentId;
  return right.kind === "view" && left.view === right.view && left.agentId === right.agentId;
}
