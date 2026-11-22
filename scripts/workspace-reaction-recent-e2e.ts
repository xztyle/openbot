// Checks that a reaction's emoji stays first in the reader's recent emoji after a reload. It serves
// the web client on the mock host of `src/renderer/stories/web-client-inbox-harness.tsx`, reacts to
// a message in #general with the second quick reaction, reloads, and reads the quick reactions
// again. Before the fix this computer kept the recent emoji from before the reaction.
//
// `bun scripts/workspace-reaction-recent-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/workspace-reaction-recent-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("workspace-reaction-recent-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/workspace-reaction-recent-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");
const REACT_PREFIX = english("workspace.reaction.add", { emoji: "" });

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
    <script type="module" src="/src/renderer/stories/web-client-inbox-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-reaction-recent-harness",
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
  quickBefore: string[];
  picked: string | null;
  quickAfter: string[];
  pageErrors: string[];
  passed: boolean;
} = { quickBefore: [], picked: null, quickAfter: [], pageErrors: [], passed: false };

const firstMessage = (page: Page) => page.locator("article.ws-message").first();
const toolbar = (page: Page) => page.getByRole("toolbar", { name: english("workspace.message.actions") }).first();

/** The emoji of the quick reactions of the first message of the open channel, in their order. */
async function quickReactions(page: Page): Promise<string[]> {
  await firstMessage(page).focus();
  await firstMessage(page).hover();
  const buttons = toolbar(page).getByRole("button", { name: new RegExp(`^${REACT_PREFIX}`, "u") });
  await buttons.first().waitFor({ timeout: UI_WAIT_MS });
  const labels = await buttons.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label") ?? ""));
  return labels.map((label) => label.slice(REACT_PREFIX.length));
}

async function openGeneral(page: Page, origin: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${origin}/app/general/c/general`, { waitUntil: "commit" });
    const shown = await firstMessage(page)
      .waitFor({ timeout: UI_WAIT_MS / 2 })
      .then(
        () => true,
        () => false,
      );
    if (shown) return;
  }
  await firstMessage(page).waitFor({ timeout: UI_WAIT_MS });
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
  optimizeDeps: {
    entries: ["src/renderer/stories/web-client-inbox-harness.tsx"],
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await openGeneral(page, origin);
  report.quickBefore = await quickReactions(page);
  const picked = report.quickBefore[1] ?? null;
  assert.ok(picked, "No second quick reaction.");
  report.picked = picked;
  await toolbar(page)
    .getByRole("button", { name: english("workspace.reaction.add", { emoji: picked }), exact: true })
    .click();
  // The reaction shows under the message once the mock host took it.
  await firstMessage(page)
    .getByRole("button", { name: new RegExp(picked, "u") })
    .first()
    .waitFor({ timeout: UI_WAIT_MS });
  await openGeneral(page, origin);
  report.quickAfter = await quickReactions(page);
  report.passed = report.quickAfter[0] === picked && report.pageErrors.length === 0;
  await context.close();
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
logger.info(`${report.passed ? "Passed" : "Failed"}: ${JSON.stringify(report)}`);
process.exit(report.passed ? 0 : 1);
