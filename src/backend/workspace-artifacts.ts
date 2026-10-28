import { createHash } from "node:crypto";
import { CHAT_VISUAL_ITEM_TYPE_PREFIX } from "@openbot/contracts/chat-visual";
import {
  type AgentEvent,
  type AttachmentSummary,
  type ChannelMessage,
  type ConversationMessage,
  hostedSiteConversationEvent,
  WORKSPACE_ARTIFACT_DEFAULT_LIMIT,
  WORKSPACE_ARTIFACT_DESCRIPTION_LIMIT,
  WORKSPACE_ARTIFACT_LIMIT,
  WORKSPACE_ARTIFACT_TITLE_LIMIT,
  WORKSPACE_ARTIFACT_URL_LIMIT,
  type WorkspaceArtifactKind,
  type WorkspaceArtifactRecord,
  type WorkspaceArtifactSource,
  type WorkspaceArtifacts,
  type WorkspaceArtifactsInput,
} from "@openbot/contracts/ipc";
import type { OpenBotDatabase } from "./openbot-database";

/**
 * The domains where the apps broker serves the apps that agents deploy, as `https://<app>.<domain>`.
 * `dl.<domain>` is the download gateway: its links are short-lived tickets, never an artifact.
 */
export const WORKSPACE_APP_DOMAINS = ["delynith.com"] as const;
const HOSTED_SITE_SUFFIX = ".openbot.site";
/** The thread messages that the first artifact read of a run scans, newest first. */
const THREAD_BACKFILL_ROWS = 20_000;
const THREAD_PAGE_ROWS = 5_000;
/** One read scans at most this many pages; the next read goes on where it stopped. */
const THREAD_PAGES_PER_READ = 10;
const THREAD_SCAN_INTERVAL_MS = 2_000;
const PENDING_ROW_LIMIT = 500;
/** Usage of a turn is read from this long before its start, as the turn trace reads it. */
const TURN_USAGE_MARGIN_MS = 60 * 60 * 1_000;

/** One sighting of an artifact in one message. */
interface Sighting {
  key: string;
  kind: WorkspaceArtifactKind;
  source: WorkspaceArtifactSource;
  title: string;
  /** How good the title is: a site's own title, then a link text, then a name the host made. */
  titleRank: number;
  description?: string;
  url?: string;
  file?: AttachmentSummary;
  agentId: string;
  channelId?: string;
  messageId: string;
  threadRootId?: string;
  turnId?: string;
  at: number;
  /** A hosted site that this message says was deleted. */
  deleted?: true;
}

