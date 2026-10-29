import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CHAT_VISUAL_ITEM_TYPE_PREFIX } from "@openbot/contracts/chat-visual";
import {
  type AgentEvent,
  type ChannelMessage,
  type ConversationMessage,
  hostedSiteConversationEvent,
  WORKSPACE_ARTIFACT_DEFAULT_LIMIT,
  WORKSPACE_ARTIFACT_DESCRIPTION_LIMIT,
  WORKSPACE_ARTIFACT_KINDS,
  WORKSPACE_ARTIFACT_LIMIT,
  WORKSPACE_ARTIFACT_SOURCES,
  WORKSPACE_ARTIFACT_TITLE_LIMIT,
  WORKSPACE_ARTIFACT_URL_LIMIT,
  type WorkspaceArtifactFile,
  type WorkspaceArtifactKind,
  type WorkspaceArtifactRecord,
  type WorkspaceArtifactSource,
  type WorkspaceArtifacts,
  type WorkspaceArtifactsInput,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Result, Schema, Semaphore } from "effect";
import { writeJsonFileAtomically } from "./atomic-json-file";
import type { ChannelStore } from "./channel-store";
import type { OpenBotDatabase } from "./openbot-database";
import type { WorkspaceThumbnails } from "./workspace-thumbnails";

const logger = createOpenBotLogger("workspace-artifacts");

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
/** The file keeps the sightings of at most this many messages, the newest. */
const STORED_MESSAGE_LIMIT = 5_000;
const SAVE_DELAY_MS = 5_000;
/** The kinds and sources of artifact that are web pages, which get a thumbnail of the page. */
const PAGE_KINDS: ReadonlySet<WorkspaceArtifactKind> = new Set(["website", "app", "dashboard"]);
const PAGE_SOURCES: ReadonlySet<WorkspaceArtifactSource> = new Set(["link", "site"]);
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
  file?: WorkspaceArtifactFile;
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
      file: { id: attachment.id, name: attachment.name, size: attachment.size, mimeType: attachment.mimeType },
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
  database: {
    workspace: Pick<
      OpenBotDatabase["workspace"],
      "lastThreadMessageRow" | "artifactMessages" | "existingThreadMessages" | "turns"
    >;
    usage: Pick<OpenBotDatabase["usage"], "readTurnTotals">;
  };
  channels: Pick<ChannelStore, "exists" | "messages" | "messagesAfter" | "message">;
  /**
   * The host-only file that keeps the index between runs, such as
   * `<userData>/openbot-workspace-artifacts-v1.json`. Null keeps it in memory only.
   */
  path: string | null;
  /** The thumbnails of the artifacts that are web pages. Omitted or null, no artifact has one. */
  thumbnails?: Pick<WorkspaceThumbnails, "request" | "version"> | null;
  /** How long after a change the file is written. Omitted, 5 seconds. */
  saveDelayMs?: number;
}

/** What a reader may see: the channels, and the agents whose own conversations they can read. */
export interface WorkspaceArtifactAccess {
  channelIds: readonly string[];
  agentVisible(agentId: string): boolean;
}

/** The sightings of one channel, by message. */
interface ChannelState {
  messages: Map<string, Sighting[]>;
  /** The highest message sequence that this index read. */
  sequence: number;
  /** The messages that streamed when this index last read them: the catch-up reads them again. */
  pending: Set<string>;
  /** Read from the file and not yet compared with the channel. */
  stored: boolean;
}

const StoredFile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  size: Schema.Finite,
  mimeType: Schema.String,
});
const StoredSighting = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(WORKSPACE_ARTIFACT_KINDS),
  source: Schema.Literals(WORKSPACE_ARTIFACT_SOURCES),
  title: Schema.String,
  titleRank: Schema.Finite,
  description: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  file: Schema.optional(StoredFile),
  agentId: Schema.String,
  channelId: Schema.optional(Schema.String),
  messageId: Schema.String,
  threadRootId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  at: Schema.Finite,
  deleted: Schema.optional(Schema.Literal(true)),
});
const StoredChannel = Schema.Struct({
  sequence: Schema.Finite,
  pending: Schema.Array(Schema.String),
  messages: Schema.Array(Schema.Struct({ messageId: Schema.String, sightings: Schema.Array(StoredSighting) })),
});
const StoredIndex = Schema.Struct({
  version: Schema.Literal(1),
  channels: Schema.Record(Schema.String, StoredChannel),
  threads: Schema.Struct({
    lastRow: Schema.Finite,
    pendingRows: Schema.Array(Schema.Finite),
    messages: Schema.Array(
      Schema.Struct({ threadId: Schema.String, messageId: Schema.String, sightings: Schema.Array(StoredSighting) }),
    ),
  }),
});
type StoredIndex = typeof StoredIndex.Type;
const decodeStoredIndex = Schema.decodeUnknownSync(StoredIndex);

