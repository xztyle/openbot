// Checks the files that the host makes from attachments for display (`src/main/file-renditions.ts`)
// with the real tools: LibreOffice turns a deck, a document and an old spreadsheet into a PDF or an
// XLSX, Poppler draws the first page, FFmpeg takes a video's first frame and an audio waveform, and a
// ZIP and a TAR.GZ list their files and give one back. A second run of the same file comes from the
// cache, keyed by the file's content.
//
// The tools are in the host image. On a computer without them, run it in the image:
// `sudo docker run --rm -v "$PWD:/wt" -v /opt/openbot/build-tools:/bt -w /wt --entrypoint /bt/bun <image> scripts/file-renditions-e2e.ts`
// `--out=<dir>` also writes every rendition there, as the web viewer e2e serves them.
// Writes .openbot-build/file-renditions-e2e/report.json.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { attachmentMimeTypeForName } from "@openbot/contracts/attachment-files";
import {
  type AttachmentRenditionKind,
  decodeArchiveListing,
  decodeAudioWaveform,
} from "@openbot/contracts/team-protocol/attachment-renditions-v1";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { FileRenditions } from "../src/main/file-renditions";

const logger = createOpenBotLogger("file-renditions-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = resolve(ROOT, "scripts/fixtures/file-previews");
const REPORT = resolve(ROOT, ".openbot-build/file-renditions-e2e");
const out = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);

const JPEG = [0xff, 0xd8, 0xff];
const PDF = [0x25, 0x50, 0x44, 0x46];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

interface Case {
  file: string;
  kind: AttachmentRenditionKind;
  path?: string;
  check: (bytes: Buffer) => void;
}

const starts = (magic: number[]) => (bytes: Buffer) =>
  assert.deepEqual([...bytes.subarray(0, magic.length)], magic, "the file does not start as its type does");
const listingHas = (paths: string[]) => (bytes: Buffer) => {
  const listing = decodeArchiveListing(JSON.parse(bytes.toString("utf8")));
  assert.ok(listing, "the listing does not decode");
  for (const path of paths)
    assert.ok(
      listing.entries.some((entry) => entry.path === path),
      `the listing has no ${path}`,
    );
};

const CASES: Case[] = [
  { file: "deck.pptx", kind: "thumbnail", check: starts(JPEG) },
  { file: "deck.pptx", kind: "document", check: starts(PDF) },
  { file: "report.docx", kind: "thumbnail", check: starts(JPEG) },
  { file: "report.docx", kind: "document", check: starts(PDF) },
  { file: "budget.xlsx", kind: "thumbnail", check: starts(JPEG) },
  { file: "budget.xlsx", kind: "sheet", check: starts(ZIP) },
  { file: "presupuesto.xls", kind: "sheet", check: starts(ZIP) },
  { file: "sample.pdf", kind: "thumbnail", check: starts(JPEG) },
  { file: "clip.mp4", kind: "thumbnail", check: starts(JPEG) },
  {
    file: "voice.mp3",
    kind: "waveform",
    check: (bytes) => {
      const waveform = decodeAudioWaveform(JSON.parse(bytes.toString("utf8")));
      assert.ok(waveform && waveform.peaks.length > 20 && waveform.duration > 3, "the waveform is empty");
    },
  },
  {
    file: "proyecto.zip",
    kind: "archive",
    check: listingHas(["proyecto/README.md", "proyecto/datos/ventas.csv", "proyecto/docs/contrato.pdf"]),
  },
  {
    file: "proyecto.zip",
    kind: "entry",
    path: "proyecto/src/app.ts",
    check: (bytes) => assert.match(bytes.toString("utf8"), /Hola/u),
  },
  { file: "proyecto.zip", kind: "entry", path: "proyecto/docs/contrato.pdf", check: starts(PDF) },
  { file: "codigo.tar.gz", kind: "archive", check: listingHas(["codigo/main.py"]) },
  {
    file: "codigo.tar.gz",
    kind: "entry",
    path: "codigo/main.py",
    check: (bytes) => assert.match(bytes.toString("utf8"), /hola/u),
  },
];

const work = await mkdtemp(join(tmpdir(), "file-renditions-e2e-"));
const results: { file: string; kind: string; path?: string; bytes: number; ms: number; cachedMs: number }[] = [];
try {
  const renditions = new FileRenditions(join(work, "cache"));
  // Copies, so the cache key is the content and not the fixture path.
  for (const test of CASES) {
    const source = join(work, test.file);
    await copyFile(join(FIXTURES, test.file), source).catch(() => undefined);
    const input = { path: source, name: test.file, mimeType: attachmentMimeTypeForName(test.file) };
    const started = performance.now();
    const made = await Effect.runPromise(renditions.render(input, test.kind, test.path));
    const ms = Math.round(performance.now() - started);
    assert.ok(made, `${test.file} has no ${test.kind}${test.path ? ` ${test.path}` : ""}`);
    const bytes = await readFile(made.path);
    test.check(bytes);
    const again = performance.now();
    const cached = await Effect.runPromise(renditions.render(input, test.kind, test.path));
    const cachedMs = Math.round(performance.now() - again);
    assert.equal(cached?.path, made.path, "a second view does not come from the cache");
    results.push({
      file: test.file,
      kind: test.kind,
      ...(test.path ? { path: test.path } : {}),
      bytes: bytes.length,
      ms,
      cachedMs,
    });
    if (out) {
      await mkdir(out, { recursive: true });
      const name = `${test.file}.${test.kind}${test.path ? `.${test.path.replaceAll("/", "_")}` : ""}`;
      await writeFile(join(out, name), bytes);
    }
  }
  // A file that is gone answers null, not an error.
  const none = await Effect.runPromise(
    renditions.render(
      { path: join(work, "gone.pptx"), name: "gone.pptx", mimeType: attachmentMimeTypeForName("gone.pptx") },
      "document",
    ),
  );
  assert.equal(none, null, "a missing deck has a PDF");
  // An entry the listing does not name is refused, so no path reaches the tools.
  const outside = await Effect.runPromise(
    renditions.render(
      { path: join(work, "proyecto.zip"), name: "proyecto.zip", mimeType: "application/zip" },
      "entry",
      "../../etc/passwd",
    ),
  );
  assert.equal(outside, null, "an entry outside the listing was read");
  await mkdir(REPORT, { recursive: true });
  await writeFile(join(REPORT, "report.json"), `${JSON.stringify({ ok: true, results }, null, 2)}\n`);
  logger.info(`Passed: ${results.length} renditions. Report: ${join(REPORT, "report.json")}`);
  assert.ok((await stat(join(REPORT, "report.json"))).isFile());
} finally {
  await rm(work, { recursive: true, force: true });
}