function cut(text: string, limit: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

const URL_PATTERN = /https?:\/\/[^\s<>()"'`[\]{}|\\^]+/giu;
const MARKDOWN_LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/giu;
const DOC_EXTENSIONS = /\.(pdf|docx?|odt|rtf|md|txt)$/u;
const DECK_EXTENSIONS = /\.(pptx?|key|odp)$/u;
const FILE_EXTENSIONS = /\.(zip|tar|gz|csv|xlsx?|json|png|jpe?g|gif|webp|svg|mp4|mov|mp3|wav)$/u;

function appDomain(host: string): string | null {
  return WORKSPACE_APP_DOMAINS.find((domain) => host === domain || host.endsWith(`.${domain}`)) ?? null;
}

/** The address an artifact is known by: no fragment, no trailing slash, and one Google file per id. */
export function artifactUrlKey(url: URL): string {
  let path = url.pathname.replace(/\/+$/u, "");
  if (url.hostname === "docs.google.com") path = path.split("/").slice(0, 4).join("/");
  return `${url.protocol}//${url.hostname.toLowerCase()}${path}${url.hostname === "docs.google.com" ? "" : url.search}`;
}

/**
 * What a link of an agent message is, or null when it is not a deliverable: an app of the apps
 * broker, a site on openbot.site, a Google document, a deck or a dashboard host, or a file on one
 * of the broker's domains. Other links, such as the sources an agent cites, are not artifacts.
 */
export function classifyArtifactUrl(url: URL): { kind: WorkspaceArtifactKind; name: string } | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const segment = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let last = segment;
  try {
    last = decodeURIComponent(segment);
  } catch {
    last = segment;
  }
  const domain = appDomain(host);
  if (domain) {
    const sub = host === domain ? "" : host.slice(0, -(domain.length + 1));
    if (sub === "dl" || sub.endsWith(".dl")) return null;
    if (DOC_EXTENSIONS.test(path)) return { kind: "doc", name: last };
    if (DECK_EXTENSIONS.test(path)) return { kind: "deck", name: last };
    if (FILE_EXTENSIONS.test(path)) return { kind: "file", name: last };
    if (!sub || sub === "www") return { kind: "website", name: host };
    if (/dashboard|grafana|metrics|stats/u.test(`${sub} ${path}`)) return { kind: "dashboard", name: sub };
    return { kind: "app", name: sub };
  }
  if (host.endsWith(HOSTED_SITE_SUFFIX)) return { kind: "website", name: host.slice(0, -HOSTED_SITE_SUFFIX.length) };
  if (host === "docs.google.com") {
    if (path.startsWith("/document/")) return { kind: "doc", name: host };
    if (path.startsWith("/presentation/")) return { kind: "deck", name: host };
    if (path.startsWith("/spreadsheets/") || path.startsWith("/forms/")) return { kind: "doc", name: host };
    return null;
  }
  if (host === "drive.google.com" && path.startsWith("/file/")) return { kind: "file", name: host };
  if (host === "notion.so" || host === "www.notion.so" || host.endsWith(".notion.site"))
    return { kind: "doc", name: last || host };
  if (host === "gamma.app" || host === "pitch.com" || host === "slides.com" || host.endsWith(".slides.com"))
    return { kind: "deck", name: last || host };
  if ((host === "www.canva.com" || host === "canva.com") && path.startsWith("/design/"))
    return { kind: "deck", name: host };
  if (
    host === "lookerstudio.google.com" ||
    host === "datastudio.google.com" ||
    host.endsWith(".grafana.net") ||
    host.endsWith(".metabaseapp.com")
  )
    return { kind: "dashboard", name: host };
  return null;
}

/** The kind of an attached file, by its type. */
export function attachmentArtifactKind(mimeType: string, name: string): WorkspaceArtifactKind {
  const type = mimeType.toLowerCase();
  const lower = name.toLowerCase();
  if (type === "text/html" || lower.endsWith(".html") || lower.endsWith(".htm")) return "website";
  if (type.includes("presentation") || type.includes("powerpoint") || DECK_EXTENSIONS.test(lower)) return "deck";
  if (
    type === "application/pdf" ||
    type.includes("wordprocessing") ||
    type === "application/msword" ||
    type === "text/markdown" ||
    type === "text/plain" ||
    DOC_EXTENSIONS.test(lower)
  )
    return "doc";
  return "file";
}

function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?*_~]+$/u, "");
}

