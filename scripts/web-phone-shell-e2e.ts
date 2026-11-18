// Checks the web client on an iPhone, as Slack's mobile app works: the bottom tabs (Home, DMs,
// Activity, More), Home without the sidebar's view rows, the space switcher, a conversation and a
// thread that push over the list, Back that pops one screen at a time, and the tab title count. It
// serves the web client on a mock host (`src/renderer/stories/web-client-harness.tsx`, the "Spaces
// workspace" story) at every address under `/app`, as the site does, and drives it in Chromium with
// an iPhone viewport and touch. No account service, host or provider is needed.
//
// `bun scripts/web-phone-shell-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/web-phone-shell-e2e/report.json and one screenshot for each screen.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("web-phone-shell-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-phone-shell-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");
const COMMIT = { waitUntil: "commit" } as const;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

// `viewport-fit=cover` as the site's /app page, so the bars keep clear of the safe areas themselves.
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

/** Serves the harness page at `/app` and every address under it, as the site's `/app/$` route does. */
function webClientPages(): Plugin {
  return {
    name: "openbot-web-phone-shell-harness",
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

const report: {
  device: string;
  steps: Step[];
  pageErrors: string[];
  consoleErrors: string[];
  screenshots: string[];
  title: string | null;
  passed: boolean;
} = {
  device: "iPhone 13",
  steps: [],
  pageErrors: [],
  consoleErrors: [],
  screenshots: [],
  title: null,
  passed: false,
};

const path = (page: Page) => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
};

async function waitForPath(page: Page, expected: string): Promise<void> {
  await page.waitForFunction((value) => `${location.pathname}${location.search}` === value, expected, {
    timeout: UI_WAIT_MS,
  });
}

/** The pane of the open channel, DM or group. */
const channelPane = (page: Page, name: string) => page.getByRole("region", { name, exact: true }).first();
const tabBar = (page: Page) => page.getByRole("navigation", { name: english("workspace.phone.tabs") });
type TabKey = "workspace.phone.home" | "workspace.phone.dms" | "workspace.phone.activity" | "workspace.phone.more";
const tab = (page: Page, key: TabKey) =>
  tabBar(page).getByRole("button", { name: new RegExp(`^${english(key)}`, "u") });

async function step(page: Page, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ name, url: path(page), passed: true });
  } catch (error) {
    const shown = await page
      .evaluate(() => (document.querySelector(".web-app")?.textContent ?? "").replace(/\s+/gu, " ").slice(0, 400))
      .catch((reason: unknown) => String(reason));
    report.steps.push({
      name,
      url: path(page),
      passed: false,
      detail: `${String(error).slice(0, 500)}\nPage: ${shown}`,
    });
    const shot = resolve(OUT, `${report.steps.length}-failed.png`);
    await page.screenshot({ path: shot }).catch(() => undefined);
    report.screenshots.push(shot);
    throw error;
  }
}

