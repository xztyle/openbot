import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Semaphore } from "effect";
import { nativeImage } from "electron";

// Small copies of image attachments, for a client that reads them through the host connection.
//
// A browser shows an image of a message inline. The original can be a screenshot of several MB, and
// the connection shares one ordered data channel with every other download, so a small copy keeps the
// chat fast. The copy is made once and kept on disk, keyed by the file's path, size and change time:
// an attachment id names bytes that do not change.

/** The longest side of a preview. A chat column and a phone screen show it sharp. */
export const ATTACHMENT_PREVIEW_EDGE = 1024;
/** A smaller file goes as it is: a copy would save almost nothing. */
const PREVIEW_MIN_BYTES = 256 * 1024;
/** `nativeImage` decodes in the main process. A larger file goes as it is, and the client decides. */
const PREVIEW_MAX_SOURCE_BYTES = 40 * 1024 * 1024;
/** The copies kept on disk. The oldest go first. */
const PREVIEW_CACHE_FILES = 2_000;
const JPEG_QUALITY = 82;
/** `nativeImage` decodes these on every platform. WebP, GIF and AVIF go as they are. */
const RESIZABLE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);

export interface AttachmentPreviewFile {
  path: string;
  mimeType: string;
}

export class AttachmentPreviews {
  readonly #directory: string;
  /** One image at a time: the decode runs on the main thread. */
  readonly #lock = Semaphore.makeUnsafe(1);
  readonly #pending = new Map<string, Promise<AttachmentPreviewFile | null>>();
  #writes = 0;

  constructor(directory: string) {
    this.#directory = directory;
  }

  /**
   * The preview of an image attachment, or `null` when the original is small enough or cannot be
   * resized here. A failure also answers `null`: the client then gets the original.
   */
  readonly preview = Effect.fn("AttachmentPreviews.preview")(function* (
    this: AttachmentPreviews,
    source: AttachmentPreviewFile,
  ): Effect.fn.Return<AttachmentPreviewFile | null> {
    const type = source.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!RESIZABLE_TYPES.has(type)) return null;
    const info = yield* Effect.promise(() => stat(source.path).catch(() => null));
    if (!info?.isFile() || info.size < PREVIEW_MIN_BYTES || info.size > PREVIEW_MAX_SOURCE_BYTES) return null;
    const key = createHash("sha256").update(`${source.path}\0${info.size}\0${info.mtimeMs}`).digest("hex").slice(0, 40);
    let job = this.#pending.get(key);
    if (!job) {
      const made = Effect.runPromise(this.#lock.withPermit(Effect.promise(() => this.#make(source.path, key))));
      this.#pending.set(key, made);
      void made.finally(() => this.#pending.delete(key));
      job = made;
    }
    const pending = job;
    return yield* Effect.promise(() => pending);
  }).bind(this);

  async #make(path: string, key: string): Promise<AttachmentPreviewFile | null> {
    for (const [extension, mimeType] of [
      ["jpg", "image/jpeg"],
      ["png", "image/png"],
    ] as const) {
      const cached = join(this.#directory, `${key}.${extension}`);
      if (
        await stat(cached).then(
          (info) => info.isFile(),
          () => false,
        )
      )
        return { path: cached, mimeType };
    }
    try {
      const image = nativeImage.createFromPath(path);
      const size = image.getSize();
      if (image.isEmpty() || size.width <= 0 || size.height <= 0) return null;
      const scale = Math.min(1, ATTACHMENT_PREVIEW_EDGE / Math.max(size.width, size.height));
      const resized =
        scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
              quality: "good",
            })
          : image;
      // An image with transparent pixels stays a PNG; JPEG would paint them black.
      const transparent = hasTransparency(resized.toBitmap());
      const bytes = transparent ? resized.toPNG() : resized.toJPEG(JPEG_QUALITY);
      const extension = transparent ? "png" : "jpg";
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const target = join(this.#directory, `${key}.${extension}`);
      const partial = `${target}.${process.pid}.part`;
      await writeFile(partial, bytes, { mode: 0o600 });
      await rename(partial, target);
      if (++this.#writes % 50 === 1) void this.#prune();
      return { path: target, mimeType: transparent ? "image/png" : "image/jpeg" };
    } catch {
      return null;
    }
  }

  /** Keeps the newest copies. A removed copy is made again when a client asks for it. */
  async #prune(): Promise<void> {
    try {
      const names = (await readdir(this.#directory)).filter((name) => /\.(jpg|png)$/u.test(name));
      if (names.length <= PREVIEW_CACHE_FILES) return;
      const files = await Promise.all(
        names.map(async (name) => {
          const path = join(this.#directory, name);
          return {
            path,
            at: await stat(path).then(
              (info) => info.mtimeMs,
              () => 0,
            ),
          };
        }),
      );
      files.sort((left, right) => left.at - right.at);
      await Promise.all(
        files.slice(0, files.length - PREVIEW_CACHE_FILES).map((file) => rm(file.path, { force: true })),
      );
    } catch {
      // A copy that stays is only disk space.
    }
  }
}

/** Whether a BGRA or RGBA bitmap has a pixel that is not fully opaque. */
function hasTransparency(bitmap: Buffer): boolean {
  for (let index = 3; index < bitmap.length; index += 4) if (bitmap[index] !== 255) return true;
  return false;
}