/** The sentence of `text` around a link, without the link, as the artifact's description. */
function describe(text: string, raw: string): string | undefined {
  const line = text.split(/\r?\n/u).find((candidate) => candidate.includes(raw)) ?? "";
  const sentence = line.split(/(?<=[.!?])\s+/u).find((candidate) => candidate.includes(raw)) ?? line;
  const plain = sentence
    .replace(MARKDOWN_LINK, "$1")
    .replace(URL_PATTERN, "")
    .replace(/[*_`>#]+/gu, "")
    .replace(/(\s+(at|on|in|to|here|via))+\s*[.:!]?\s*$/iu, "")
    .replace(/\s*[-–—:(]\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return plain.length >= 8 ? cut(plain, WORKSPACE_ARTIFACT_DESCRIPTION_LIMIT) : undefined;
}

/** Where a message is, for each of its sightings. */
interface MessagePlace {
  agentId: string;
  channelId?: string;
  messageId: string;
  threadRootId?: string;
}

/** The artifacts that one agent message shows: its links, its visual reply, its files, its hosted site. */
export function messageSightings(message: ConversationMessage, place: MessagePlace): Sighting[] {
  const at = Date.parse(message.createdAt);
  if (!Number.isFinite(at)) return [];
  const base = {
    agentId: place.agentId,
    messageId: place.messageId,
    ...(place.channelId ? { channelId: place.channelId } : {}),
    ...(place.threadRootId ? { threadRootId: place.threadRootId } : {}),
    ...(message.turnId ? { turnId: message.turnId } : {}),
    at,
  };
  const site = hostedSiteConversationEvent(message);
  if (site) {
    if (site.status !== "succeeded" || !site.url) return [];
    let url: URL;
    try {
      url = new URL(site.url);
    } catch {
      return [];
    }
    return [
      {
        ...base,
        key: artifactUrlKey(url),
        kind: "website",
        source: "site",
        title: cut(site.title, WORKSPACE_ARTIFACT_TITLE_LIMIT),
        titleRank: 3,
        url: site.url,
        ...(site.action === "delete" ? { deleted: true as const } : {}),
      },
    ];
  }
  if (message.author !== "assistant" || message.itemType === "commentary" || message.questionPrompt) return [];
  const sightings: Sighting[] = [];
  const visual = message.itemType?.startsWith(CHAT_VISUAL_ITEM_TYPE_PREFIX) ?? false;
  for (const attachment of message.attachments ?? []) {
    sightings.push({
      ...base,
      key: `file:${attachment.id}`,
      kind: visual ? "dashboard" : attachmentArtifactKind(attachment.mimeType, attachment.name),
      source: visual ? "render" : "attachment",
      title: cut(visual && message.text.trim() ? message.text : attachment.name, WORKSPACE_ARTIFACT_TITLE_LIMIT),
      titleRank: visual ? 2 : 1,
      file: attachment,
    });
  }
  if (visual) return sightings;
  const linkTexts = new Map<string, string>();
  for (const match of message.text.matchAll(MARKDOWN_LINK)) {
    const [, label, href] = match;
    if (label && href && !/^https?:\/\//iu.test(label.trim())) linkTexts.set(trimUrl(href), label.trim());
  }
  const seen = new Set<string>();
  for (const match of message.text.matchAll(URL_PATTERN)) {
    const raw = trimUrl(match[0]);
    if (raw.length > WORKSPACE_ARTIFACT_URL_LIMIT) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const kind = classifyArtifactUrl(url);
    if (!kind) continue;
    const key = artifactUrlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = linkTexts.get(raw);
    const description = describe(message.text, raw);
    sightings.push({
      ...base,
      key,
      kind: kind.kind,
      source: "link",
      title: cut(label ?? kind.name, WORKSPACE_ARTIFACT_TITLE_LIMIT),
      titleRank: label ? 2 : 1,
      url: url.href,
      ...(description ? { description } : {}),
    });
  }
  return sightings;
}

/** The artifacts of one channel message, when an agent wrote it and it still counts. */
export function channelMessageSightings(message: ChannelMessage): Sighting[] {
  if (message.author.kind !== "agent" || message.superseded || message.deletedAt) return [];
  return messageSightings(message.message, {
    agentId: message.author.id,
    channelId: message.channelId,
    messageId: message.id,
    ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
  });
}

export interface WorkspaceArtifactIndexOptions {
  database: Pick<OpenBotDatabase, "workspace" | "usage">;
  /** All the messages of a channel, thread replies too. */
  channelMessages(channelId: string): ChannelMessage[];
}

/** What a reader may see: the channels, and the agents whose own conversations they can read. */
export interface WorkspaceArtifactAccess {
  channelIds: readonly string[];
  agentVisible(agentId: string): boolean;
}

/**
 * Owns the artifact index of the workspace, in memory: the deliverables that agents shared in the
 * channels and in their own conversations. A channel is read whole the first time a reader asks for
 * it; its `channel-message` events keep it current after that. The agents' own conversations are
 * read from the thread messages in row order, the newest `THREAD_BACKFILL_ROWS` first; a message
 * that still streams is read again. Nothing is stored: a restart reads again.
 */
export class WorkspaceArtifactIndex {
  readonly #options: WorkspaceArtifactIndexOptions;
  readonly #channels = new Map<string, Map<string, Sighting[]>>();
  readonly #threads = new Map<string, Sighting[]>();
  readonly #pendingRows = new Set<number>();
  readonly #turns = new Map<string, { costUsd?: number; durationMs?: number }>();
  #lastRow = -1;
  #scannedAt = 0;

  constructor(options: WorkspaceArtifactIndexOptions) {
    this.#options = options;
  }

  observe(event: AgentEvent): void {
    if (event.type === "channel-message") {
      const channel = this.#channels.get(event.channelId);
      if (!channel) return;
      const sightings = channelMessageSightings(event.message);
      if (sightings.length) channel.set(event.message.id, sightings);
      else channel.delete(event.message.id);
    } else if (event.type === "channel-message-removed") {
      this.#channels.get(event.channelId)?.delete(event.messageId);
    }
  }

  #channel(channelId: string): Map<string, Sighting[]> {
    let channel = this.#channels.get(channelId);
    if (channel) return channel;
    channel = new Map();
    for (const message of this.#options.channelMessages(channelId)) {
      const sightings = channelMessageSightings(message);
      if (sightings.length) channel.set(message.id, sightings);
    }
    this.#channels.set(channelId, channel);
    return channel;
  }

  #scanThreads(now: number): void {
    if (now - this.#scannedAt < THREAD_SCAN_INTERVAL_MS) return;
    this.#scannedAt = now;
    const queries = this.#options.database.workspace;
    const last = queries.lastThreadMessageRow();
    // The rows were numbered again, as a vacuum does: read the newest rows again.
    if (last < this.#lastRow) {
      this.#threads.clear();
      this.#pendingRows.clear();
      this.#lastRow = -1;
    }
    if (this.#lastRow < 0) this.#lastRow = Math.max(0, last - THREAD_BACKFILL_ROWS);
    let pending = [...this.#pendingRows];
    this.#pendingRows.clear();
    for (let pages = 0; pages < THREAD_PAGES_PER_READ; pages += 1) {
      const before = this.#lastRow;
      const page = queries.artifactMessages(this.#lastRow, THREAD_PAGE_ROWS, pending);
      pending = [];
      this.#lastRow = Math.max(this.#lastRow, page.lastRow);
      for (const row of page.rows) {
        const key = `${row.threadId}\u0000${row.message.id}`;
        if (row.status === "streaming" && this.#pendingRows.size < PENDING_ROW_LIMIT) this.#pendingRows.add(row.rowId);
        const sightings = messageSightings(row.message, { agentId: row.agentId, messageId: row.message.id });
        if (sightings.length) this.#threads.set(key, sightings);
        else this.#threads.delete(key);
      }
      if (this.#lastRow >= last || this.#lastRow === before) break;
    }
  }

  /** The cost and time of each finished turn that first showed an artifact. */
  #turnStats(sightings: readonly Sighting[]): Map<string, { costUsd?: number; durationMs?: number }> {
    const missing = [
      ...new Set(
        sightings.flatMap((sighting) =>
          sighting.turnId && !this.#turns.has(sighting.turnId) ? [sighting.turnId] : [],
        ),
      ),
    ];
    if (missing.length) {
      if (this.#turns.size > 5_000) this.#turns.clear();
      for (const turn of this.#options.database.workspace.turns(missing)) {
        if (!turn.completedAt) continue;
        const started = Date.parse(turn.startedAt);
        const completed = Date.parse(turn.completedAt);
        const stats: { costUsd?: number; durationMs?: number } = {};
        if (Number.isFinite(started) && Number.isFinite(completed)) stats.durationMs = Math.max(0, completed - started);
        const since = new Date((Number.isFinite(started) ? started : completed) - TURN_USAGE_MARGIN_MS).toISOString();
        const usage = this.#options.database.usage.readTurnTotals(turn.agentId, turn.turnId, since);
        if (usage?.costUsd != null) stats.costUsd = usage.costUsd;
        this.#turns.set(turn.turnId, stats);
      }
    }
    return this.#turns;
  }

  list(input: WorkspaceArtifactsInput, access: WorkspaceArtifactAccess, now = Date.now()): WorkspaceArtifacts {
    const sightings: Sighting[] = [];
    const channelIds = input.channelId
      ? access.channelIds.filter((channelId) => channelId === input.channelId)
      : access.channelIds;
    for (const channelId of channelIds) for (const found of this.#channel(channelId).values()) sightings.push(...found);
    if (!input.channelId) {
      this.#scanThreads(now);
      for (const found of this.#threads.values())
        for (const sighting of found) if (access.agentVisible(sighting.agentId)) sightings.push(sighting);
    }
    // A site that was deleted after its last sighting is gone.
    const deletedAt = new Map<string, number>();
    for (const sighting of sightings)
      if (sighting.deleted) deletedAt.set(sighting.key, Math.max(deletedAt.get(sighting.key) ?? 0, sighting.at));
    const groups = new Map<string, Sighting[]>();
    for (const sighting of sightings) {
      if (sighting.deleted) continue;
      const group = groups.get(sighting.key);
      if (group) group.push(sighting);
      else groups.set(sighting.key, [sighting]);
    }
    const artifacts: Array<{ origin: Sighting; best: Sighting; updatedAt: number }> = [];
    for (const [key, group] of groups) {
      group.sort((left, right) => left.at - right.at);
      const origin = group[0];
      const latest = group.at(-1);
      if (!origin || !latest) continue;
      if ((deletedAt.get(key) ?? -1) >= latest.at) continue;
      const best = group.reduce((current, sighting) => (sighting.titleRank > current.titleRank ? sighting : current));
      artifacts.push({ origin, best, updatedAt: latest.at });
    }
    artifacts.sort((left, right) => right.updatedAt - left.updatedAt);
    const shown = artifacts.slice(
      0,
      Math.min(input.limit ?? WORKSPACE_ARTIFACT_DEFAULT_LIMIT, WORKSPACE_ARTIFACT_LIMIT),
    );
    const stats = this.#turnStats(shown.map((artifact) => artifact.origin));
    return {
      artifacts: shown.map(({ origin, best, updatedAt }): WorkspaceArtifactRecord => {
        const turn = origin.turnId ? stats.get(origin.turnId) : undefined;
        const description = best.description ?? origin.description;
        const file = origin.file;
        return {
          id: `artifact-${createHash("sha256").update(origin.key).digest("hex").slice(0, 32)}`,
          kind: best.kind,
          source: best.source,
          title: best.title,
          ...(description ? { description } : {}),
          ...(best.url ? { url: best.url } : {}),
          ...(file ? { file: { id: file.id, name: file.name, size: file.size, mimeType: file.mimeType } } : {}),
          agentId: origin.agentId,
          ...(origin.channelId ? { channelId: origin.channelId } : {}),
          messageId: origin.messageId,
          ...(origin.threadRootId ? { threadRootId: origin.threadRootId } : {}),
          createdAt: origin.at,
          updatedAt,
          ...(turn?.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
          ...(turn?.durationMs === undefined ? {} : { durationMs: turn.durationMs }),
        };
      }),
    };
  }
}
