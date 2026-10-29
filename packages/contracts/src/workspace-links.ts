/**
 * The desktop link to a workspace message: `openbot://workspace/<server>/<channel>/<message>`.
 *
 * The app copies it from a message. Inside the app it opens in place; from outside (a browser, a
 * chat app, a note) the operating system hands it to `src/main/deep-link-router.ts`, which raises
 * the window. The renderer then switches to the server and opens the channel and the thread.
 *
 * The link comes from a page or a document that anyone can write, so it carries only three ids and
 * nothing that acts: it opens a conversation the reader can already see, and a link to a server or a
 * channel this computer does not know does nothing. Each id must match `WORKSPACE_LINK_ID`, the link
 * has no query, no fragment, no user and no port, and it is short. The URL that main hands on is
 * built again from the ids, never the text that arrived.
 */

export const WORKSPACE_LINK_PREFIX = "openbot://workspace/";
const WORKSPACE_LINK_HOST = "workspace";
const WORKSPACE_LINK_MAX_LENGTH = 512;
/** A server, channel or message id: `local`, a UUID, or an id such as `discord-123`. */
const WORKSPACE_LINK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export interface WorkspaceLinkTarget {
  /** The server (host) id, as the server rail knows it. */
  hostId: string;
  channelId: string;
  /** The message, or the root of its thread. */
  messageId: string;
}

export function isWorkspaceLinkId(value: string): boolean {
  return WORKSPACE_LINK_ID.test(value);
}

export function createWorkspaceLinkUrl(target: WorkspaceLinkTarget): string {
  return `${WORKSPACE_LINK_PREFIX}${[target.hostId, target.channelId, target.messageId].map(encodeURIComponent).join("/")}`;
}

/** The ids of a workspace message link, or null for any other text. */
export function parseWorkspaceLinkUrl(value: string): WorkspaceLinkTarget | null {
  if (value.length > WORKSPACE_LINK_MAX_LENGTH || !value.startsWith(WORKSPACE_LINK_PREFIX)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "openbot:" ||
    url.hostname !== WORKSPACE_LINK_HOST ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    value.includes("?") ||
    value.includes("#")
  )
    return null;
  const parts = url.pathname.split("/").slice(1);
  if (parts.length !== 3) return null;
  let ids: string[];
  try {
    ids = parts.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  const [hostId, channelId, messageId] = ids;
  if (!hostId || !channelId || !messageId || !ids.every(isWorkspaceLinkId)) return null;
  return { hostId, channelId, messageId };
}