function threadKey(threadId: string, messageId: string): string {
  return `${threadId}\u0000${messageId}`;
}

function newest(sightings: readonly Sighting[]): number {
  return sightings.reduce((latest, sighting) => Math.max(latest, sighting.at), 0);
}

function sightingsOf(stored: readonly (typeof StoredSighting.Type)[]): Sighting[] {
  return stored.map((sighting) => ({ ...sighting, ...(sighting.file ? { file: { ...sighting.file } } : {}) }));
}

/** An artifact of a list: its first sighting, the one with the best title, and its last time. */
interface Found {
  id: string;
  origin: Sighting;
  best: Sighting;
  updatedAt: number;
}

/**
 * Owns the artifact index of the workspace: the deliverables that agents shared in the channels and
 * in their own conversations, and the file that keeps it between runs (`options.path`, host only).
 *
 * A channel is read whole the first time a reader asks for it; its `channel-message` events keep it
 * current after that. A channel from the file is caught up instead: its stored messages are read again
 * (a deleted or removed one is dropped), with those that streamed, and then the messages after the
 * stored sequence. A channel whose sequence went back, as a rebuild does, is read whole. The agents'
 * own conversations are read from the thread messages in row order, the newest `THREAD_BACKFILL_ROWS`
 * first, and then on from the stored row; a message that still streams is read again, and the stored
 * messages that no longer exist are dropped. A change writes the file `saveDelayMs` later; `stop`
 * writes it at once. The file keeps the newest `STORED_MESSAGE_LIMIT` messages.
 *
 * It never imports the facade or Electron, so a plain Node or Bun script can construct it.
 */
