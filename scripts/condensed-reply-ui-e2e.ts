// Checks in the web client that an agent answer that the host condensed shows once: the short text
// with "Condensed · Show original", the agent's own text after "Show original", never both. The
// script drives the mock host of `src/renderer/stories/web-client-needsyou-harness.tsx`: Chief's
// answer comes whole ("answer"), and a moment later the reply condenser replaces its text and keeps
// the original on the message ("condense"), as `AgentService.#applyCondensed` does.
//
// `bun scripts/condensed-reply-ui-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/condensed-reply-ui-e2e/report.json and a screenshot of each checked screen.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("condensed-reply-ui-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/condensed-reply-ui-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
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
    <script type="module" src="/src/renderer/stories/web-client-needsyou-harness.tsx"></script>
  </body>
</html>`;

/** Serves the harness page at `/app` and every address under it, as the site's `/app/$` route does. */
function webClientPages(): Plugin {
  return {
    name: "openbot-condensed-reply-harness",
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

interface Step {
  viewport: ViewportName;
  name: string;
  passed: boolean;
  detail?: string;
}

const report: {
  steps: Step[];
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
    report.steps.push({ viewport, name, passed: false, detail: String(error).slice(0, 800) });
    const shot = resolve(OUT, `${viewport}-${report.steps.length}-failed.png`);
    await page.screenshot({ path: shot }).catch(() => undefined);
    report.screenshots.push(shot);
  }
}

async function shot(page: Page, label: string): Promise<void> {
  const file = resolve(OUT, `${label}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(file);
}

/** The first load: Vite may still optimise the dependencies, so a blank page loads once more. */
async function load(page: Page, origin: string, path: string, ready: Locator): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${origin}${path}`, { waitUntil: "commit" });
    if (
      await ready.waitFor({ timeout: UI_WAIT_MS / 2 }).then(
        () => true,
        () => false,
      )
    )
      return;
  }
  await ready.waitFor({ timeout: UI_WAIT_MS });
}

const ORIGINAL_LINE = "So far I only read the account through the API.";
const CONDENSED_LINE = "Paused: no page and no cap yet.";

async function harness(page: Page, detail: "answer" | "condense"): Promise<void> {
  await page.waitForFunction(() => document.documentElement.dataset.needsYouReady !== undefined, null, {
    timeout: UI_WAIT_MS,
  });
  await page.evaluate((value) => window.dispatchEvent(new CustomEvent("needs-you-harness", { detail: value })), detail);
}

async function count(page: Page, text: string): Promise<number> {
  return page.locator(".conversation-scroll").getByText(text, { exact: false }).count();
}

async function condensed(browser: Browser, origin: string, viewport: ViewportName): Promise<void> {
  const context = await browser.newContext(VIEWPORTS[viewport]);
  const page = await context.newPage();
  watch(page, viewport);
  const tap = (target: Locator) => (viewport === "phone" ? target.tap() : target.click());

  await step(page, viewport, "the answer shows whole before the condenser", async () => {
    await load(page, origin, "/app/general/dm/chief", page.locator(".conversation-scroll").first());
    await harness(page, "answer");
    await page.locator(".conversation-scroll").getByText(ORIGINAL_LINE).first().waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-answer`);
  });

  await step(page, viewport, "the condensed answer replaces the original, which shows once", async () => {
    await harness(page, "condense");
    await page.locator(".conversation-scroll").getByText(CONDENSED_LINE).first().waitFor({ timeout: UI_WAIT_MS });
    await page
      .locator(".conversation-scroll")
      .getByText(ORIGINAL_LINE)
      .first()
      .waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await count(page, CONDENSED_LINE), 1, "The condensed text shows more than once.");
    await shot(page, `${viewport}-condensed`);
  });

  await step(page, viewport, "Show original shows only the agent's own text, and back", async () => {
    await tap(page.getByRole("button", { name: english("workspace.message.showOriginal") }).first());
    await page.locator(".conversation-scroll").getByText(ORIGINAL_LINE).first().waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await count(page, CONDENSED_LINE), 0, "The condensed text shows beside the original.");
    assert.equal(await count(page, ORIGINAL_LINE), 1, "The original shows more than once.");
    await shot(page, `${viewport}-original`);
    await tap(page.getByRole("button", { name: english("workspace.message.showCondensed") }).first());
    await page.locator(".conversation-scroll").getByText(CONDENSED_LINE).first().waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await count(page, ORIGINAL_LINE), 0, "The original stays beside the condensed text.");
  });

  await context.close();
}

function watch(page: Page, viewport: ViewportName): void {
  page.on("pageerror", (error) => report.pageErrors.push(`${viewport}: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource") &&
      !message.text().startsWith("[vite]")
    )
      report.consoleErrors.push(`${viewport}: ${message.text().slice(0, 1_000)}`);
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  // A cache of its own: the deploy suite runs several scripts at once, and a server that
  // rebuilds a shared cache for its own entries pulls the modules from under the others.
  cacheDir: "node_modules/.vite-e2e/condensed-reply-ui-e2e",
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: ["src/renderer/stories/web-client-needsyou-harness.tsx"],
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
  await condensed(browser, origin, "desktop");
  await condensed(browser, origin, "phone");
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
