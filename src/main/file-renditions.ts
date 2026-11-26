import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflateRaw } from "node:zlib";
import { attachmentFileExtension } from "@openbot/contracts/attachment-files";
import { fileViewKind } from "@openbot/contracts/file-view-kind";
import {
  ARCHIVE_ENTRY_BYTES,
  ARCHIVE_LISTING_LIMIT,
  type ArchiveListing,
  type ArchiveListingEntry,
  type AttachmentRenditionKind,
  decodeArchiveListing,
} from "@openbot/contracts/team-protocol/attachment-renditions-v1";
import { Effect, Semaphore } from "effect";

// Files that the host makes from an attachment, for display: a thumbnail of the first page, slide or
// video frame, a PDF of an Office document, an XLSX copy of an older spreadsheet, the waveform of an
// audio file, and the listing and entries of an archive.
//
// Everything runs on this computer with LibreOffice, Poppler and FFmpeg when they are installed; a
// tool that is missing makes its renditions answer `null`, and the client shows the plain file card.
// The results are kept on disk under the SHA-256 of the file's bytes, so the same file sent twice is
// converted once. The original never leaves this computer for a rendition.

/** The width of a thumbnail. A chat card shows it at 240 CSS pixels, sharp on a 2x screen. */
const THUMBNAIL_WIDTH = 480;
/** LibreOffice takes long for a large deck. A stuck conversion is stopped. */
const OFFICE_TIMEOUT_MS = 180_000;
const TOOL_TIMEOUT_MS = 60_000;
/** The largest original the host converts. A larger one shows as a plain card. */
const SOURCE_LIMIT_BYTES = 512 * 1024 * 1024;
/** The disk the renditions may use. The least recently used go first. */
const CACHE_BYTES = 4 * 1024 * 1024 * 1024;
const WAVEFORM_PEAKS = 120;

export interface RenditionSource {
  path: string;
  name: string;
  mimeType: string;
}

export interface RenditionFile {
  path: string;
  mimeType: string;
  name: string;
}

interface Tools {
  soffice: string | null;
  pdftoppm: string | null;
  ffmpeg: string | null;
  tar: string | null;
}

export class FileRenditions {
  readonly #directory: string;
  /** LibreOffice runs one conversion per profile at a time. */
  readonly #officeLock = Semaphore.makeUnsafe(1);
  readonly #toolLock = Semaphore.makeUnsafe(2);
  readonly #pending = new Map<string, Promise<RenditionFile | null>>();
  /** The content hash of a file, by its path, size and change time. */
  readonly #hashes = new Map<string, string>();
  #found: Tools | null = null;
  #writes = 0;

  constructor(directory: string) {
    this.#directory = directory;
  }

