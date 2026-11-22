import { attachmentMimeTypeForName, playableMediaKind } from "@openbot/contracts/attachment-files";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { base64ToBytes } from "@openbot/team-client/base64";
import { MOBILE_ATTACHMENT_BYTES } from "@openbot/team-client/remote-peer";
import type { AttachmentMediaSource } from "@openbot/ui/features/conversation/AttachmentCards";
import { createEffect, createSignal } from "solid-js";
import type { WebFile, WebWorkspaceRuntime } from "./web-runtime";

/**
 * An image above this size shows inline only when the host sends a small copy of it: the original
 * must not cost a large download for a picture in a chat row.
 */
const WEB_THUMBNAIL_BYTES = 4 * 1024 * 1024;
/** The host connection sends at most this many bytes for one file. */
const WEB_MEDIA_BYTES = MOBILE_ATTACHMENT_BYTES;
const CACHE_BYTES = 96 * 1024 * 1024;
/** The chat shares the host connection, so only a few files download at the same time. */
const CONCURRENT_DOWNLOADS = 2;
/** The browser's own cache of attachment files. A new name drops the files of an older format. */
const STORED_CACHE = "openbot-attachment-media-v1";
/** Files kept in the browser's cache. The oldest go first. */
const STORED_FILES = 400;

/** The images that the host can make a small copy of. Any other image comes as it is. */
const RESIZABLE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
/**
 * The only types that get an object URL. A blob URL has the origin of the app, so a type that a
 * browser can run as a page (HTML, SVG, XHTML) would get the account and host keys of this tab. An
 * SVG image gets a `data:` URL instead: an image element does not run its scripts, and a `data:`
 * page has no origin of its own.
 */
const MEDIA_TYPES: ReadonlySet<string> = new Set([...IMAGE_TYPES, "audio/mpeg", "video/quicktime"]);
const SVG_TYPE = "image/svg+xml";

export interface WebAttachmentMedia extends AttachmentMediaSource {
  /** Revokes every object URL. */
  dispose(): void;
}

interface Entry {
  url: string;
  bytes: number;
}

type Variant = "inline" | "full";

/**
 * Object URLs for the images, audio and video of host attachments. The browser client gets no
 * `previewUrl`, so each file is read through the host connection when the chat shows it.
 *
 * An image shows inline from a small copy that the host makes, and the viewer reads the original.
 * Both stay in memory as object URLs and in the browser's cache, so a chat opened again shows its
 * images without a download: an attachment id names bytes that do not change.
 */
