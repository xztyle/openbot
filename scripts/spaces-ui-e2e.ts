// Walks the spaces of the web client on a computer and on an iPhone: Back after Open on a request
// of another space in "Needs you" returns to the space the reader came from; moving the open agent to
// another space takes the reader along; a space's Mark all as read leaves the other spaces unread;
// a phone deletes a space from its switcher. It serves the web client on the mock host of
// `src/renderer/stories/web-client-today-harness.tsx` (General, Trading with Research and
// #cakemaker, and an empty Piks) and drives it in Chromium. No account service or host is needed.
//
// `bun scripts/spaces-ui-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/spaces-ui-e2e/report.json and a screenshot of each failed step.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("spaces-ui-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/spaces-ui-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");
const COMMIT = { waitUntil: "commit" } as const;

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
    <script type="module" src="/src/renderer/stories/web-client-today-harness.tsx"></script>
  </body>
</html>`;

/** Serves the harness page at `/app` and every address under it, as the site's `/app/$` route does. */
function webClientPages(): Plugin {
  return {
    name: "openbot-spaces-ui-harness",
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
  name: string;
  url: string;
  passed: boolean;
  detail?: string;
}

const report: { steps: Step[]; pageErrors: string[]; screenshots: string[]; passed: boolean } = {
  steps: [],
  pageErrors: [],
  screenshots: [],
  passed: false,
};

const path = (page: Page) => new URL(page.url()).pathname;
const spacesRail = (page: Page) => page.getByRole("navigation", { name: english("workspace.spaces.label") });
const firstCard = (page: Page) => page.getByRole("article").first();

async function step(page: Page, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ name, url: path(page), passed: true });
  } catch (error) {
    report.steps.push({ name, url: path(page), passed: false, detail: String(error).slice(0, 800) });
    const file = resolve(OUT, `${report.steps.length}-failed.png`);
    await page.screenshot({ path: file }).catch(() => undefined);
    report.screenshots.push(file);
  }
}

/** Waits until the address bar names `pathname`. */
async function at(page: Page, pathname: string): Promise<void> {
  await page.waitForFunction((wanted) => window.location.pathname === wanted, pathname, { timeout: UI_WAIT_MS });
}

/**
 * Opens `/app/<space>` and waits for the card of Today named `card`: Today lists the requests of the
 * space that shows. The host's attention list comes a moment after the first connect.
 */
async function start(page: Page, space: string, card: RegExp): Promise<void> {
  await page.goto(`/app/${space}`, COMMIT);
  await firstCard(page).waitFor({ timeout: UI_WAIT_MS });
  await page.getByRole("article", { name: card }).waitFor({ timeout: UI_WAIT_MS });
}

/** Opens the first request of `agent` in another space from the "Needs you" button of the top bar. */
async function openOtherSpaceRequest(page: Page, here: number, others: number, agent: string): Promise<void> {
  await page.getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: here }) }).click();
  await page.getByRole("button", { name: english("workspace.needsYou.otherSpaces", { count: others }) }).click();
  await page
    .getByText(english("workspace.needsYou.rowTitle", { name: agent }), { exact: true })
    .first()
    .click();
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
    entries: ["src/renderer/stories/web-client-today-harness.tsx"],
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

  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: origin });
  const page = await desk.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));

  // 1. Trading: Open on Chief's payment (General) from the other spaces of "Needs you", and Back
  // returns to Trading.
  await step(page, "Back after Open on a request of another space returns to the space before", async () => {
    await start(page, "market-trading", /Approve \$40/u);
    await at(page, "/app/market-trading/today");
    await openOtherSpaceRequest(page, 2, 2, "Chief");
    await at(page, "/app/general/dm/chief");
    await page.goBack();
    await at(page, "/app/market-trading/today");
    await spacesRail(page)
      .getByRole("button", { name: /^Trading/u, pressed: true })
      .waitFor({ timeout: UI_WAIT_MS });
  });

  // 2. General: Open on the loop decision (Trading) from the other spaces, and Back returns to General.
  await step(page, "Back after Open on a loop decision of another space returns to the space before", async () => {
    await start(page, "general", /^Chief/u);
    await at(page, "/app/general/today");
    await openOtherSpaceRequest(page, 2, 2, "Research");
    await at(page, "/app/market-trading/loops");
    await page.goBack();
    await at(page, "/app/general/today");
  });

  // 3. Research's chat is open in Trading; moving Research to Piks shows Piks with the chat.
  await step(page, "moving the open agent to another space takes the reader along", async () => {
    await start(page, "market-trading", /Approve \$40/u);
    const research = page.getByRole("button", { name: /^Research, AI agent/u });
    await research.click();
    await at(page, "/app/market-trading/dm/research");
    await research.click({ button: "right" });
    await page.getByRole("menuitem", { name: english("workspace.spaces.moveToSpace") }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: /General/u }).click();
    await page.getByRole("option", { name: "Piks" }).click();
    await dialog.getByRole("button", { name: english("workspace.spaces.moveButton"), exact: true }).click();
    await at(page, "/app/piks/dm/research");
    await spacesRail(page).getByRole("button", { name: /^Piks/u, pressed: true }).waitFor({ timeout: UI_WAIT_MS });
    await page.getByRole("button", { name: /^Research, AI agent/u }).waitFor({ timeout: UI_WAIT_MS });
  });

  // 4. Mark all as read in Trading's menu: Trading is read, General's Unreads still lists #general.
  await step(page, "a space's Mark all as read leaves the other spaces unread", async () => {
    await start(page, "market-trading", /Approve \$40/u);
    await spacesRail(page)
      .getByRole("button", { name: /^Trading, /u })
      .waitFor({ timeout: UI_WAIT_MS });
    await page.getByRole("button", { name: english("workspace.sidebar.workspaceMenu", { name: "Trading" }) }).click();
    await page.getByRole("menuitem", { name: english("workspace.app.menu.markAllRead") }).click();
    await spacesRail(page).getByRole("button", { name: "Trading", exact: true }).waitFor({ timeout: UI_WAIT_MS });
    // Give a mark of every space time to land before the check.
    await page.waitForTimeout(1500);
    await spacesRail(page)
      .getByRole("button", { name: /^General/u })
      .click();
    await page.getByRole("button", { name: new RegExp(`^${english("workspace.view.unreads")}`, "u") }).click();
    await page
      .getByRole("region", { name: english("workspace.view.unreads") })
      .getByRole("button", { name: /^general \d+ new/u })
      .waitFor({ timeout: UI_WAIT_MS });
  });
  await desk.close();

  // 5. A phone: the switcher of Piks has Delete space; it deletes Piks and shows General.
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  const phone = await browser.newContext({ ...iphone, hasTouch: true, isMobile: true, baseURL: origin });
  const phonePage = await phone.newPage();
  phonePage.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await step(phonePage, "a phone deletes a space from the space switcher", async () => {
    await phonePage.goto("/app/piks", COMMIT);
    const tabs = phonePage.getByRole("navigation", { name: english("workspace.phone.tabs") });
    await tabs.getByRole("button", { name: /^Chat/u }).tap();
    const switcher = phonePage.getByRole("button", { name: new RegExp(`^${english("workspace.phone.switch")}`, "u") });
    await switcher.tap();
    await phonePage.getByRole("button", { name: english("workspace.spaces.delete") }).tap();
    await phonePage
      .getByRole("alertdialog")
      .getByRole("button", { name: english("workspace.spaces.deleteButton") })
      .tap();
    await phonePage.waitForFunction(() => window.location.pathname.startsWith("/app/general"), null, {
      timeout: UI_WAIT_MS,
    });
    await switcher.tap();
    await phonePage
      .getByRole("dialog")
      .getByRole("button", { name: /^Trading/u })
      .waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await phonePage.getByRole("dialog").getByRole("button", { name: /^Piks/u }).count(), 0);
  });
  await phone.close();

  report.passed = report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
for (const item of report.steps)
  logger.info(`${item.passed ? "ok  " : "FAIL"} ${item.name}${item.detail ? `\n${item.detail}` : ""}`);
logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps.`,
);
process.exit(report.passed ? 0 : 1);
