// The browser client and the desktop app run the same UI. The desktop reaches its host through
// `window.openbot`, the preload; the browser has none, so shared code that reads it fails in the
// browser only (a Motion ticket's Approve said "could not send" on the phone for this reason).
// Shared code takes its calls from a port that both clients implement, such as `ChannelsPort`.
//
// This check walks every module the browser client imports, from `WebApp.tsx`, and counts the reads
// of `window.openbot` and the calls of the preload's port helpers (`conversationPort()` and the other
// functions that return `window.openbot`) in each. A module may not have more than the baseline in
// `scripts/web-preload-baseline.json`, which lists the desktop adapters and guarded reads that were
// there when the check came; the counts only go down.
//
// `bun scripts/check-web-preload.ts` checks. `--update` writes the baseline again, for a count that
// went down; raising one needs a reviewer to agree that the read can never run in the browser.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("check-web-preload");
const ROOT = resolve(import.meta.dirname, "..");
const ENTRY = resolve(ROOT, "src/renderer/src/features/web-client/WebApp.tsx");
const BASELINE = resolve(ROOT, "scripts/web-preload-baseline.json");
const ASSET = /\.(css|svg|png|md|woff2?|webp|jpe?g|mp3|wasm|json)$/u;

/** Every module of this checkout that the browser client imports, statically or lazily. */
function webModules(): string[] {
  const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
  const seen = new Set<string>();
  const queue = [ENTRY];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const transpiler = file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
    for (const entry of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (entry.path.includes("?") || ASSET.test(entry.path)) continue;
      let target: string;
      try {
        target = Bun.resolveSync(entry.path, dirname(file));
      } catch {
        continue;
      }
      const path = relative(ROOT, target);
      if (path.startsWith("..") || path.includes("node_modules") || !/\.(tsx?|mts)$/u.test(path)) continue;
      queue.push(target);
    }
  }
  return [...seen].map((file) => relative(ROOT, file)).filter((file) => !/\.(test|stories)\.tsx?$/u.test(file));
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === "node_modules") return [];
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.tsx?$/u.test(entry) ? [path] : [];
  });
}

/** The renderer's helpers that hand out the preload, such as `conversationPort()`. */
function preloadPorts(): string[] {
  const names = new Set<string>();
  const helper = /export function (\w+)\([^)]*\)[^{]*\{\s*(?:const \w+ = )?(?:return )?window\.openbot\b/gu;
  for (const file of filesUnder(resolve(ROOT, "src/renderer/src")))
    for (const match of readFileSync(file, "utf8").matchAll(helper)) if (match[1]) names.add(match[1]);
  return [...names].sort();
}

/** Code only: a comment that names the preload reads nothing. */
function code(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
    .map((line) => line.replace(/\/\/.*$/u, ""))
    .join("\n");
}

function count(source: string, ports: readonly string[]): number {
  const body = code(source);
  const reads = body.match(/window\.openbot\b/gu)?.length ?? 0;
  const calls = ports.reduce(
    (total, name) =>
      total +
      (body.match(new RegExp(`\\b${name}\\(`, "gu"))?.length ?? 0) -
      (body.match(new RegExp(`function ${name}\\(`, "gu"))?.length ?? 0),
    0,
  );
  return reads + calls;
}

const ports = preloadPorts();
const counts: Record<string, number> = {};
for (const file of webModules().sort()) {
  const total = count(readFileSync(resolve(ROOT, file), "utf8"), ports);
  if (total > 0) counts[file] = total;
}

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
  logger.info(`Wrote ${Object.keys(counts).length} modules to ${relative(ROOT, BASELINE)}.`);
  process.exit(0);
}

const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8"));
const failures = Object.entries(counts)
  .filter(([file, total]) => total > (baseline[file] ?? 0))
  .map(
    ([file, total]) =>
      `${file}: ${total} reads of the desktop preload (baseline ${baseline[file] ?? 0}). The browser client imports this module and has no window.openbot; take the call from a port both clients implement, such as ChannelsPort.`,
  );
const lowered = Object.entries(baseline).filter(([file, total]) => (counts[file] ?? 0) < total);
if (lowered.length > 0)
  logger.info(`${lowered.length} modules read the preload less than the baseline; run with --update to lower it.`);
if (failures.length > 0) {
  for (const failure of failures) logger.error(failure);
  process.exit(1);
}
logger.info(`The ${Object.keys(counts).length} browser modules that read the preload stay within the baseline.`);
