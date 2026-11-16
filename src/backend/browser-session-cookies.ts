import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { type Cookie, type CookiesSetDetails, type Session, safeStorage } from "electron";
import { isMissingFileError } from "./file-errors";

const logger = createOpenBotLogger("browser-session-cookies");

/** Saves wait for this much quiet, so a page that sets many cookies writes the file once. */
const SAVE_DELAY_MS = 3_000;
/** A saved sign-in older than this is not restored: the site would have ended it anyway. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface SavedCookies {
  version: 1;
  savedAt: number;
  cookies: Cookie[];
}

/**
 * Keeps the session-only cookies of the agent browser across restarts.
 *
 * Chromium writes only cookies with an expiry date to disk. Many sign-ins, such as Hotmart's, are
 * session cookies, so every OpenBot restart (a deploy, an update, a crash) signed the agents out of
 * those sites. A normal browser keeps them while it restores its last session, and so does this:
 * each persistent partition's session cookies are saved to a file next to its cookie store, and set
 * again before the partition's tabs load. The file is encrypted when the system offers encryption,
 * and readable only by this user, like the cookie store itself.
 *
 * A clear of the partition removes its cookies, which saves an empty file: nothing comes back.
 */
export class BrowserSessionCookies {
  readonly #folder: string;
  readonly #tracked = new Map<Session, { file: string; ready: Promise<void>; timer: NodeJS.Timeout | null }>();

  constructor(folder: string) {
    this.#folder = folder;
  }

  /** Restores the saved cookies of a partition and saves its session cookies from now on. */
  track(target: Session, partition: string): Promise<void> {
    const held = this.#tracked.get(target);
    if (held) return held.ready;
    const file = join(this.#folder, `${createHash("sha256").update(partition).digest("hex").slice(0, 32)}.json`);
    const entry: { file: string; ready: Promise<void>; timer: NodeJS.Timeout | null } = {
      file,
      ready: this.#restore(target, file),
      timer: null,
    };
    this.#tracked.set(target, entry);
    target.cookies.on("changed", (_event, cookie) => {
      if (!cookie.session) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void entry.ready.then(() => this.#save(target, file));
      }, SAVE_DELAY_MS);
      entry.timer.unref();
    });
    return entry.ready;
  }

  /** Saves every tracked partition now, for a shutdown. */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.#tracked].map(async ([target, entry]) => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        await entry.ready;
        await this.#save(target, entry.file);
      }),
    );
  }

  async #restore(target: Session, file: string): Promise<void> {
    try {
      const saved = decode(await readFile(file));
      if (!saved || Date.now() - saved.savedAt > MAX_AGE_MS) return;
      const present = new Set((await target.cookies.get({})).map(cookieKey));
      for (const cookie of saved.cookies) {
        if (present.has(cookieKey(cookie))) continue;
        await target.cookies.set(setDetails(cookie)).catch(() => undefined);
      }
    } catch (error) {
      if (!isMissingFileError(error))
        logger.warn("Unable to restore browser session cookies", { error: toLogValue(error) });
    }
  }

  async #save(target: Session, file: string): Promise<void> {
    try {
      const cookies = (await target.cookies.get({})).filter((cookie) => cookie.session);
      await mkdir(this.#folder, { recursive: true, mode: 0o700 });
      if (cookies.length === 0) {
        await rm(file, { force: true });
        return;
      }
      await writeFile(file, encode({ version: 1, savedAt: Date.now(), cookies }), { mode: 0o600 });
    } catch (error) {
      logger.warn("Unable to save browser session cookies", { error: toLogValue(error) });
    }
  }
}

function cookieKey(cookie: Pick<Cookie, "domain" | "path" | "name">): string {
  return `${cookie.domain ?? ""}\0${cookie.path ?? "/"}\0${cookie.name}`;
}

/** The details that set a cookie again as a session cookie: no expiry date. */
function setDetails(cookie: Cookie): CookiesSetDetails {
  const host = (cookie.domain ?? "").replace(/^\./, "");
  const details: CookiesSetDetails = {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path ?? "/",
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
  };
  // A host-only cookie must not name a domain, or it would become a domain cookie.
  if (!cookie.hostOnly && cookie.domain) details.domain = cookie.domain;
  if (cookie.sameSite && cookie.sameSite !== "unspecified") details.sameSite = cookie.sameSite;
  return details;
}

function encode(value: SavedCookies): Buffer {
  const text = JSON.stringify(value);
  return safeStorage.isEncryptionAvailable()
    ? Buffer.concat([Buffer.from("enc1:"), safeStorage.encryptString(text)])
    : Buffer.from(text);
}

function decode(raw: Buffer): SavedCookies | null {
  const encrypted = raw.subarray(0, 5).toString() === "enc1:";
  if (encrypted && !safeStorage.isEncryptionAvailable()) return null;
  const text = encrypted ? safeStorage.decryptString(raw.subarray(5)) : raw.toString("utf8");
  const value = JSON.parse(text);
  if (!isDynamicRecord(value) || value.version !== 1 || typeof value.savedAt !== "number") return null;
  if (!Array.isArray(value.cookies)) return null;
  const cookies: Cookie[] = value.cookies.filter(isSavedCookie);
  return { version: 1, savedAt: value.savedAt, cookies };
}

function isSavedCookie(value: unknown): value is Cookie {
  return isDynamicRecord(value) && typeof value.name === "string" && typeof value.value === "string";
}
