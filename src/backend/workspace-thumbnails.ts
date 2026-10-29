import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import {
  WORKSPACE_ARTIFACT_THUMBNAIL_BYTES,
  type WORKSPACE_ARTIFACT_THUMBNAIL_TYPES,
} from "@openbot/contracts/team-protocol/workspace-fleet-v1";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Fiber, Result, Schema, Semaphore } from "effect";
import { writeFileAtomically, writeJsonFileAtomically } from "./atomic-json-file";

const logger = createOpenBotLogger("workspace-thumbnails");

/** The page is drawn at this size and saved this wide. */
export const WORKSPACE_THUMBNAIL_VIEWPORT = { width: 1_280, height: 800 } as const;
export const WORKSPACE_THUMBNAIL_WIDTH = 480;
const STATE_FILE = "thumbnails-v1.json";
const RETRY_AFTER_MS = 6 * 60 * 60 * 1_000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1_000;
const TIMEOUT_MS = 15_000;
/** Pages that wait for a capture. A page that does not fit is asked for again at the next list. */
const QUEUE_LIMIT = 100;
/** The pages with a state. The one asked for least recently goes first, with its image. */
const ENTRY_LIMIT = 1_000;
/** The address answers kept for the requests of the pages, so a page with many files is not slow. */
const ADDRESS_CACHE_LIMIT = 500;
const ADDRESS_CACHE_MS = 10 * 60 * 1_000;
const ARTIFACT_ID = /^artifact-([0-9a-f]{32})$/u;

export type WorkspaceThumbnailMimeType = (typeof WORKSPACE_ARTIFACT_THUMBNAIL_TYPES)[number];

export interface WorkspaceThumbnailImage {
  bytes: Uint8Array;
  mimeType: WorkspaceThumbnailMimeType;
}

/** The page was not drawn. The reason goes to the log; no address or page content does. */
export class WorkspaceThumbnailCaptureFailed extends Schema.TaggedError<WorkspaceThumbnailCaptureFailed>()(
  "WorkspaceThumbnailCaptureFailed",
  { reason: Schema.Literals(["load", "timeout", "capture", "blocked"]) },
) {}

/** The host name has no address that this computer could find. */
export class WorkspaceThumbnailLookupFailed extends Schema.TaggedError<WorkspaceThumbnailLookupFailed>()(
  "WorkspaceThumbnailLookupFailed",
  { cause: Schema.Defect() },
) {}

/**
 * Draws one page. The main process owns the window. `allow` answers for each request of the page,
 * redirects too, whether its address may be loaded; the port refuses a request that it does not allow.
 */
export type WorkspaceThumbnailCapture = (
  url: string,
  allow: (url: string) => Effect.Effect<boolean>,
) => Effect.Effect<WorkspaceThumbnailImage, WorkspaceThumbnailCaptureFailed>;

export interface WorkspaceThumbnailsOptions {
  /** The images and their state file, host only: `<userData>/workspace-thumbnails`. */
  directory: string;
  capture: WorkspaceThumbnailCapture;
  /** The addresses of a host name. Omitted, `node:dns` gives all of them. */
  resolve?: (host: string) => Effect.Effect<readonly string[], WorkspaceThumbnailLookupFailed>;
  now?: () => number;
  /** A page that failed is not drawn again for this long. Omitted, 6 hours. */
  retryAfterMs?: number;
  /** An image older than this is drawn again. Omitted, 24 hours. */
  refreshAfterMs?: number;
  /** A capture that takes longer fails. Omitted, 15 seconds. */
  timeoutMs?: number;
}

const Entry = Schema.Struct({
  version: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/u))),
  mimeType: Schema.optional(Schema.Literals(["image/webp", "image/png"])),
  okAt: Schema.optional(Schema.Finite),
  failedAt: Schema.optional(Schema.Finite),
  requestedAt: Schema.Finite,
});
type Entry = typeof Entry.Type;
const StateFile = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Record(Schema.String, Entry),
});
const decodeStateFile = Schema.decodeUnknownSync(StateFile);