export function createWebAttachmentMedia(
  remote: Pick<WebWorkspaceRuntime, "download" | "attachmentPreview">,
  hostId: () => string,
  urls: { create(blob: Blob): string; revoke(url: string): void } = {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  },
  /**
   * Whether the host connection is up. A read that a lost connection cut is tried again when it
   * comes back: a phone that wakes the app reads while it reconnects, and its images would otherwise
   * stay file cards. Reactive.
   */
  online?: () => boolean,
): WebAttachmentMedia {
  // Insertion order is the use order: the first entry is the least recently used.
  const entries = new Map<string, Entry>();
  const [shown, setShown] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [failures, setFailures] = createSignal<ReadonlySet<string>>(new Set());
  /** Failures of a read that threw, as a lost connection does, rather than of a file that cannot show. */
  const cut = new Set<string>();
  const loading = new Map<string, Promise<boolean>>();
  /** Inline copies that are the original file, so the viewer needs no second download. */
  const originals = new Set<string>();
  const waiting: (() => void)[] = [];
  let active = 0;
  let cachedHost = "";
  let total = 0;
  // A clear makes every running download stale, so it cannot store a URL that nothing revokes.
  let generation = 0;
  let disposed = false;

  const publish = () => setShown(new Map([...entries].map(([key, entry]) => [key, entry.url])));
  // No publish here: a card row calls `load` while it renders, and Solid refuses a write there.
  // `url` reads only keys of the current host, so the old host's URLs are never shown.
  const clear = () => {
    for (const entry of entries.values()) if (entry.url.startsWith("blob:")) urls.revoke(entry.url);
    entries.clear();
    loading.clear();
    originals.clear();
    total = 0;
    generation += 1;
  };
  /** The files of another host are not shown here, so a host switch drops them. */
  const currentHost = () => {
    const host = hostId();
    if (host !== cachedHost) {
      clear();
      cachedHost = host;
    }
    return host;
  };
  const store = (key: string, entry: Entry) => {
    entries.set(key, entry);
    total += entry.bytes;
    for (const [oldKey, old] of entries) {
      if (total <= CACHE_BYTES || oldKey === key) break;
      entries.delete(oldKey);
      originals.delete(oldKey);
      total -= old.bytes;
      if (old.url.startsWith("blob:")) urls.revoke(old.url);
    }
    publish();
  };
  const slot = async () => {
    if (active >= CONCURRENT_DOWNLOADS) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
  };
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  const fail = (key: string) => setFailures((current) => new Set(current).add(key));

  /** Makes the URL of `bytes`, or `null` for a type that must not get one. */
  const urlOf = (bytes: Uint8Array, type: string) => {
    if (type === SVG_TYPE) return `data:${SVG_TYPE};base64,${bytesToBase64(bytes)}`;
    if (!MEDIA_TYPES.has(type)) return null;
    return urls.create(new Blob([new Uint8Array(bytes)], { type }));
  };

  async function fetchFile(
    attachment: AttachmentSummary,
    variant: Variant,
  ): Promise<{ bytes: Uint8Array; type: string; original: boolean } | null> {
    const declared = mediaType(attachment);
    if (!declared) return null;
    const host = cachedHost;
    const stored = await storedFile(host, attachment.id, variant);
    if (stored) return { ...stored, original: stored.type === declared && stored.bytes.byteLength === attachment.size };
    let file: WebFile | null = null;
    if (variant === "inline" && remote.attachmentPreview && RESIZABLE_TYPES.has(declared))
      file = await remote.attachmentPreview(attachment.id);
    // Without a copy from the host, a large original is not read for a picture in a chat row.
    if (!file && variant === "inline" && attachment.size > WEB_THUMBNAIL_BYTES) return null;
    file ??= await remote.download(attachment.id);
    const bytes = base64ToBytes(file.base64);
    // The host's type is used only when it made a copy, and only when it is an allowed image type.
    const sent = file.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    const original = bytes.byteLength === attachment.size;
    const type = original ? declared : IMAGE_TYPES.has(sent) ? sent : declared;
    // Images only: a video would fill the browser's cache with a few files.
    if (type.startsWith("image/")) void storeFile(host, attachment.id, original ? "full" : variant, bytes, type);
    return { bytes, type, original };
  }

  async function download(attachment: AttachmentSummary, variant: Variant, limit: number, key: string) {
    const started = generation;
    await slot();
    try {
      if (generation !== started) return false;
      const file = await fetchFile(attachment, variant);
      if (generation !== started) return false;
      const url = file && file.bytes.byteLength <= limit ? urlOf(file.bytes, file.type) : null;
      if (!file || !url) {
        fail(key);
        return false;
      }
      store(key, { url, bytes: file.bytes.byteLength });
      if (variant === "inline" && file.original) originals.add(key);
      return true;
    } catch {
      // The card keeps its icon and its download button, until the connection comes back.
      if (generation === started) {
        cut.add(key);
        fail(key);
      }
      return false;
    } finally {
      release();
    }
  }

  if (online)
    createEffect(online, (up, wasUp) => {
      if (!up || wasUp !== false || cut.size === 0) return;
      const retry = new Set(cut);
      cut.clear();
      setFailures((current) => new Set([...current].filter((key) => !retry.has(key))));
    });

  const begin = (key: string, run: () => Promise<boolean>) => {
    const entry = entries.get(key);
    if (entry) {
      entries.delete(key);
      entries.set(key, entry);
      return Promise.resolve(true);
    }
    const running = loading.get(key);
    if (running) return running;
    const job = run().finally(() => {
      if (loading.get(key) === job) loading.delete(key);
    });
    loading.set(key, job);
    return job;
  };

  const inlineImage = (attachment: AttachmentSummary) => {
    const type = mediaType(attachment);
    if (!type || (!IMAGE_TYPES.has(type) && type !== SVG_TYPE)) return false;
    // A host with previews sends a small copy of a large PNG or JPEG.
    return (
      attachment.size <= WEB_THUMBNAIL_BYTES ||
      (Boolean(remote.attachmentPreview) && RESIZABLE_TYPES.has(type) && attachment.size <= 40 * 1024 * 1024)
    );
  };

  return {
    thumbnailLimit: WEB_THUMBNAIL_BYTES,
    mediaLimit: WEB_MEDIA_BYTES,
    url: (id) => (disposed ? undefined : shown().get(`${hostId()}:${id}`)),
    fullUrl: (id) => {
      if (disposed) return undefined;
      const host = hostId();
      const urlsShown = shown();
      return (
        urlsShown.get(`${host}:${id}:full`) ??
        (originals.has(`${host}:${id}`) ? urlsShown.get(`${host}:${id}`) : undefined)
      );
    },
    failed: (id) => failures().has(`${hostId()}:${id}`),
    inlineImage,
    load(attachment) {
      const host = currentHost();
      const key = `${host}:${attachment.id}`;
      return begin(key, () => {
        const type = mediaType(attachment);
        if (!type) return Promise.resolve(false);
        if (IMAGE_TYPES.has(type) || type === SVG_TYPE) {
          if (!inlineImage(attachment)) return Promise.resolve(false);
          return download(attachment, "inline", WEB_MEDIA_BYTES, key);
        }
        if (!playableMediaKind(type) || attachment.size > WEB_MEDIA_BYTES) return Promise.resolve(false);
        return download(attachment, "full", WEB_MEDIA_BYTES, key);
      });
    },
    loadFull(attachment) {
      const host = currentHost();
      const key = `${host}:${attachment.id}`;
      if (originals.has(key) && entries.has(key)) return Promise.resolve(true);
      const type = mediaType(attachment);
      if (!type || attachment.size > WEB_MEDIA_BYTES || (!IMAGE_TYPES.has(type) && type !== SVG_TYPE))
        return Promise.resolve(false);
      return begin(`${key}:full`, () => download(attachment, "full", WEB_MEDIA_BYTES, `${key}:full`));
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

/** Removes every attachment file that this browser keeps, as at sign-out. */
export async function clearWebAttachmentCache(): Promise<void> {
  try {
    await globalThis.caches?.delete(STORED_CACHE);
  } catch {
    // No cache, or the browser refuses it: nothing is kept.
  }
}

function storedRequest(host: string, attachmentId: string, variant: Variant): string {
  return `https://attachment-cache.invalid/${encodeURIComponent(host)}/${encodeURIComponent(attachmentId)}/${variant}`;
}

async function storedFile(
  host: string,
  attachmentId: string,
  variant: Variant,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  try {
    const cache = await globalThis.caches?.open(STORED_CACHE);
    if (!cache) return null;
    // The original serves as the inline copy too.
    const response =
      (await cache.match(storedRequest(host, attachmentId, variant))) ??
      (variant === "inline" ? await cache.match(storedRequest(host, attachmentId, "full")) : undefined);
    if (!response) return null;
    const type = response.headers.get("Content-Type") ?? "";
    return { bytes: new Uint8Array(await response.arrayBuffer()), type };
  } catch {
    return null;
  }
}

async function storeFile(host: string, attachmentId: string, variant: Variant, bytes: Uint8Array, type: string) {
  try {
    const cache = await globalThis.caches?.open(STORED_CACHE);
    if (!cache) return;
    await cache.put(
      storedRequest(host, attachmentId, variant),
      new Response(new Uint8Array(bytes), { headers: { "Content-Type": type } }),
    );
    // `keys` lists the requests in the order they were stored.
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - STORED_FILES)).map((request) => cache.delete(request)));
  } catch {
    // A full or private-mode cache keeps nothing. The file came anyway.
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(parts.join(""));
}

/** The allowed type of an attachment, from its own type or else its name. The host's file type is not used. */
function mediaType(attachment: AttachmentSummary): string | null {
  const declared =
    attachment.mimeType.split(";")[0]?.trim().toLowerCase() || attachmentMimeTypeForName(attachment.name);
  return MEDIA_TYPES.has(declared) || declared === SVG_TYPE ? declared : null;
}
