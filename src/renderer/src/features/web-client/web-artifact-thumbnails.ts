import { WORKSPACE_ARTIFACT_THUMBNAIL_TYPES } from "@openbot/contracts/team-protocol/workspace-fleet-v1";
import { base64ToBytes } from "@openbot/team-client/base64";
import { createSignal } from "solid-js";
import type { ArtifactThumbnailUrl } from "../workspace/workspace-sources";
import type { WebWorkspaceRuntime } from "./web-runtime";

/** The images kept as object URLs. The least recently shown one goes first. */
const CACHE_LIMIT = 120;
/** The chat shares the host connection, so one image downloads at a time. */
const CONCURRENT_DOWNLOADS = 1;

export interface WebArtifactThumbnails {
  url: ArtifactThumbnailUrl;
  /** Revokes every object URL. */
  dispose(): void;
}

/**
 * Object URLs for the images that the host drew of artifact pages. The browser client cannot read
 * an `openbot-avatar` address, so each image is read through the host connection when a card shows
 * it. Only PNG and WebP get a URL: a blob URL has the origin of the app.
 */
export function createWebArtifactThumbnails(
  remote: Pick<WebWorkspaceRuntime, "artifactThumbnail">,
  hostId: () => string,
  urls: { create(blob: Blob): string; revoke(url: string): void } = {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  },
): WebArtifactThumbnails {
  const entries = new Map<string, string>();
  const [shown, setShown] = createSignal<ReadonlyMap<string, string>>(new Map());
  const started = new Set<string>();
  const waiting: (() => void)[] = [];
  let active = 0;
  let cachedHost = "";
  let generation = 0;
  let disposed = false;

  const clear = () => {
    for (const url of entries.values()) urls.revoke(url);
    entries.clear();
    started.clear();
    generation += 1;
  };
  const slot = async () => {
    if (active >= CONCURRENT_DOWNLOADS) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
  };
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };

  async function download(key: string, artifactId: string, version: string) {
    const read = remote.artifactThumbnail;
    if (!read) return;
    const at = generation;
    await slot();
    try {
      if (at !== generation) return;
      const file = await read(artifactId, version);
      const type = file.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
      if (at !== generation || !WORKSPACE_ARTIFACT_THUMBNAIL_TYPES.some((allowed) => allowed === type)) return;
      entries.set(key, urls.create(new Blob([base64ToBytes(file.base64)], { type })));
      for (const [oldKey, old] of entries) {
        if (entries.size <= CACHE_LIMIT) break;
        entries.delete(oldKey);
        urls.revoke(old);
      }
      setShown(new Map(entries));
    } catch {
      // The card keeps its drawing; the next version of the image is asked for again.
    } finally {
      release();
    }
  }

  return {
    url(record) {
      if (disposed) return undefined;
      const host = hostId();
      // The images of another host are not shown here, so a host switch drops them.
      if (host !== cachedHost) {
        clear();
        cachedHost = host;
      }
      const key = `${host}:${record.id}:${record.thumbnailVersion}`;
      const url = shown().get(key);
      if (url) return url;
      // The write comes after the download, never while a list renders.
      if (!started.has(key)) {
        started.add(key);
        void download(key, record.id, record.thumbnailVersion);
      }
      return undefined;
    },
    dispose() {
      disposed = true;
      clear();
      setShown(new Map());
    },
  };
}