/**
 * Two lists: a `BlockList` checks an IPv4 address against its IPv6 rules too, as the mapped
 * `::ffff:a.b.c.d`, so one list with `::ffff:0:0/96` would refuse every IPv4 address.
 */
const [PRIVATE_IPV4, PRIVATE_IPV6] = (() => {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    ipv4.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ] as const)
    ipv6.addSubnet(network, prefix, "ipv6");
  return [ipv4, ipv6] as const;
})();

/**
 * Whether `address` is an IP address on the public internet. Loopback, private, link-local, shared,
 * multicast, documentation and reserved ranges are not, nor an IPv6 address that holds an IPv4 one.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4 ? !PRIVATE_IPV4.check(address, "ipv4") : !PRIVATE_IPV6.check(address, "ipv6");
}

/** A host name that names this computer or its network, which no DNS answer needs to confirm. */
function isLocalName(host: string): boolean {
  return (
    !host.includes(".") ||
    host === "localhost" ||
    /\.(localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/u.test(host)
  );
}

function hostOf(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function imageMatches(image: WorkspaceThumbnailImage): boolean {
  const bytes = image.bytes;
  if (bytes.byteLength < 12 || bytes.byteLength > WORKSPACE_ARTIFACT_THUMBNAIL_BYTES) return false;
  if (image.mimeType === "image/png")
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return (
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  );
}

const defaultResolve = (host: string) =>
  Effect.tryPromise({
    try: async () => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address),
    catch: (cause) => new WorkspaceThumbnailLookupFailed({ cause }),
  });

/**
 * Owns the thumbnails of the workspace artifacts that are web pages: a queue of pages to draw, one at
 * a time, the address guard, the images in `directory` and their state file beside them. A page is
 * asked for each time a list shows it; `request` never waits. A page is drawn again after
 * `refreshAfterMs`; one that failed waits `retryAfterMs`, and keeps the image it had. Only a page on
 * the default port of a public http or https address is drawn, and each request of the page is
 * checked again. The port draws; this class imports no Electron and never imports the facade.
 */
export class WorkspaceThumbnails {
  readonly #options: WorkspaceThumbnailsOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #queue = new Map<string, string>();
  readonly #addresses = new Map<string, { allowed: boolean; at: number }>();
  readonly #writes = Semaphore.makeUnsafe(1);
  #worker: Fiber.Fiber<void> | null = null;
  #current: string | null = null;
  #loaded = false;
  #stopped = false;

  constructor(options: WorkspaceThumbnailsOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const file = decodeStateFile(JSON.parse(readFileSync(join(this.#options.directory, STATE_FILE), "utf8")));
      for (const [id, entry] of Object.entries(file.entries)) if (ARTIFACT_ID.test(id)) this.#entries.set(id, entry);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        logger.warn("The workspace thumbnail state could not be read. It starts empty.");
    }
  }

  /** The image file of an artifact, by the hash in its id. */
  #path(id: string, mimeType: WorkspaceThumbnailMimeType): string | null {
    const hash = ARTIFACT_ID.exec(id)?.[1];
    return hash ? join(this.#options.directory, `${hash}.${mimeType === "image/webp" ? "webp" : "png"}`) : null;
  }

  /**
   * Asks for an image of the page at `url` for the artifact `id`. It is drawn later, when it has no
   * current image and did not fail in the retry window.
   */
  request(id: string, url: string): void {
    if (this.#stopped || !ARTIFACT_ID.test(id)) return;
    this.#load();
    const now = this.#now();
    const entry = this.#entries.get(id);
    if (entry) {
      this.#entries.delete(id);
      this.#entries.set(id, { ...entry, requestedAt: now });
    }
    if (entry?.okAt !== undefined && now - entry.okAt < (this.#options.refreshAfterMs ?? REFRESH_AFTER_MS)) return;
    if (entry?.failedAt !== undefined && now - entry.failedAt < (this.#options.retryAfterMs ?? RETRY_AFTER_MS)) return;
    if (this.#current === id || this.#queue.has(id) || this.#queue.size >= QUEUE_LIMIT) return;
    this.#queue.set(id, url);
    if (!this.#worker) this.#worker = Effect.runFork(this.#drain());
  }

  /** The version of the current image of an artifact, or undefined when it has none. */
  version(id: string): string | undefined {
    this.#load();
    return this.#entries.get(id)?.version;
  }

  /** The image of an artifact when `version` is its current version, else null. */
  file(id: string, version: string): { path: string; mimeType: WorkspaceThumbnailMimeType } | null {
    this.#load();
    const entry = this.#entries.get(id);
    if (!entry?.version || !entry.mimeType || entry.version !== version) return null;
    const path = this.#path(id, entry.mimeType);
    return path ? { path, mimeType: entry.mimeType } : null;
  }

  /** The state of an artifact's page: when it was drawn and when it last failed. */
  state(id: string): { version?: string; okAt?: number; failedAt?: number } | null {
    this.#load();
    const entry = this.#entries.get(id);
    if (!entry) return null;
    return {
      ...(entry.version ? { version: entry.version } : {}),
      ...(entry.okAt === undefined ? {} : { okAt: entry.okAt }),
      ...(entry.failedAt === undefined ? {} : { failedAt: entry.failedAt }),
    };
  }

  /** Whether the page at `url` may be drawn: http or https, no credentials, the default port, a public address. */
  readonly allowsPage = Effect.fn("WorkspaceThumbnails.allowsPage")(function* (this: WorkspaceThumbnails, url: string) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.username || parsed.password || parsed.port) return false;
    return yield* this.#publicHost(parsed);
  });

  /**
   * Whether a request of a page may load: a `data:`, `blob:` or `about:` address, or an http, https,
   * ws or wss address that is public.
   */
  readonly allowsRequest = Effect.fn("WorkspaceThumbnails.allowsRequest")(function* (
    this: WorkspaceThumbnails,
    url: string,
  ) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol === "data:" || parsed.protocol === "blob:" || parsed.protocol === "about:") return true;
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) || parsed.username || parsed.password)
      return false;
    return yield* this.#publicHost(parsed);
  });

  readonly #publicHost = Effect.fn("WorkspaceThumbnails.publicHost")(function* (this: WorkspaceThumbnails, url: URL) {
    const host = hostOf(url);
    if (!host) return false;
    if (isIP(host) !== 0) return isPublicAddress(host);
    if (isLocalName(host)) return false;
    const now = this.#now();
    const known = this.#addresses.get(host);
    if (known && now - known.at < ADDRESS_CACHE_MS) return known.allowed;
    const resolve = this.#options.resolve ?? defaultResolve;
    const addresses = yield* resolve(host).pipe(Effect.orElseSucceed((): readonly string[] => []));
    const allowed = addresses.length > 0 && addresses.every(isPublicAddress);
    if (this.#addresses.size >= ADDRESS_CACHE_LIMIT) this.#addresses.clear();
    this.#addresses.set(host, { allowed, at: now });
    return allowed;
  });

  /** Draws the pages that wait, one at a time, and writes the state after them. */
  readonly #drain = Effect.fn("WorkspaceThumbnails.drain")(function* (this: WorkspaceThumbnails) {
    for (;;) {
      const next = this.#queue.entries().next();
      if (!next.done) {
        const [id, url] = next.value;
        this.#queue.delete(id);
        this.#current = id;
        yield* this.#drawOne(id, url);
        this.#current = null;
        continue;
      }
      yield* this.#saveState();
      // The check and the release are one step, so a request after it starts a new worker.
      const done = yield* Effect.sync(() => {
        if (this.#queue.size && !this.#stopped) return false;
        this.#worker = null;
        return true;
      });
      if (done) return;
    }
  });

  readonly #drawOne = Effect.fn("WorkspaceThumbnails.drawOne")(function* (
    this: WorkspaceThumbnails,
    id: string,
    url: string,
  ) {
    const started = this.#now();
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();
    const result = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        if (!(yield* this.allowsPage(url))) return yield* new WorkspaceThumbnailCaptureFailed({ reason: "blocked" });
        const image = yield* this.#options.capture(url, (request) => this.allowsRequest(request));
        if (!imageMatches(image)) return yield* new WorkspaceThumbnailCaptureFailed({ reason: "capture" });
        return image;
      }).pipe(
        Effect.timeoutOrElse({
          duration: this.#options.timeoutMs ?? TIMEOUT_MS,
          orElse: () => Effect.fail(new WorkspaceThumbnailCaptureFailed({ reason: "timeout" })),
        }),
      ),
    );
    const entry: Entry = this.#entries.get(id) ?? { requestedAt: started };
    if (Result.isFailure(result)) {
      // The host only: a path or a query can hold a token.
      logger.warn("A workspace thumbnail could not be drawn.", { reason: result.failure.reason, host });
      this.#remember(id, { ...entry, failedAt: this.#now() });
      return;
    }
    const image = result.success;
    const path = this.#path(id, image.mimeType);
    if (!path) return;
    const written = yield* Effect.result(
      this.#writes.withPermit(writeFileAtomically(path, image.bytes, { createDirectory: true })),
    );
    if (Result.isFailure(written)) {
      logger.warn("A workspace thumbnail could not be saved.", { operation: written.failure.operation });
      this.#remember(id, { ...entry, failedAt: this.#now() });
      return;
    }
    // A page that changed from one image type to the other leaves no old file.
    if (entry.mimeType && entry.mimeType !== image.mimeType) yield* this.#removeImage(id, entry.mimeType);
    this.#remember(id, {
      requestedAt: entry.requestedAt,
      version: createHash("sha256").update(image.bytes).digest("hex").slice(0, 16),
      mimeType: image.mimeType,
      okAt: this.#now(),
    });
  });

  #remember(id: string, entry: Entry): void {
    if (this.#stopped && !this.#entries.has(id)) return;
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    while (this.#entries.size > ENTRY_LIMIT) {
      const oldest = [...this.#entries].reduce((left, right) =>
        right[1].requestedAt < left[1].requestedAt ? right : left,
      );
      this.#entries.delete(oldest[0]);
      if (oldest[1].mimeType) Effect.runFork(this.#removeImage(oldest[0], oldest[1].mimeType));
    }
  }

  #removeImage(id: string, mimeType: WorkspaceThumbnailMimeType) {
    const path = this.#path(id, mimeType);
    return path ? Effect.promise(() => rm(path, { force: true }).catch(() => undefined)) : Effect.void;
  }

  readonly #saveState = Effect.fn("WorkspaceThumbnails.saveState")(function* (this: WorkspaceThumbnails) {
    if (!this.#loaded) return;
    const saved = yield* Effect.result(
      this.#writes.withPermit(
        writeJsonFileAtomically(
          join(this.#options.directory, STATE_FILE),
          { version: 1, entries: Object.fromEntries(this.#entries) },
          { createDirectory: true },
        ),
      ),
    );
    if (Result.isFailure(saved))
      logger.warn("The workspace thumbnail state could not be saved.", { operation: saved.failure.operation });
  });

  /** Waits until no page waits or draws, and the state is written. */
  readonly whenIdle = Effect.fn("WorkspaceThumbnails.whenIdle")(function* (this: WorkspaceThumbnails) {
    while (this.#worker) yield* Fiber.join(this.#worker);
  });

  /** Stops the capture that runs, drops the queue and writes the state. */
  readonly stop = Effect.fn("WorkspaceThumbnails.stop")(function* (this: WorkspaceThumbnails) {
    this.#stopped = true;
    this.#queue.clear();
    const worker = this.#worker;
    this.#worker = null;
    this.#current = null;
    if (worker) yield* Fiber.interrupt(worker);
    yield* this.#saveState();
  });
}
