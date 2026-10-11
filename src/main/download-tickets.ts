import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How long a download link works. A resumed or ranged download needs several requests inside it. */
export const DOWNLOAD_TICKET_LIFETIME_MS = 15 * 60_000;
const KEY_BYTES = 32;
const MAXIMUM_URL_LENGTH = 2048;
/** `https://host` or `https://host:port`, with no path. The download host is the operator's own name. */
const BASE_URL = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/u;

export interface DownloadTicketFile {
  /** The path in this process, which the download host maps to its own view of the data folder. */
  path: string;
  /** The name the browser saves the file under. */
  name: string;
}

export interface DownloadTicketOptions {
  /** A file of 32 random bytes, made on first use and readable only by this user. */
  keyPath: string;
  /** A file with the https address of the download host. Without it there is no ticket. */
  baseUrlPath: string;
  now?: () => number;
}

/**
 * Signed, short-lived links to one file each, for a download host that streams files over https.
 *
 * The host process authorizes the member and resolves the file; the download host trusts only a
 * ticket with a valid signature, so it can never serve a path that this process did not name. The
 * token is `base64url(payload).base64url(HMAC-SHA256(key, base64url(payload)))`, and the download
 * host in `scripts/download-gateway` checks it with the same key file. Keep both in step.
 */
export class DownloadTickets {
  readonly #options: DownloadTicketOptions;
  #key: Buffer | null = null;

  constructor(options: DownloadTicketOptions) {
    this.#options = options;
  }

  /** `null` when there is no download address, or the link would be too long: the client falls back. */
  mint(file: DownloadTicketFile): { url: string; expiresAt: number } | null {
    const base = this.#baseUrl();
    if (!base) return null;
    const expiresAt = (this.#options.now?.() ?? Date.now()) + DOWNLOAD_TICKET_LIFETIME_MS;
    const payload = Buffer.from(JSON.stringify({ v: 1, p: file.path, n: file.name, e: expiresAt })).toString(
      "base64url",
    );
    const signature = createHmac("sha256", this.#signingKey()).update(payload).digest("base64url");
    const url = `${base}/d/${payload}.${signature}`;
    return url.length > MAXIMUM_URL_LENGTH ? null : { url, expiresAt };
  }

  #baseUrl(): string | null {
    try {
      const text = readFileSync(this.#options.baseUrlPath, "utf8").trim();
      return BASE_URL.test(text) ? text : null;
    } catch {
      return null;
    }
  }

  #signingKey(): Buffer {
    if (this.#key) return this.#key;
    const read = (): Buffer | null => {
      try {
        const key = readFileSync(this.#options.keyPath);
        return key.length >= KEY_BYTES ? key : null;
      } catch {
        return null;
      }
    };
    let key = read();
    if (!key) {
      mkdirSync(dirname(this.#options.keyPath), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(this.#options.keyPath, randomBytes(KEY_BYTES), { flag: "wx", mode: 0o600 });
      } catch {
        // Another start made it first, or a short file is in the way: read what is there.
      }
      key = read();
    }
    if (!key) throw new Error("The download ticket key is unavailable.");
    this.#key = key;
    return key;
  }
}
