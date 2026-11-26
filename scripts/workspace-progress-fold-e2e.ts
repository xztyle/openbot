// Checks the fold of an agent's progress lines in a channel, on a computer and on an iPhone. It serves
// the web client on the long-history mock host with a run of progress lines in #historia
// (`src/renderer/stories/web-client-long-history-harness.tsx`, `?progress=1`) and drives it in
// Chromium. The steps: new progress lines at the end fold under "N more updates"; new lines that
// arrive while the reader reads above count on the "N new messages" button (a new line folds the row
// before it, which the count once lost, showing "Jump to latest"); a link to a folded line shows that
// line, lit.
//
// `bun scripts/workspace-progress-fold-e2e.ts [--viewport=desktop|phone] [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/workspace-progress-fold-e2e/report.json and screenshots.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("workspace-progress-fold-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/workspace-progress-fold-e2e");
const UI_WAIT_MS = 30_000;
const CHANNEL_PATH = "/app/general/c/historia";
const SCROLLER = ".ws-message-scroll";

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-long-history-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-progress-fold-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        if (!/^\/app(?:[/?]|$)/u.test(url)) return next();
        const html = await server.transformIndexHtml(url, HARNESS);
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      });
    },
  };
}

const report: {
  steps: { viewport: ViewportName; name: string; passed: boolean; detail?: string }[];
  pageErrors: string[];
  consoleErrors: string[];
  screenshots: string[];
  passed: boolean;
} = { steps: [], pageErrors: [], consoleErrors: [], screenshots: [], passed: false };

async function step(page: Page, viewport: ViewportName, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ viewport, name, passed: true });
  } catch (error) {
    report.steps.push({ viewport, name, passed: false, detail: String(error).slice(0, 1200) });
    const file = resolve(OUT, `${viewport}-${report.steps.length}-failed.png`);
    await page.screenshot({ path: file }).catch(() => undefined);
    report.screenshots.push(file);
  }
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

const frames = (page: Page, count = 3) =>
  page.evaluate(
    (n) =>
      new Promise<void>((done) => {
        let left = n;
        const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    count,
  );

/** Opens a page; the first open of a cold dev server can stall, so it tries again, as timeline-flow does. */
async function load(page: Page, origin: string, path: string): Promise<void> {
  const ready = (timeout: number) =>
    page.waitForFunction(() => (document.querySelector(".ws-timeline")?.children.length ?? 0) > 5, undefined, {
      timeout,
    });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${origin}${path}`, { waitUntil: "commit" });
    if (
      await ready(UI_WAIT_MS / 2).then(
        () => true,
        () => false,
      )
    )
      return frames(page, 6);
  }
  await ready(UI_WAIT_MS);
  await frames(page, 6);
}

const postProgress = (page: Page, count: number, gap: number) =>
  page.evaluate(`globalThis.openbotFlow.postProgress(${count}, ${gap})`);

async function toEnd(page: Page): Promise<void> {
  const jump = page.locator(".ws-jump-latest");
  if (await jump.isVisible().catch(() => false)) await jump.click();
  await page.evaluate((scroller) => {
    const element = document.querySelector(scroller);
    if (element) element.scrollTop = element.scrollHeight;
  }, SCROLLER);
  await frames(page, 8);
}

async function run(browser: Browser, origin: string, viewport: ViewportName): Promise<void> {
  const context = await browser.newContext({ ...VIEWPORTS[viewport] });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => report.pageErrors.push(`${viewport}: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
      report.consoleErrors.push(`${viewport}: ${message.text().slice(0, 1_000)}`);
  });

  await step(page, viewport, "new progress lines at the end fold under N more updates", async () => {
    await load(page, origin, `${CHANNEL_PATH}?progress=1`);
    await toEnd(page);
    await postProgress(page, 5, 80);
    await frames(page, 8);
    const fold = page.locator(`${SCROLLER} .ws-progress-fold-toggle`).last();
    await fold.waitFor({ timeout: UI_WAIT_MS });
    assert.equal((await fold.textContent())?.trim(), "3 more updates");
    // The newest line shows as its own row.
    await page.locator(`${SCROLLER} [data-row-key="historia-live-5"]`).waitFor({ timeout: UI_WAIT_MS });
  });
  await page.screenshot({ path: resolve(OUT, `${viewport}-1-folded.png`) });

  await step(page, viewport, "lines that arrive while the reader is above count on the button", async () => {
    await page.evaluate((scroller) => {
      const element = document.querySelector(scroller);
      if (element) element.scrollTop -= 1_500;
    }, SCROLLER);
    await frames(page, 8);
    const jump = page.locator(".ws-jump-latest");
    await jump.waitFor({ timeout: UI_WAIT_MS });
    await postProgress(page, 2, 150);
    await frames(page, 8);
    await page
      .waitForFunction(
        () => /2 new messages/u.test(document.querySelector(".ws-jump-latest")?.textContent ?? ""),
        undefined,
        {
          timeout: 5_000,
        },
      )
      .catch(async () => {
        throw new Error(`The button reads "${(await jump.textContent())?.trim()}", not "2 new messages".`);
      });
  });
  await page.screenshot({ path: resolve(OUT, `${viewport}-2-away.png`) });

  await step(page, viewport, "a link to a folded progress line shows it, lit", async () => {
    await load(page, origin, `${CHANNEL_PATH}/m/historia-step-4?progress=1`);
    const row = page.locator(`${SCROLLER} [data-row-key="historia-step-4"] .ws-message[data-highlighted]`);
    await row.waitFor({ timeout: 10_000 }).catch(() => {
      throw new Error("The linked progress line has no lit row of its own.");
    });
    await frames(page, 6);
    const inView = await row.evaluate((element, scroller) => {
      const view = document.querySelector(scroller)?.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return view ? box.bottom > view.top && box.top < view.bottom : false;
    }, SCROLLER);
    assert.ok(inView, "The linked progress line is not in view.");
  });
  await page.screenshot({ path: resolve(OUT, `${viewport}-3-link.png`) });
  await context.close();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  // A cache of its own: the deploy suite runs several scripts at once, and a server that
  // rebuilds a shared cache for its own entries pulls the modules from under the others.
  cacheDir: "node_modules/.vite-e2e/workspace-progress-fold-e2e",
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: ["src/renderer/stories/web-client-long-history-harness.tsx"],
    include: ["@norbert_bodziony/bloub"],
  },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${address.port}`;
let browser: Browser | null = null;

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  const viewports = option("viewport");
  if (!viewports || viewports === "desktop") await run(browser, origin, "desktop");
  if (!viewports || viewports === "phone") await run(browser, origin, "phone");
  report.passed =
    report.steps.length > 0 &&
    report.steps.every((item) => item.passed) &&
    report.pageErrors.length === 0 &&
    report.consoleErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps. Report: ${resolve(OUT, "report.json")}`,
);
process.exit(report.passed ? 0 : 1);