export class WorkspaceArtifactIndex {
  readonly #options: WorkspaceArtifactIndexOptions;
  readonly #channels = new Map<string, ChannelState>();
  readonly #threads = new Map<string, Sighting[]>();
  readonly #pendingRows = new Set<number>();
  readonly #turns = new Map<string, { costUsd?: number; durationMs?: number }>();
  readonly #writes = Semaphore.makeUnsafe(1);
  #lastRow = -1;
  #scannedAt = 0;
  #loaded = false;
  /** The thread sightings came from the file: the next scan checks that their messages exist. */
  #threadsStored = false;
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(options: WorkspaceArtifactIndexOptions) {
    this.#options = options;
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    const path = this.#options.path;
    if (!path) return;
    let file: StoredIndex;
    try {
      file = decodeStoredIndex(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      // The file holds message text, so neither its content nor a parse message is logged.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        logger.warn("The workspace artifact index could not be read. It starts empty.");
      return;
    }
    for (const [channelId, channel] of Object.entries(file.channels))
      this.#channels.set(channelId, {
        sequence: channel.sequence,
        pending: new Set(channel.pending),
        messages: new Map(channel.messages.map((entry) => [entry.messageId, sightingsOf(entry.sightings)])),
        stored: true,
      });
    this.#lastRow = file.threads.lastRow;
    for (const row of file.threads.pendingRows) this.#pendingRows.add(row);
    for (const entry of file.threads.messages)
      this.#threads.set(threadKey(entry.threadId, entry.messageId), sightingsOf(entry.sightings));
    this.#threadsStored = this.#threads.size > 0;
  }

  #changed(): void {
    this.#dirty = true;
    if (this.#stopped || !this.#options.path || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      Effect.runFork(this.flush());
    }, this.#options.saveDelayMs ?? SAVE_DELAY_MS);
    this.#timer.unref?.();
  }

  /** Puts one read message of a channel in its state. */
  #apply(channel: ChannelState, message: ChannelMessage): void {
    const sightings = channelMessageSightings(message);
    if (sightings.length) channel.messages.set(message.id, sightings);
    else channel.messages.delete(message.id);
    if (message.message.status === "streaming") {
      if (channel.pending.size < PENDING_ROW_LIMIT) channel.pending.add(message.id);
    } else channel.pending.delete(message.id);
  }

  observe(event: AgentEvent): void {
    if (event.type !== "channel-message" && event.type !== "channel-message-removed") return;
    this.#load();
    const channel = this.#channels.get(event.channelId);
    if (!channel) return;
    if (event.type === "channel-message") {
      this.#apply(channel, event.message);
      // A stored channel keeps its sequence until the catch-up reads what came before this message.
      if (!channel.stored) channel.sequence = Math.max(channel.sequence, event.message.sequence);
    } else {
      channel.messages.delete(event.messageId);
      channel.pending.delete(event.messageId);
    }
    this.#changed();
  }

  #readWhole(channelId: string): ChannelState {
    const channel: ChannelState = { messages: new Map(), sequence: 0, pending: new Set(), stored: false };
    for (const message of this.#options.channels.messages(channelId)) {
      this.#apply(channel, message);
      channel.sequence = Math.max(channel.sequence, message.sequence);
    }
    return channel;
  }

  #channel(channelId: string): ChannelState {
    const known = this.#channels.get(channelId);
    if (known && !known.stored) return known;
    const store = this.#options.channels;
    const latest = known ? store.messages(channelId, undefined, 1)[0] : undefined;
    let channel: ChannelState;
    if (!known || !latest || latest.sequence < known.sequence) {
      channel = this.#readWhole(channelId);
    } else {
      channel = known;
      channel.stored = false;
      for (const messageId of new Set([...channel.messages.keys(), ...channel.pending])) {
        const message = store.message(channelId, messageId);
        if (message) this.#apply(channel, message);
        else {
          channel.messages.delete(messageId);
          channel.pending.delete(messageId);
        }
      }
      for (const message of store.messagesAfter(channelId, channel.sequence)) {
        this.#apply(channel, message);
        channel.sequence = Math.max(channel.sequence, message.sequence);
      }
    }
    this.#channels.set(channelId, channel);
    this.#changed();
    return channel;
  }

  /** Drops the stored thread sightings whose message no longer exists. */
  #checkStoredThreads(): void {
    this.#threadsStored = false;
    const byThread = new Map<string, string[]>();
    for (const key of this.#threads.keys()) {
      const [threadId, messageId] = key.split("\u0000");
      if (!threadId || messageId === undefined) continue;
      const ids = byThread.get(threadId);
      if (ids) ids.push(messageId);
      else byThread.set(threadId, [messageId]);
    }
    const queries = this.#options.database.workspace;
    for (const [threadId, messageIds] of byThread) {
      const existing = queries.existingThreadMessages(threadId, messageIds);
      for (const messageId of messageIds)
        if (!existing.has(messageId)) this.#threads.delete(threadKey(threadId, messageId));
    }
  }

  #scanThreads(now: number): void {
    if (now - this.#scannedAt < THREAD_SCAN_INTERVAL_MS) return;
    this.#scannedAt = now;
    const queries = this.#options.database.workspace;
    const last = queries.lastThreadMessageRow();
    const before = this.#lastRow;
    // The rows were numbered again, as a vacuum does: read the newest rows again.
    if (last < this.#lastRow) {
      this.#threads.clear();
      this.#pendingRows.clear();
      this.#lastRow = -1;
      this.#threadsStored = false;
    }
    if (this.#threadsStored) this.#checkStoredThreads();
    if (this.#lastRow < 0) this.#lastRow = Math.max(0, last - THREAD_BACKFILL_ROWS);
    let pending = [...this.#pendingRows];
    const hadPending = pending.length > 0;
    this.#pendingRows.clear();
    for (let pages = 0; pages < THREAD_PAGES_PER_READ; pages += 1) {
      const from = this.#lastRow;
      const page = queries.artifactMessages(this.#lastRow, THREAD_PAGE_ROWS, pending);
      pending = [];
      this.#lastRow = Math.max(this.#lastRow, page.lastRow);
      for (const row of page.rows) {
        const key = threadKey(row.threadId, row.message.id);
        if (row.status === "streaming" && this.#pendingRows.size < PENDING_ROW_LIMIT) this.#pendingRows.add(row.rowId);
        const sightings = messageSightings(row.message, { agentId: row.agentId, messageId: row.message.id });
        if (sightings.length) this.#threads.set(key, sightings);
        else this.#threads.delete(key);
      }
      if (this.#lastRow >= last || this.#lastRow === from) break;
    }
    if (this.#lastRow !== before || hadPending || this.#pendingRows.size) this.#changed();
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

  /** Every artifact the reader may see, newest first. */
  #collect(channelId: string | undefined, access: WorkspaceArtifactAccess, now: number): Found[] {
    this.#load();
    const sightings: Sighting[] = [];
    const channelIds = channelId ? access.channelIds.filter((id) => id === channelId) : access.channelIds;
    for (const id of channelIds) for (const found of this.#channel(id).messages.values()) sightings.push(...found);
    if (!channelId) {
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
    const artifacts: Found[] = [];
    for (const [key, group] of groups) {
      group.sort((left, right) => left.at - right.at);
      const origin = group[0];
      const latest = group.at(-1);
      if (!origin || !latest) continue;
      if ((deletedAt.get(key) ?? -1) >= latest.at) continue;
      const best = group.reduce((current, sighting) => (sighting.titleRank > current.titleRank ? sighting : current));
      const id = `artifact-${createHash("sha256").update(origin.key).digest("hex").slice(0, 32)}`;
      artifacts.push({ id, origin, best, updatedAt: latest.at });
    }
    return artifacts.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  list(input: WorkspaceArtifactsInput, access: WorkspaceArtifactAccess, now = Date.now()): WorkspaceArtifacts {
    const shown = this.#collect(input.channelId, access, now).slice(
      0,
      Math.min(input.limit ?? WORKSPACE_ARTIFACT_DEFAULT_LIMIT, WORKSPACE_ARTIFACT_LIMIT),
    );
    const stats = this.#turnStats(shown.map((artifact) => artifact.origin));
    const thumbnails = this.#options.thumbnails ?? null;
    return {
      artifacts: shown.map(({ id, origin, best, updatedAt }): WorkspaceArtifactRecord => {
        const turn = origin.turnId ? stats.get(origin.turnId) : undefined;
        const description = best.description ?? origin.description;
        const file = origin.file;
        let thumbnailVersion: string | undefined;
        // A page link gets an image of the page; an attachment keeps its own preview.
        if (thumbnails && best.url && PAGE_KINDS.has(best.kind) && PAGE_SOURCES.has(best.source)) {
          thumbnails.request(id, best.url);
          thumbnailVersion = thumbnails.version(id);
        }
        return {
          id,
          kind: best.kind,
          source: best.source,
          title: best.title,
          ...(description ? { description } : {}),
          ...(best.url ? { url: best.url } : {}),
          ...(thumbnailVersion ? { thumbnailVersion } : {}),
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

  /** Whether the reader may see the artifact `artifactId`, at any place in the list. */
  visible(artifactId: string, access: WorkspaceArtifactAccess, now = Date.now()): boolean {
    return this.#collect(undefined, access, now).some((artifact) => artifact.id === artifactId);
  }

  #snapshot(): StoredIndex {
    const entries: Array<
      | { at: number; channelId: string; messageId: string; sightings: Sighting[] }
      | { at: number; threadId: string; messageId: string; sightings: Sighting[] }
    > = [];
    for (const [channelId, channel] of this.#channels)
      for (const [messageId, sightings] of channel.messages)
        entries.push({ at: newest(sightings), channelId, messageId, sightings });
    for (const [key, sightings] of this.#threads) {
      const [threadId, messageId] = key.split("\u0000");
      if (threadId && messageId !== undefined) entries.push({ at: newest(sightings), threadId, messageId, sightings });
    }
    entries.sort((left, right) => right.at - left.at);
    const channels: Record<
      string,
      { sequence: number; pending: string[]; messages: StoredIndex["channels"][string]["messages"][number][] }
    > = {};
    for (const [channelId, channel] of this.#channels)
      channels[channelId] = { sequence: channel.sequence, pending: [...channel.pending], messages: [] };
    const threads: StoredIndex["threads"]["messages"][number][] = [];
    for (const entry of entries.slice(0, STORED_MESSAGE_LIMIT)) {
      if ("channelId" in entry)
        channels[entry.channelId]?.messages.push({ messageId: entry.messageId, sightings: entry.sightings });
      else threads.push({ threadId: entry.threadId, messageId: entry.messageId, sightings: entry.sightings });
    }
    return {
      version: 1,
      channels,
      threads: { lastRow: this.#lastRow, pendingRows: [...this.#pendingRows], messages: threads },
    };
  }

  /** Writes the file now when the index changed since the last write. */
  readonly flush = Effect.fn("WorkspaceArtifactIndex.flush")(function* (this: WorkspaceArtifactIndex) {
    const path = this.#options.path;
    if (!path) return;
    yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        if (!this.#dirty) return;
        this.#dirty = false;
        // A channel that was deleted while it was stored is not kept.
        for (const channelId of [...this.#channels.keys()])
          if (!this.#options.channels.exists(channelId)) this.#channels.delete(channelId);
        const written = yield* Effect.result(
          writeJsonFileAtomically(path, this.#snapshot(), { createDirectory: true }),
        );
        if (Result.isFailure(written)) {
          this.#dirty = true;
          logger.warn("The workspace artifact index could not be saved.", { operation: written.failure.operation });
        }
      }),
    );
  });

  /** Stops the delayed write and writes the file now. The index stays readable. */
  readonly stop = Effect.fn("WorkspaceArtifactIndex.stop")(function* (this: WorkspaceArtifactIndex) {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    yield* this.flush();
  });
}
