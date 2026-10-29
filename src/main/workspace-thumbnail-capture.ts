import { Effect, Semaphore } from "effect";
import { BrowserWindow, session as electronSession, type NativeImage, type Session } from "electron";
import {
  WORKSPACE_THUMBNAIL_VIEWPORT,
  WORKSPACE_THUMBNAIL_WIDTH,
  type WorkspaceThumbnailCapture,
  WorkspaceThumbnailCaptureFailed,
  type WorkspaceThumbnailImage,
} from "../backend/workspace-thumbnails";

/**
 * Draws the page of a workspace artifact for its thumbnail, in an offscreen window that is never
 * shown.
 *
 * The window has its own session in memory, with no permission, no download, no new window and no
 * address other than http and https: it cannot read the app's cookies, storage or attachments, and
 * what a page stores is cleared after each capture. It has no preload and no Node. Each request of
 * the page, a redirect too, goes through the guard of `WorkspaceThumbnails`, so a page cannot load
 * an address on this computer or its network. Its sound is muted.
 */

const PARTITION = "openbot-workspace-thumbnails";
/** The time a page gets after its load to draw what its scripts add. */
const SETTLE_MS = 1_500;

function failure(reason: WorkspaceThumbnailCaptureFailed["reason"]) {
  return new WorkspaceThumbnailCaptureFailed({ reason });
}

function scaled(image: NativeImage): WorkspaceThumbnailImage {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0 || image.isEmpty()) throw new Error("The page drew nothing.");
  const resized =
    size.width > WORKSPACE_THUMBNAIL_WIDTH
      ? image.resize({ width: WORKSPACE_THUMBNAIL_WIDTH, quality: "good" })
      : image;
  // `nativeImage` writes PNG and JPEG only, so the image is a PNG.
  return { bytes: new Uint8Array(resized.toPNG()), mimeType: "image/png" };
}

export class WorkspaceThumbnailCapturer {
  /** One page at a time: each one is a renderer process. */
  readonly #lock = Semaphore.makeUnsafe(1);
  #session: Session | null = null;
  #allow: ((url: string) => Effect.Effect<boolean>) | null = null;
  readonly #windows = new Set<BrowserWindow>();

  #captureSession(): Session {
    if (this.#session) return this.#session;
    const session = electronSession.fromPartition(PARTITION);
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on("will-download", (event) => event.preventDefault());
    session.webRequest.onBeforeRequest((details, callback) => {
      const allow = this.#allow;
      if (!allow) {
        callback({ cancel: true });
        return;
      }
      Effect.runPromise(allow(details.url)).then(
        (allowed) => callback({ cancel: !allowed }),
        () => callback({ cancel: true }),
      );
    });
    this.#session = session;
    return session;
  }

  readonly capture: WorkspaceThumbnailCapture = (url, allow) =>
    this.#lock.withPermit(
      Effect.acquireUseRelease(
        Effect.try({
          try: () => {
            const session = this.#captureSession();
            this.#allow = allow;
            const window = new BrowserWindow({
              show: false,
              width: WORKSPACE_THUMBNAIL_VIEWPORT.width,
              height: WORKSPACE_THUMBNAIL_VIEWPORT.height,
              useContentSize: true,
              enableLargerThanScreen: true,
              webPreferences: {
                offscreen: true,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                nodeIntegrationInSubFrames: false,
                nodeIntegrationInWorker: false,
                javascript: true,
                webviewTag: false,
                backgroundThrottling: false,
                session,
              },
            });
            this.#windows.add(window);
            return { window, session };
          },
          catch: () => failure("capture"),
        }),
        ({ window }) => this.#draw(window, url),
        ({ window, session }) =>
          Effect.promise(async () => {
            this.#allow = null;
            this.#windows.delete(window);
            if (!window.isDestroyed()) window.destroy();
            // The next page starts with no cookie or storage of this one.
            await session.clearStorageData().catch(() => undefined);
            await session.clearCache().catch(() => undefined);
          }),
      ),
    );

  readonly #draw = Effect.fn("WorkspaceThumbnailCapturer.draw")(function* (
    this: WorkspaceThumbnailCapturer,
    window: BrowserWindow,
    url: string,
  ): Effect.fn.Return<WorkspaceThumbnailImage, WorkspaceThumbnailCaptureFailed> {
    const contents = window.webContents;
    contents.setAudioMuted(true);
    contents.setFrameRate(5);
    let painted: NativeImage | null = null;
    contents.on("paint", (_event, _dirty, image) => {
      painted = image;
    });
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    // A page may move to another http or https page, which the request guard checks; nothing else.
    contents.on("will-navigate", (event) => {
      if (!/^https?:/iu.test(event.url)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (!/^https?:/iu.test(event.url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    yield* Effect.tryPromise({
      try: () => contents.loadURL(url),
      catch: () => failure("load"),
    });
    yield* Effect.sleep(SETTLE_MS);
    const image = yield* Effect.tryPromise({
      try: () => contents.capturePage(),
      catch: () => failure("capture"),
    });
    return yield* Effect.try({
      try: () => {
        try {
          return scaled(image);
        } catch (error) {
          // An offscreen window can answer an empty capture; its last frame is the page.
          if (painted) return scaled(painted);
          throw error;
        }
      },
      catch: () => failure("capture"),
    });
  });

  /** Closes a window that a capture still has open. */
  close(): void {
    for (const window of this.#windows) if (!window.isDestroyed()) window.destroy();
    this.#windows.clear();
  }
}
