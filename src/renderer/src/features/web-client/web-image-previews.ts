import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";
import type { WebFile } from "./web-runtime";

/**
 * A preview downloads the whole file through the host connection as base64, so only a small image is
 * fetched by itself. A larger one stays a file card that the user opens.
 */
const IMAGE_BUDGET_BYTES = 3 * 1024 * 1024;
/** The images kept as blob URLs: at most this many, and at most this many bytes together. */
const CACHE_ENTRIES = 24;
const CACHE_BYTES = 48 * 1024 * 1024;
/** Downloads share the host connection with the chat, so few run at once. */
const PARALLEL_DOWNLOADS = 2;
/** A card starts its download a little before it is on screen. */
const ROOT_MARGIN = "240px 0px";
const CARD_SELECTOR = ".attachment-preview-button[data-attachment-id]";

/**
 * Inline previews of the image files of a chat, for the browser, which has no host file URL. A card
 * that scrolls into view fetches its image, makes a blob URL, and the shared message view then shows
 * the picture in place of the card. The cache is small and the URLs are revoked when the host changes.
 */
export function createWebImagePreviews(options: {
  download(attachmentId: string): Promise<WebFile>;
  /** The attachment's metadata from the loaded chat, or undefined for a file that is not on screen. */
  find(attachmentId: string): AttachmentSummary | undefined;
  online(): boolean;
}) {
  const [urls, setUrls] = createSignal<ReadonlyMap<string, string>>(new Map());
  /** Insertion order is use order: a hit moves an entry to the end, and the first entry leaves first. */
  const cache = new Map<string, { url: string; bytes: number }>();
  const visible = new Set<string>();
  const failed = new Set<string>();
  const waiting: string[] = [];
  const started = new Set<string>();
  let running = 0;
  let epoch = 0;
  let disconnect: (() => void) | undefined;

  function publish(): void {
    setUrls(new Map([...cache].map(([id, entry]) => [id, entry.url])));
  }
  function evict(): void {
    let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [id, entry] of cache) {
      if (cache.size <= CACHE_ENTRIES && bytes <= CACHE_BYTES) return;
      // A picture on screen stays. Its card would otherwise flip back while the user looks at it.
      if (visible.has(id)) continue;
      URL.revokeObjectURL(entry.url);
      cache.delete(id);
      bytes -= entry.bytes;
    }
  }
  function eligible(id: string): boolean {
    if (cache.has(id) || started.has(id) || failed.has(id) || !options.online()) return false;
    const attachment = options.find(id);
    return (
      attachment !== undefined &&
      attachment.previewKind === "image" &&
      attachment.mimeType.startsWith("image/") &&
      attachment.size <= IMAGE_BUDGET_BYTES
    );
  }
  function pump(): void {
    while (running < PARALLEL_DOWNLOADS) {
      const id = waiting.shift();
      if (id === undefined) return;
      if (!eligible(id)) continue;
      running += 1;
      void fetchImage(id, epoch);
    }
  }
  async function fetchImage(id: string, token: number): Promise<void> {
    started.add(id);
    try {
      const file = await options.download(id);
      if (token !== epoch || !file.mimeType.startsWith("image/")) return;
      const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
      cache.set(id, { url: URL.createObjectURL(new Blob([bytes], { type: file.mimeType })), bytes: bytes.byteLength });
      evict();
      publish();
    } catch {
      // The card stays. A failure while online is not retried until the host changes or connects again.
      if (token === epoch && options.online()) failed.add(id);
    } finally {
      if (token === epoch) {
        started.delete(id);
        running -= 1;
        pump();
      }
    }
  }
  function request(id: string): void {
    const cached = cache.get(id);
    if (cached) {
      cache.delete(id);
      cache.set(id, cached);
      return;
    }
    if (!eligible(id) || waiting.includes(id)) return;
    waiting.push(id);
    pump();
  }

  /** Starts the previews of the cards under `root`, also those that appear later. Returns the stop function. */
  function observe(root: Element): () => void {
    if (typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined") return () => {};
    const intersections = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          const id = record.target instanceof HTMLElement ? record.target.dataset.attachmentId : undefined;
          if (!id) continue;
          if (record.isIntersecting) {
            visible.add(id);
            request(id);
          } else visible.delete(id);
        }
      },
      { rootMargin: ROOT_MARGIN },
    );
    const cards = (node: Element): Element[] => [
      ...(node.matches(CARD_SELECTOR) ? [node] : []),
      ...node.querySelectorAll(CARD_SELECTOR),
    ];
    for (const card of cards(root)) intersections.observe(card);
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        // A removed card must leave the observer, or the observer keeps the detached element alive.
        for (const node of record.removedNodes)
          if (node instanceof Element) for (const card of cards(node)) intersections.unobserve(card);
        for (const node of record.addedNodes)
          if (node instanceof Element) for (const card of cards(node)) intersections.observe(card);
      }
    });
    mutations.observe(root, { childList: true, subtree: true });
    const stop = () => {
      intersections.disconnect();
      mutations.disconnect();
      visible.clear();
    };
    disconnect = stop;
    return stop;
  }

  /** Revokes every URL and forgets every failure, for a host change or a new connection. */
  function reset(): void {
    epoch += 1;
    for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
    cache.clear();
    waiting.length = 0;
    started.clear();
    failed.clear();
    running = 0;
    publish();
  }

  return {
    /** The blob URL of an image that was fetched, or null. Reads a signal, so a view updates when it arrives. */
    url: (attachmentId: string): string | null => urls().get(attachmentId) ?? null,
    observe,
    reset,
    /** Clears a failure that came while offline, so the next view of a card tries again. */
    retryFailed: () => failed.clear(),
    dispose(): void {
      disconnect?.();
      reset();
    },
  };
}
