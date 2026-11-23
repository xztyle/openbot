// On a phone, a tap first acts as a hover. When the hover shows something, iOS Safari treats the tap
// as a hover only and drops its click, so the button needs a second tap. Two causes:
//
// - A mouse enter or over handler that shows something, such as a tooltip. A citation or a file chip
//   in a message needed two taps for this. This check refuses those handlers in the UI: use
//   `hoverHandlers()` of `@openbot/ui/utils`, which runs a hover for a mouse or a pen only.
// - A `:hover` style that shows an element: `display`, `visibility: visible` or `opacity` outside
//   `@media (hover: hover)`. A thread summary that swapped "Last reply" for "View thread" needed two
//   taps for this. Each CSS file may not have more of these rules than `scripts/hover-reveal-baseline.json`
//   lists, which holds the desktop-only rules that were there when the check came; the counts only go
//   down. Put a new one inside `@media (hover: hover)`, with a way to reach the control on a phone.
//
// `bun scripts/phone-tap-e2e.ts` checks the same in the running browser client at phone size.
//
// `bun scripts/check-hover-handlers.ts` checks. `--update` writes the baseline again, for a count that
// went down.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import postcss, { AtRule, type Node, type Rule } from "postcss";

const logger = createOpenBotLogger("check-hover-handlers");
const ROOT = resolve(import.meta.dirname, "..");
const BASELINE = resolve(ROOT, "scripts/hover-reveal-baseline.json");
const SOURCE_ROOTS = ["packages/ui/src", "src/renderer/src"];
/** Desktop-only surfaces that no phone shows: the dynamic island lives in its own desktop window. */
const HANDLER_ALLOWED = new Set([
  "packages/ui/src/dynamic-island.tsx",
  "src/renderer/src/features/dynamic-island/DynamicIslandSurface.tsx",
]);
const MOUSE_HANDLER = /\bon(?:MouseEnter|MouseOver)\s*=|addEventListener\(\s*["'](?:mouseenter|mouseover)["']/u;

function files(directory: string, pattern: RegExp, found: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) files(path, pattern, found);
    else if (pattern.test(name)) found.push(path);
  }
  return found;
}

/** True when the selector matches on hover: `:hover` outside `:not(...)`. */
function hovers(selector: string): boolean {
  return /:hover(?![\w-])/u.test(selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/gu, ""));
}

function behindHoverQuery(rule: Rule): boolean {
  for (let node: Node | undefined = rule.parent; node; node = node.parent)
    if (node instanceof AtRule && node.name === "media" && /\(\s*(any-)?hover\s*:\s*hover\s*\)/iu.test(node.params))
      return true;
  return false;
}

/** True when the declarations can make an element show. */
function reveals(rule: Rule): boolean {
  let shows = false;
  rule.walkDecls((declaration) => {
    const value = declaration.value.trim();
    if (declaration.prop === "display" && value !== "none") shows = true;
    if (declaration.prop === "visibility" && value === "visible") shows = true;
    if (declaration.prop === "opacity" && value !== "0") shows = true;
  });
  return shows;
}

const problems: string[] = [];
for (const file of SOURCE_ROOTS.flatMap((root) => files(resolve(ROOT, root), /\.tsx?$/u))) {
  const path = relative(ROOT, file);
  if (HANDLER_ALLOWED.has(path) || /\.(test|stories)\.tsx?$/u.test(path)) continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (MOUSE_HANDLER.test(line))
        problems.push(`${path}:${index + 1} has a mouse enter handler; use hoverHandlers() from @openbot/ui/utils.`);
    });
}

const counts: Record<string, number> = {};
const lines: Record<string, number[]> = {};
for (const file of ["packages", "src/renderer"].flatMap((root) => files(resolve(ROOT, root), /\.css$/u))) {
  const path = relative(ROOT, file);
  postcss.parse(readFileSync(file, "utf8"), { from: file }).walkRules((rule) => {
    if (!rule.selectors.some(hovers) || behindHoverQuery(rule) || !reveals(rule)) return;
    counts[path] = (counts[path] ?? 0) + 1;
    lines[path] = [...(lines[path] ?? []), rule.source?.start?.line ?? 0];
  });
}
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
  logger.info(`Wrote ${Object.keys(sorted).length} files to the baseline.`);
} else {
  const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8"));
  for (const [path, count] of Object.entries(counts))
    if (count > (baseline[path] ?? 0))
      problems.push(
        `${path} has ${count} :hover rules that show an element outside @media (hover: hover), the baseline ${baseline[path] ?? 0} (lines ${lines[path]?.join(", ")}).`,
      );
}
for (const problem of problems) logger.error(problem);
logger.info(`${problems.length} problems.`);
process.exit(problems.length === 0 ? 0 : 1);
