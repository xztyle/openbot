// Drives the browser client (the `web-client-harness.tsx` mock host) through every workspace view on a
// computer and on a phone, and records each read of `window.openbot`, the desktop's preload. The
// browser has no preload, so a read there is either a guard (`typeof window.openbot`) or a call that
// fails in the browser only. The report lists the reads that are not guards, with their source lines.
//
// `bun scripts/web-desktop-bridge-probe-e2e.ts [--headed]`
// Writes .openbot-build/web-desktop-bridge-probe/report.json. Exits 1 when an unguarded read is found.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

declare global {
  interface Window {
    /** The reads of `window.openbot` that the recorder saw, one caller frame each. */
    __bridgeReads?: string[];
  }
}

const logger = createOpenBotLogger("web-desktop-bridge-probe");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-desktop-bridge-probe");
const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-harness.tsx"></script>
  </body>
</html>`;

const VIEWS = [
  "today",
  "activity",
  "unreads",
  "threads",
  "later",
  "drafts",
  "fleet",
  "org",
  "agents",
  "space-agents",
  "artifacts",
  "between-agents",
  "insights",
  "knowledge",
  "loops",
  "money",
  "portfolio",
  "reviews",
  "routines",
  "schedule",
  "search",
  "secrets",
  "storage",
  "tasks",
  "trust",
  "usage",
  "settings",
  "server-settings",
  "c/general",
  "c/general/t/general-root",
  "dm/chief",
];

function webClientPages(): Plugin {
  return {
    name: "openbot-bridge-probe-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "/";
        if (url !== "/app" && !url.startsWith("/app/") && !url.startsWith("/app?")) return next();
        const html = await server.transformIndexHtml(url, HARNESS);
        response.setHeader("Content-Type", "text/html");
        response.end(html);
      });
    },
  };
}

/** Records each read of `window.openbot` with the first frame of the caller in the app's source. */
const RECORDER = () => {
  const reads: string[] = [];
  Object.defineProperty(window, "__bridgeReads", { value: reads });
  Object.defineProperty(window, "openbot", {
    configurable: true,
    get() {
      const frame = (new Error().stack ?? "")
        .split("\n")
        .slice(2)
        .find((line) => line.includes("/src/") || line.includes("/packages/"));
      if (frame) reads.push(frame.trim());
      return undefined;
    },
  });
};

type Read = { url: string; line: number; text: string; views: string[] };
const reads = new Map<string, Read>();

/** The frame's file and line, and the source line, read from the checkout. */
function source(frame: string): { url: string; line: number; text: string } | null {
  const match = /(?:https?:\/\/[^/]+)?(\/(?:src|packages)\/[^?:)]+)(?:\?[^:)]*)?:(\d+):\d+/u.exec(frame);
  if (!match?.[1] || !match[2]) return null;
  const file = match[1].slice(1);
  const line = Number(match[2]);
  let text = "";
  try {
    text = readFileSync(resolve(ROOT, file), "utf8").split("\n")[line - 1]?.trim() ?? "";
  } catch {
    // A virtual module of Vite.
  }
  return { url: file, line, text };
}

async function visit(page: Page, view: string, label: string): Promise<void> {
  // In-page navigation, as a link does: a reload of the dev server takes many seconds per view.
  await page.evaluate((path) => {
    history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/app/general/${view}`);
  await page.waitForTimeout(1_200);
  const frames = await page.evaluate(() => {
    const list = window.__bridgeReads ?? [];
    return list.splice(0, list.length);
  });
  for (const frame of frames) {
    const at = source(frame);
    if (!at) continue;
    const key = `${at.url}:${at.line}`;
    const entry = reads.get(key) ?? { ...at, views: [] };
    if (!entry.views.includes(label)) entry.views.push(label);
    reads.set(key, entry);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: { entries: ["src/renderer/stories/web-client-harness.tsx"], include: ["@norbert_bodziony/bloub"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
try {
  for (const [label, options] of [
    ["desktop", { viewport: { width: 1280, height: 800 } }],
    ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
  ] as const) {
    const context = await browser.newContext(options);
    await context.addInitScript(RECORDER);
    const page = await context.newPage();
    // The first load may wait for Vite to optimise the dependencies.
    await page.goto(`${origin}/app/general/today`, { waitUntil: "commit" });
    await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, null, {
      timeout: 120_000,
    });
    await page.waitForTimeout(3_000);
    if (label === "desktop") {
      // The recorder itself: a read through a port module must show in the report.
      const recorded = await page.evaluate(
        (portModule) =>
          import(portModule).then((module: { conversationPort: () => unknown }) => {
            const list = window.__bridgeReads ?? [];
            const before = list.length;
            try {
              module.conversationPort();
            } catch {
              // The read is what counts.
            }
            return list.splice(before, list.length - before).length;
          }),
        "/src/renderer/src/features/conversation/conversation-port.ts",
      );
      assert.ok(recorded > 0, "The recorder missed a read of window.openbot.");
    }
    for (const view of VIEWS) {
      await visit(page, view, `${label}:${view}`);
      logger.info(`${label}: ${view} (${reads.size} read sites so far)`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
const all = [...reads.values()].sort((a, b) => a.url.localeCompare(b.url) || a.line - b.line);
/** A read that only asks whether the preload exists is how shared code tells the desktop from the browser. */
const guard = (read: Read) =>
  /typeof window\.openbot|window\.openbot\s*(?:===|!==|==|!=)|"openbot" in window/u.test(read.text);
const unguarded = all.filter((read) => !guard(read));
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ unguarded, guards: all.filter(guard) }, null, 2)}\n`);
for (const read of unguarded)
  logger.info(`${read.url}:${read.line} ${read.text} [${read.views.slice(0, 4).join(", ")}]`);
logger.info(
  `${unguarded.length} unguarded reads of window.openbot in the browser client, ${all.length - unguarded.length} guards.`,
);
process.exit(unguarded.length === 0 ? 0 : 1);