async function shot(page: Page, label: string): Promise<void> {
  const file = resolve(OUT, `${label}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(file);
}

/** Back, as the iOS swipe and the Android button do: one history step, in the page. */
async function back(page: Page): Promise<void> {
  await page.evaluate(() => history.back());
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
let browser: Browser | null = null;

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  const context = await browser.newContext({ ...iphone, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    // The harness has no favicon or fonts route; a missing file is not a failure of the client.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
      report.consoleErrors.push(message.text().slice(0, 1_000));
  });

  // 1. A bare address opens Home: the tab bar, the space's channels and DMs, and no view rows.
  await step(page, "a bare address opens Home with the tab bar", async () => {
    await page.goto(`${origin}/app/general`, COMMIT);
    await tab(page, "workspace.phone.home").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await tab(page, "workspace.phone.home").getAttribute("aria-current"), "page");
    await page
      .getByRole("button", { name: /general/u })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    // The admin views are under More, not above the channels.
    assert.equal(
      await page.getByRole("button", { name: english("workspace.view.agents"), exact: true }).isVisible(),
      false,
    );
    await page
      .getByRole("button", { name: english("workspace.view.threads") })
      .first()
      .waitFor();
  });
  await shot(page, "01-home");

  // 2. The title and the DMs tab count the unread replies of Chief.
  await step(page, "the tab title and the DMs tab count unread messages", async () => {
    await page.waitForFunction(() => /^\(\d+\) /u.test(document.title), undefined, { timeout: UI_WAIT_MS });
    report.title = await page.title();
    const label = (await tab(page, "workspace.phone.dms").getAttribute("aria-label")) ?? "";
    assert.match(label, /unread conversation/u);
  });

  // 3. A channel pushes over Home; the tab bar steps aside; Back pops to Home.
  await step(page, "a channel pushes over Home", async () => {
    await page
      .getByRole("button", { name: /general/u })
      .first()
      .tap();
    await channelPane(page, "general").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await tabBar(page).isVisible(), false);
    // The channel is a screen of its own in the history: the step back below shows the list.
    const screen = await page.evaluate(() => String(history.state?.openbotPane ?? ""));
    assert.equal(screen, "conversation");
  });
  await shot(page, "02-channel");
  await step(page, "Back pops the channel to Home", async () => {
    await back(page);
    await tab(page, "workspace.phone.home").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await channelPane(page, "general").isVisible(), false);
  });

  // 4. A thread pushes over its channel; Back goes to the channel, then to the list.
  await step(page, "a thread link opens the thread over its channel", async () => {
    await page.goto(`${origin}/app/general/c/general/t/general-root`, COMMIT);
    await page.getByText("Started: I compare the plans of both rivals.").first().waitFor({ timeout: UI_WAIT_MS });
    await waitForPath(page, "/app/general/c/general/t/general-root");
  });
  await shot(page, "03-thread");
  await step(page, "Back from the thread shows its channel", async () => {
    await back(page);
    await channelPane(page, "general").waitFor({ timeout: UI_WAIT_MS });
    await page.waitForFunction(() => !location.pathname.includes("/t/"), undefined, { timeout: UI_WAIT_MS });
  });
  await step(page, "Back from the channel shows the list", async () => {
    await back(page);
    await tab(page, "workspace.phone.home").waitFor({ timeout: UI_WAIT_MS });
  });

  // 5. DMs: the list with the last message; a DM pushes; Back returns to the DMs tab.
  await step(page, "the DMs tab lists DMs with their last message", async () => {
    await tab(page, "workspace.phone.dms").tap();
    await page.getByRole("button", { name: /Ana.*Lunch at 12\?/u }).waitFor({ timeout: UI_WAIT_MS });
  });
  await shot(page, "04-dms");
  await step(page, "a DM opens and Back returns to the DMs tab", async () => {
    await page.getByRole("button", { name: /Ana.*Lunch at 12\?/u }).tap();
    await channelPane(page, "Ana").waitFor({ timeout: UI_WAIT_MS });
    await back(page);
    await tab(page, "workspace.phone.dms").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await tab(page, "workspace.phone.dms").getAttribute("aria-current"), "page");
  });

  await step(page, "a long press on a DM opens its actions in a sheet", async () => {
    const row = page.getByRole("button", { name: /Ana.*Lunch at 12\?/u });
    const box = await row.boundingBox();
    assert.ok(box, "The DM row has no box.");
    const cdp = await context.newCDPSession(page);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: english("workspace.sidebar.mute") }).waitFor({ timeout: UI_WAIT_MS });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await shot(page, "04b-dm-actions");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });

  // 6. Activity: an item opens its conversation; Back returns to Activity.
  await step(page, "the Activity tab opens an item and Back returns to it", async () => {
    await tab(page, "workspace.phone.activity").tap();
    const item = page.getByRole("button", { name: /Ana/u }).filter({ hasText: "Lunch at 12?" }).first();
    await item.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "05-activity");
    await item.tap();
    await channelPane(page, "Ana").waitFor({ timeout: UI_WAIT_MS });
    await back(page);
    await tab(page, "workspace.phone.activity").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await tab(page, "workspace.phone.activity").getAttribute("aria-current"), "page");
  });

  // 7. More: the views that the desktop keeps under More, and the profile's settings.
  await step(page, "More opens Between agents, and Back returns to More", async () => {
    await tab(page, "workspace.phone.more").tap();
    await page.getByRole("button", { name: english("workspace.view.agents") }).waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "06-more");
    await page.getByRole("button", { name: english("workspace.view.agents") }).tap();
    await waitForPath(page, "/app/general/between-agents");
    assert.equal(await tabBar(page).isVisible(), false);
    await back(page);
    await tab(page, "workspace.phone.more").waitFor({ timeout: UI_WAIT_MS });
  });
  await step(page, "the profile opens the settings, and Back returns to More", async () => {
    await page.getByRole("button", { name: /Preview User/u }).tap();
    await page.getByRole("heading", { name: english("app.settingsPage.title") }).waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "07-settings");
    await back(page);
    await tab(page, "workspace.phone.more").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await page.getByRole("heading", { name: english("app.settingsPage.title") }).isVisible(), false);
  });

  // 8. The space switcher: a sheet of spaces; a pick shows that space's Home.
  await step(page, "the switcher sheet changes the space", async () => {
    await tab(page, "workspace.phone.home").tap();
    await page.getByRole("button", { name: new RegExp(`^${english("workspace.phone.switch")}`, "u") }).tap();
    const trading = page.getByRole("dialog").getByRole("button", { name: /^Trading/u });
    await trading.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "08-switcher");
    await trading.tap();
    await page
      .getByRole("button", { name: english("workspace.sidebar.workspaceMenu", { name: "Trading" }) })
      .waitFor({ timeout: UI_WAIT_MS });
    await page
      .getByRole("button", { name: /cakemaker/u })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
  });
  await shot(page, "09-trading-home");

  // 9. The app on the Home Screen: a swipe from the left edge goes back one screen.
  const app = await context.newPage();
  app.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  // Safari tells a Home Screen app by `navigator.standalone`.
  await app.addInitScript(() => Object.defineProperty(Navigator.prototype, "standalone", { get: () => true }));
  const cdp = await context.newCDPSession(app);
  await step(app, "an edge swipe goes back in the Home Screen app", async () => {
    await app.goto(`${origin}/app/general/c/general`, COMMIT);
    await channelPane(app, "general").waitFor({ timeout: UI_WAIT_MS });
    const y = 400;
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
      });
    await touch("touchStart", 4);
    for (const x of [20, 60, 120, 180, 240, 300]) await touch("touchMove", x);
    await touch("touchEnd", 300);
    await tab(app, "workspace.phone.home").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await channelPane(app, "general").isVisible(), false);
  });
  await app.close();

  report.passed =
    report.steps.every((item) => item.passed) && report.pageErrors.length === 0 && report.consoleErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps. Report: ${resolve(OUT, "report.json")}`,
);
process.exit(report.passed ? 0 : 1);