  /** The rendition, or `null` when the host cannot make it for this file. */
  readonly render = Effect.fn("FileRenditions.render")(function* (
    this: FileRenditions,
    source: RenditionSource,
    kind: AttachmentRenditionKind,
    entryPath?: string,
  ): Effect.fn.Return<RenditionFile | null> {
    return yield* Effect.promise(() => this.#render(source, kind, entryPath).catch(() => null));
  }).bind(this);

  async #render(source: RenditionSource, kind: AttachmentRenditionKind, entryPath?: string) {
    const info = await stat(source.path).catch(() => null);
    if (!info?.isFile() || info.size > SOURCE_LIMIT_BYTES) return null;
    const view = fileViewKind(source.name, source.mimeType);
    if (!supports(view, kind)) return null;
    const hash = await this.#hash(source.path, info.size, info.mtimeMs);
    const key = `${hash}:${kind}:${entryPath ?? ""}`;
    let job = this.#pending.get(key);
    if (!job) {
      job = this.#make(source, view, kind, hash, entryPath).catch(() => null);
      this.#pending.set(key, job);
      void job.finally(() => this.#pending.delete(key));
    }
    return job;
  }

  async #hash(path: string, size: number, modified: number): Promise<string> {
    const stamp = `${path}\0${size}\0${modified}`;
    const known = this.#hashes.get(stamp);
    if (known) return known;
    const digest = createHash("sha256");
    await pipeline(createReadStream(path), digest);
    const hash = digest.digest("hex").slice(0, 40);
    if (this.#hashes.size > 5_000) this.#hashes.clear();
    this.#hashes.set(stamp, hash);
    return hash;
  }

  async #make(
    source: RenditionSource,
    view: ReturnType<typeof fileViewKind>,
    kind: AttachmentRenditionKind,
    hash: string,
    entryPath: string | undefined,
  ): Promise<RenditionFile | null> {
    const folder = join(this.#directory, hash.slice(0, 2), hash);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const base = source.name.replace(/\.[^.]+$/u, "") || "file";
    switch (kind) {
      case "document": {
        if (view === "pdf") return { path: source.path, mimeType: "application/pdf", name: source.name };
        const path = await this.#cached(join(folder, "document.pdf"), (target) => this.#office(source, "pdf", target));
        return path ? { path, mimeType: "application/pdf", name: `${base}.pdf` } : null;
      }
      case "sheet": {
        if (attachmentFileExtension(source.name) === "xlsx")
          return { path: source.path, mimeType: "application/octet-stream", name: source.name };
        const path = await this.#cached(join(folder, "sheet.xlsx"), (target) => this.#office(source, "xlsx", target));
        return path ? { path, mimeType: "application/octet-stream", name: `${base}.xlsx` } : null;
      }
      case "thumbnail": {
        const path = await this.#cached(join(folder, "thumbnail.jpg"), async (target) => {
          if (view === "video") return this.#videoFrame(source.path, target);
          const pdf =
            view === "pdf"
              ? source.path
              : await this.#cached(join(folder, "document.pdf"), (pdfTarget) => this.#office(source, "pdf", pdfTarget));
          if (!pdf) return this.#tool("soffice") ? false : null;
          return this.#pdfPage(pdf, target);
        });
        return path ? { path, mimeType: "image/jpeg", name: `${base}.jpg` } : null;
      }
      case "waveform": {
        const path = await this.#cached(join(folder, "waveform.json"), (target) => this.#waveform(source.path, target));
        return path ? { path, mimeType: "application/json", name: `${base}.json` } : null;
      }
      case "archive": {
        const path = await this.#cached(join(folder, "archive.json"), async (target) => {
          const listing = await this.#listArchive(source);
          if (!listing) return false;
          await writeAtomically(target, JSON.stringify(listing));
          return true;
        });
        return path ? { path, mimeType: "application/json", name: `${base}.json` } : null;
      }
      case "entry": {
        if (!entryPath || entryPath.endsWith("/")) return null;
        const listing = await this.#render(source, "archive");
        if (!listing) return null;
        const entries = decodeArchiveListing(JSON.parse(await readFile(listing.path, "utf8")))?.entries ?? [];
        // Only a path the listing names: nothing from the request reaches a command as a pattern.
        const entry = entries.find((candidate) => candidate.path === entryPath && !candidate.directory);
        if (!entry || entry.size > ARCHIVE_ENTRY_BYTES) return null;
        const name = entryPath.split("/").filter(Boolean).at(-1) ?? "file";
        const digest = createHash("sha256").update(entryPath).digest("hex").slice(0, 32);
        const path = await this.#cached(join(folder, `entry-${digest}`), (target) =>
          this.#extract(source, entry, target),
        );
        return path ? { path, mimeType: "application/octet-stream", name } : null;
      }
    }
  }

  /**
   * The cached file, made by `make` when it is missing. `make` resolves false when it cannot, and
   * null when the tool it needs is not installed: that is not recorded as a failure.
   */
  async #cached(target: string, make: (target: string) => Promise<boolean | null>): Promise<string | null> {
    const existing = await stat(target).catch(() => null);
    if (existing?.isFile() && existing.size > 0) {
      const now = new Date();
      void utimes(target, now, now).catch(() => undefined);
      return target;
    }
    const failed = `${target}.failed`;
    // A file that failed once fails again: it is not tried on every view.
    if (
      await stat(failed).then(
        (info) => Date.now() - info.mtimeMs < 24 * 3_600_000,
        () => false,
      )
    )
      return null;
    const made = await make(target).catch(() => false);
    if (made === null) return null;
    if (!made) {
      await writeFile(failed, "").catch(() => undefined);
      return null;
    }
    if (++this.#writes % 25 === 1) void this.#prune();
    return target;
  }

  #tool(name: keyof Tools): string | null {
    this.#found ??= findTools();
    return this.#found[name];
  }

  /** Converts an Office file with LibreOffice into `format` (pdf or xlsx). */
  async #office(source: RenditionSource, format: "pdf" | "xlsx", target: string): Promise<boolean | null> {
    const soffice = this.#tool("soffice");
    if (!soffice) return null;
    return Effect.runPromise(
      this.#officeLock.withPermit(
        Effect.promise(async () => {
          const work = await mkdtemp(join(this.#directory, "tmp-"));
          try {
            // A plain name: the original name can hold anything, and LibreOffice reads the type from it.
            const extension = attachmentFileExtension(source.name) ?? "bin";
            const input = join(work, `input.${extension}`);
            await copyFile(source.path, input);
            const profile = `file://${join(this.#directory, "libreoffice-profile")}`;
            const ok = await run(
              soffice,
              [
                `-env:UserInstallation=${profile}`,
                "--headless",
                "--invisible",
                "--norestore",
                "--nologo",
                "--nodefault",
                "--nolockcheck",
                "--convert-to",
                format,
                "--outdir",
                work,
                input,
              ],
              OFFICE_TIMEOUT_MS,
              { HOME: work },
            );
            const output = join(work, `input.${format}`);
            const made = await stat(output).catch(() => null);
            if (!ok || !made?.isFile() || made.size === 0) return false;
            await rename(output, target).catch(async () => {
              await copyFile(output, target);
            });
            return true;
          } finally {
            await rm(work, { recursive: true, force: true }).catch(() => undefined);
          }
        }),
      ),
    );
  }

  async #pdfPage(pdf: string, target: string): Promise<boolean | null> {
    const pdftoppm = this.#tool("pdftoppm");
    if (!pdftoppm) return null;
    return this.#withTool(async () => {
      const prefix = `${target}.${process.pid}`;
      const ok = await run(
        pdftoppm,
        [
          "-jpeg",
          "-jpegopt",
          "quality=82",
          "-f",
          "1",
          "-l",
          "1",
          "-scale-to-x",
          String(THUMBNAIL_WIDTH),
          "-scale-to-y",
          "-1",
          "-singlefile",
          pdf,
          prefix,
        ],
        TOOL_TIMEOUT_MS,
      );
      return ok && (await moveIfMade(`${prefix}.jpg`, target));
    });
  }

  async #videoFrame(video: string, target: string): Promise<boolean | null> {
    const ffmpeg = this.#tool("ffmpeg");
    if (!ffmpeg) return null;
    return this.#withTool(async () => {
      const partial = `${target}.${process.pid}.jpg`;
      // One second in skips a black first frame; a shorter clip takes its first frame.
      for (const at of ["1", "0"]) {
        const ok = await run(
          ffmpeg,
          [
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-ss",
            at,
            "-i",
            video,
            "-frames:v",
            "1",
            "-vf",
            `scale='min(${THUMBNAIL_WIDTH},iw)':-2`,
            "-q:v",
            "4",
            partial,
          ],
          TOOL_TIMEOUT_MS,
        );
        if (ok && (await moveIfMade(partial, target))) return true;
      }
      return false;
    });
  }

  async #waveform(audio: string, target: string): Promise<boolean | null> {
    const ffmpeg = this.#tool("ffmpeg");
    if (!ffmpeg) return null;
    return this.#withTool(async () => {
      const rate = 2_000;
      const samples: number[] = [];
      // Mono 16-bit samples at a low rate: enough for the shape, small enough for a long file.
      const ok = await run(
        ffmpeg,
        ["-nostdin", "-v", "error", "-i", audio, "-t", "3600", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"],
        TOOL_TIMEOUT_MS,
        {},
        (chunk) => {
          for (let index = 0; index + 1 < chunk.length; index += 2) samples.push(Math.abs(chunk.readInt16LE(index)));
        },
      );
      if (!ok || samples.length === 0) return false;
      const bucket = Math.max(1, Math.floor(samples.length / WAVEFORM_PEAKS));
      const peaks: number[] = [];
      for (let start = 0; start < samples.length && peaks.length < WAVEFORM_PEAKS; start += bucket) {
        let peak = 0;
        for (let index = start; index < Math.min(samples.length, start + bucket); index++)
          peak = Math.max(peak, samples[index] ?? 0);
        peaks.push(peak / 32_768);
      }
      const loudest = Math.max(...peaks, 0.01);
      await writeAtomically(
        target,
        JSON.stringify({
          peaks: peaks.map((peak) => Math.round((peak / loudest) * 1000) / 1000),
          duration: samples.length / rate,
        }),
      );
      return true;
    });
  }

  async #listArchive(source: RenditionSource): Promise<ArchiveListing | null> {
    const extension = attachmentFileExtension(source.name);
    if (extension === "zip" || source.mimeType === "application/zip") return listZip(source.path);
    const tar = this.#tool("tar");
    if (!tar) return null;
    const lines: string[] = [];
    let rest = "";
    const ok = await run(
      tar,
      ["-tvf", source.path, "--quoting-style=literal"],
      TOOL_TIMEOUT_MS,
      { LC_ALL: "C" },
      (chunk) => {
        const text = rest + chunk.toString("utf8");
        const parts = text.split("\n");
        rest = parts.pop() ?? "";
        if (lines.length <= ARCHIVE_LISTING_LIMIT) lines.push(...parts);
      },
    );
    if (rest) lines.push(rest);
    if (ok) {
      const entries: ArchiveListingEntry[] = [];
      for (const line of lines) {
        // `-rw-r--r-- user/group  1234 2026-01-01 12:00 path`
        const match = /^([dl-])\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s(.+)$/u.exec(line);
        if (!match?.[3]) continue;
        const directory = match[1] === "d";
        const path = match[1] === "l" ? (match[3].split(" -> ")[0] ?? match[3]) : match[3];
        if (match[1] === "l") continue;
        entries.push({ path: normalizeEntry(path, directory), size: Number(match[2]), directory });
      }
      return finishListing(entries);
    }
    // A `.gz` that is not a TAR holds one file.
    if (extension === "gz") {
      const inner = source.name.replace(/\.gz$/iu, "") || "file";
      return { entries: [{ path: inner, size: 0, directory: false }], truncated: false };
    }
    return null;
  }

  async #extract(source: RenditionSource, entry: ArchiveListingEntry, target: string): Promise<boolean> {
    const extension = attachmentFileExtension(source.name);
    if (extension === "zip" || source.mimeType === "application/zip")
      return extractZip(source.path, entry.path, target);
    const partial = `${target}.${process.pid}.part`;
    const tar = this.#tool("tar");
    const output = createWriteStream(partial, { mode: 0o600 });
    let written = 0;
    let tooLarge = false;
    const write = (chunk: Buffer) => {
      written += chunk.length;
      if (written > ARCHIVE_ENTRY_BYTES) tooLarge = true;
      else output.write(chunk);
    };
    let ok = false;
    const single = source.name.replace(/\.gz$/iu, "");
    if (extension === "gz" && entry.path === single) {
      ok = await pipeline(createReadStream(source.path), createGunzip(), async (chunks: AsyncIterable<Buffer>) => {
        for await (const chunk of chunks) write(chunk);
      }).then(
        () => true,
        () => false,
      );
    } else if (tar) {
      ok = await run(tar, ["-xOf", source.path, "--no-wildcards", "--", entry.path], TOOL_TIMEOUT_MS, {}, write);
    }
    await new Promise<void>((resolve) => output.end(resolve));
    if (!ok || tooLarge) {
      await rm(partial, { force: true });
      return false;
    }
    return moveIfMade(partial, target, true);
  }

  #withTool(job: () => Promise<boolean>): Promise<boolean> {
    return Effect.runPromise(this.#toolLock.withPermit(Effect.promise(job)));
  }

  /** Keeps the cache under its byte budget. A removed rendition is made again on its next view. */
  async #prune(): Promise<void> {
    try {
      const folders: { path: string; at: number; bytes: number }[] = [];
      for (const shard of await readdir(this.#directory)) {
        if (shard.length !== 2) continue;
        for (const hash of await readdir(join(this.#directory, shard))) {
          const path = join(this.#directory, shard, hash);
          let bytes = 0;
          let at = 0;
          for (const name of await readdir(path)) {
            const info = await stat(join(path, name)).catch(() => null);
            if (!info) continue;
            bytes += info.size;
            at = Math.max(at, info.mtimeMs);
          }
          folders.push({ path, at, bytes });
        }
      }
      let total = folders.reduce((sum, folder) => sum + folder.bytes, 0);
      folders.sort((left, right) => left.at - right.at);
      for (const folder of folders) {
        if (total <= CACHE_BYTES) break;
        await rm(folder.path, { recursive: true, force: true });
        total -= folder.bytes;
      }
    } catch {
      // A rendition that stays is only disk space.
    }
  }
}

function supports(view: ReturnType<typeof fileViewKind>, kind: AttachmentRenditionKind): boolean {
  switch (kind) {
    case "thumbnail":
      return view === "pdf" || view === "video" || view === "slides" || view === "document" || view === "sheet";
    case "document":
      return view === "pdf" || view === "slides" || view === "document" || view === "sheet";
    case "sheet":
      return view === "sheet";
    case "waveform":
      return view === "audio";
    case "archive":
    case "entry":
      return view === "archive";
  }
}

function findTools(): Tools {
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  directories.push("/usr/bin", "/usr/local/bin", "/opt/libreoffice/program", "/usr/lib/libreoffice/program");
  const find = (...names: string[]) => {
    for (const name of names)
      for (const directory of directories) {
        const candidate = join(directory, name);
        try {
          accessSync(candidate, constants.X_OK);
          return candidate;
        } catch {
          // Not here.
        }
      }
    return null;
  };
  return {
    soffice: find("soffice", "libreoffice"),
    pdftoppm: find("pdftoppm"),
    ffmpeg: find("ffmpeg"),
    tar: find("tar"),
  };
}

/** Runs a tool with no shell and no input. Resolves whether it exited with 0 before the deadline. */
function run(
  command: string,
  args: string[],
  timeoutMs: number,
  environment: Record<string, string> = {},
  onOutput?: (chunk: Buffer) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", onOutput ? "pipe" : "ignore", "ignore"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", ...environment },
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    if (onOutput) child.stdout?.on("data", (chunk: Buffer) => onOutput(chunk));
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function moveIfMade(from: string, to: string, allowEmpty = false): Promise<boolean> {
  const made = await stat(from).catch(() => null);
  if (!made?.isFile() || (!allowEmpty && made.size === 0)) {
    await rm(from, { force: true }).catch(() => undefined);
    return false;
  }
  await rename(from, to);
  return true;
}

async function writeAtomically(target: string, text: string): Promise<void> {
  const partial = `${target}.${process.pid}.part`;
  await writeFile(partial, text, { mode: 0o600 });
  await rename(partial, target);
}

/** The path as the archive names it, so an entry can be read back by it. A folder ends with `/`. */
function normalizeEntry(path: string, directory: boolean): string {
  return directory && !path.endsWith("/") ? `${path}/` : path;
}

function finishListing(entries: ArchiveListingEntry[]): ArchiveListing {
  const kept = entries.filter((entry) => entry.path && entry.path !== "/");
  return { entries: kept.slice(0, ARCHIVE_LISTING_LIMIT), truncated: kept.length > ARCHIVE_LISTING_LIMIT };
}

// ZIP: the central directory at the end of the file names every entry; one entry is read from its
// local header. Only stored and deflated entries are read, which is what every common tool writes.

interface ZipEntry extends ArchiveListingEntry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

async function readZipDirectory(path: string): Promise<ZipEntry[] | null> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const tail = Math.min(size, 65_557);
    const end = Buffer.alloc(tail);
    await file.read(end, 0, tail, size - tail);
    let at = -1;
    for (let index = tail - 22; index >= 0; index--)
      if (end.readUInt32LE(index) === 0x06054b50) {
        at = index;
        break;
      }
    if (at < 0) return null;
    let count = end.readUInt16LE(at + 10);
    let directorySize = end.readUInt32LE(at + 12);
    let directoryOffset = end.readUInt32LE(at + 16);
    // ZIP64: the end record points at a larger one.
    if (directoryOffset === 0xffffffff && at >= 20 && end.readUInt32LE(at - 20) === 0x07064b50) {
      const recordAt = Number(end.readBigUInt64LE(at - 20 + 8));
      const record = Buffer.alloc(56);
      await file.read(record, 0, 56, recordAt);
      if (record.readUInt32LE(0) === 0x06064b50) {
        count = Number(record.readBigUInt64LE(32));
        directorySize = Number(record.readBigUInt64LE(40));
        directoryOffset = Number(record.readBigUInt64LE(48));
      }
    }
    if (directorySize > 64 * 1024 * 1024) return null;
    const directory = Buffer.alloc(directorySize);
    await file.read(directory, 0, directorySize, directoryOffset);
    const entries: ZipEntry[] = [];
    let offset = 0;
    for (let index = 0; index < count && offset + 46 <= directory.length; index++) {
      if (directory.readUInt32LE(offset) !== 0x02014b50) break;
      const flags = directory.readUInt16LE(offset + 8);
      const method = directory.readUInt16LE(offset + 10);
      let compressedSize = directory.readUInt32LE(offset + 20);
      let uncompressed = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      let localOffset = directory.readUInt32LE(offset + 42);
      const nameBytes = directory.subarray(offset + 46, offset + 46 + nameLength);
      const name = (flags & 0x800) !== 0 ? nameBytes.toString("utf8") : nameBytes.toString("latin1");
      // ZIP64 sizes and offset sit in the extra field.
      let extra = offset + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = directory.readUInt16LE(extra);
        const length = directory.readUInt16LE(extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          if (uncompressed === 0xffffffff) {
            uncompressed = Number(directory.readBigUInt64LE(field));
            field += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(directory.readBigUInt64LE(field));
            field += 8;
          }
          if (localOffset === 0xffffffff) localOffset = Number(directory.readBigUInt64LE(field));
        }
        extra += 4 + length;
      }
      offset = extraEnd + commentLength;
      const directoryEntry = name.endsWith("/");
      if (name.startsWith("__MACOSX/") || name.split("/").some((part) => part === "..")) continue;
      entries.push({
        path: normalizeEntry(name, directoryEntry),
        size: uncompressed,
        directory: directoryEntry,
        method,
        compressedSize,
        localOffset,
      });
    }
    return entries;
  } finally {
    await file.close();
  }
}

async function listZip(path: string): Promise<ArchiveListing | null> {
  const entries = await readZipDirectory(path);
  if (!entries) return null;
  return finishListing(entries.map(({ path: entryPath, size, directory }) => ({ path: entryPath, size, directory })));
}

async function extractZip(path: string, entryPath: string, target: string): Promise<boolean> {
  const entries = await readZipDirectory(path);
  const entry = entries?.find((candidate) => candidate.path === entryPath);
  if (!entry || entry.size > ARCHIVE_ENTRY_BYTES || (entry.method !== 0 && entry.method !== 8)) return false;
  const file = await open(path, "r");
  let start: number;
  try {
    const header = Buffer.alloc(30);
    await file.read(header, 0, 30, entry.localOffset);
    if (header.readUInt32LE(0) !== 0x04034b50) return false;
    start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await file.close();
  }
  const partial = `${target}.${process.pid}.part`;
  if (entry.compressedSize === 0) {
    await writeFile(partial, "", { mode: 0o600 });
    return moveIfMade(partial, target, true);
  }
  const input = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
  let written = 0;
  const limit = async function* (chunks: AsyncIterable<Buffer>) {
    for await (const chunk of chunks) {
      written += chunk.length;
      if (written > ARCHIVE_ENTRY_BYTES) throw new Error("The entry is too large.");
      yield chunk;
    }
  };
  const ok = await (entry.method === 8
    ? pipeline(input, createInflateRaw(), limit, createWriteStream(partial, { mode: 0o600 }))
    : pipeline(input, limit, createWriteStream(partial, { mode: 0o600 }))
  ).then(
    () => true,
    () => false,
  );
  if (!ok) {
    await rm(partial, { force: true });
    return false;
  }
  return moveIfMade(partial, target, true);
}
