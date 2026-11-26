// Checks the addresses of the web client: reload, Back and Forward, a shared link, a link to something
// that is gone, and a phone. It serves the web client on a mock host (the "Spaces workspace" story,
// `src/renderer/stories/web-client-harness.tsx`) at every address under `/app`, as the site does, and
// drives it in Chromium. No account service, host or provider is needed.
//
// `bun scripts/web-deep-links-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/web-deep-links-e2e/report.json and screenshots.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("web-deep-links-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-deep-links-e2e");
const UI_WAIT_MS = 60_000;
/** How long a page load may stay blank before the check loads it again. */
const STARTED_MS = 20_000;
const english = translateFor("en");
// The client writes its address before the page's load event; a wait for "load" can then read the
// navigation as cut off. Each step waits for what it checks instead.
const COMMIT = { waitUntil: "commit" } as const;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
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
    name: "openbot-web-deep-links-harness",
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
  steps: Step[];
  pageErrors: string[];
  consoleErrors: string[];
  screenshots: string[];
  passed: boolean;
} = {
  steps: [],
  pageErrors: [],
  consoleErrors: [],
  screenshots: [],
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
const channelHeading = (page: Page, name: string) => page.getByRole("region", { name, exact: true }).first();

/**
 * Waits until the page has loaded what it asked for, before a step leaves it. A page left while its
 * modules load aborts them, and the dev server can then leave the same modules of the next page
 * pending, so that page stays blank.
 */
async function settle(page: Page): Promise<void> {
  if (page.url() === "about:blank") return;
  await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
}

/**
 * Waits until the client shows something. A page of the dev server can stay blank with its modules
 * pending after many page loads in one tab; a fresh load of the same address then shows. This is
 * the dev server's, not the client's: a reload of the same address is no step of the check.
 */
async function started(page: Page): Promise<void> {
  const shows = () =>
    page
      .waitForFunction(() => (document.getElementById("root")?.textContent ?? "").length > 0, undefined, {
        timeout: STARTED_MS,
      })
      .then(
        () => true,
        () => false,
      );
  if (await shows()) return;
  await page.reload(COMMIT);
  await shows();
}

async function step(page: Page, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ name, url: path(page), passed: true });
  } catch (error) {
    const shown = await page
      .evaluate(() => (document.querySelector("main, .web-app")?.textContent ?? "").replace(/\s+/gu, " ").slice(0, 300))
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

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  // Vite scans the harness at the start. A dependency that it finds later reloads the page during a step.
  optimizeDeps: { entries: ["src/renderer/stories/web-client-harness.tsx"], include: ["@norbert_bodziony/bloub"] },
  // A worktree can link its packages to another checkout's node_modules.
  // No hot reload: a dropped socket would reload the page during a step.
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
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    // The harness has no favicon or fonts route; a missing file is not a failure of the client.
    // The dev server's own socket is no part of the client: a page left during a step drops it.
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource") &&
      !message.text().startsWith("[vite]") &&
      !message.text().startsWith(`WebSocket connection to 'ws://127.0.0.1:${address.port}/`)
    )
      report.consoleErrors.push(message.text().slice(0, 1_000));
  });

  // 1. A shared link to a channel of another space opens that space and the channel.
  await step(page, "link to a channel of another space", async () => {
    await settle(page);
    await page.goto(`${origin}/app/market-trading/c/cakemaker`, COMMIT);
    await started(page);
    await channelHeading(page, "cakemaker").waitFor({ timeout: UI_WAIT_MS });
    await waitForPath(page, "/app/market-trading/c/cakemaker");
  });
  await shot(page, "1-channel");

  // 2. A reload stays there.
  await step(page, "reload keeps the channel", async () => {
    await settle(page);
    await page.reload(COMMIT);
    await started(page);
    await channelHeading(page, "cakemaker").waitFor({ timeout: UI_WAIT_MS });
    await waitForPath(page, "/app/market-trading/c/cakemaker");
  });

  // 3. A thread, with Back and Forward.
  await step(page, "thread link opens the channel and its thread", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general/c/general/t/general-root`, COMMIT);
    await started(page);
    await channelHeading(page, "general").waitFor({ timeout: UI_WAIT_MS });
    await page.getByText("Started: I compare the plans of both rivals.").waitFor({ timeout: UI_WAIT_MS });
    await waitForPath(page, "/app/general/c/general/t/general-root");
  });
  await shot(page, "3-thread");
  await step(page, "a view that the user opens gets its own entry", async () => {
    const before = await page.evaluate(() => history.length);
    await page
      .getByRole("button", { name: english("workspace.view.activity") })
      .first()
      .click();
    await waitForPath(page, "/app/general/activity");
    assert.equal(await page.evaluate(() => history.length), before + 1);
  });
  await step(page, "Back opens the thread again", async () => {
    await page.goBack(COMMIT);
    await waitForPath(page, "/app/general/c/general/t/general-root");
    await page.getByText("Started: I compare the plans of both rivals.").waitFor({ timeout: UI_WAIT_MS });
  });
  await step(page, "Forward opens the view again", async () => {
    await page.goForward(COMMIT);
    await waitForPath(page, "/app/general/activity");
  });

  // 4. Copy link of a message gives an address that names the server; it opens and marks the message.
  let messageLink = "";
  await step(page, "Copy link of a message", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general/c/general`, COMMIT);
    await started(page);
    await channelHeading(page, "general").waitFor({ timeout: UI_WAIT_MS });
    const row = page.getByRole("article").filter({ hasText: "Thanks all, the site looks great" }).first();
    await row.hover();
    await row.getByRole("button", { name: english("workspace.message.more") }).click();
    await page.getByRole("menuitem", { name: english("workspace.app.message.copyLink") }).click();
    messageLink = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(messageLink, /^http:\/\/127\.0\.0\.1:\d+\/app\/s\/preview-host\/general\/c\/general\/m\/[\w-]+$/u);
  });
  await step(page, "message link marks the message", async () => {
    await settle(page);
    await page.goto(messageLink, COMMIT);
    await started(page);
    await channelHeading(page, "general").waitFor({ timeout: UI_WAIT_MS });
    await page
      .locator("[data-highlighted]")
      .filter({ hasText: "Thanks all, the site looks great" })
      .waitFor({ timeout: UI_WAIT_MS });
    // One server: the address leaves it out.
    await waitForPath(page, new URL(messageLink).pathname.replace("/s/preview-host", ""));
  });
  await shot(page, "4-message");

  // 5. A space that the user picks on the rail is a step; Back returns to the place before it.
  await step(page, "a space picked on the rail gets its own entry", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general/c/general`, COMMIT);
    await started(page);
    await channelHeading(page, "general").waitFor({ timeout: UI_WAIT_MS });
    // The rail lists Trading once the host named its spaces; a click before that is a click on the start.
    const trading = page.getByRole("button", { name: /^Trading/u }).first();
    await trading.waitFor({ timeout: UI_WAIT_MS });
    await trading.click();
    // A space opens on its home, Today.
    await waitForPath(page, "/app/market-trading/today");
    await page.goBack(COMMIT);
    await waitForPath(page, "/app/general/c/general");
    await channelHeading(page, "general").waitFor({ timeout: UI_WAIT_MS });
  });

  // 6. A reply link opens its thread and marks the reply there.
  await step(page, "reply link marks the reply in its thread", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general/c/general/t/general-root`, COMMIT);
    await started(page);
    const reply = page.getByText("Great, add the yearly prices too.");
    await reply.waitFor({ timeout: UI_WAIT_MS });
    const row = page.getByRole("article").filter({ hasText: "Great, add the yearly prices too." }).last();
    await row.hover();
    await row.getByRole("button", { name: english("workspace.message.more") }).click();
    await page.getByRole("menuitem", { name: english("workspace.app.message.copyLink") }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(link, /\/app\/s\/preview-host\/general\/c\/general\/t\/general-root\/m\/[\w-]+$/u);
    // Let the page load before it is left: a page left while it starts drops the dev server's socket.
    await settle(page);
    await page.goto(`${origin}/app/general/activity`, COMMIT);
    await started(page);
    await page
      .getByRole("heading", { name: english("workspace.view.activity"), exact: true })
      .waitFor({ timeout: UI_WAIT_MS });
    await settle(page);
    await page.goto(link, COMMIT);
    await started(page);
    await page
      .locator("[data-highlighted]")
      .filter({ hasText: "Great, add the yearly prices too." })
      .waitFor({ timeout: UI_WAIT_MS });
  });
  await shot(page, "6-reply");

  // 7. The owner's chat with an agent.
  await step(page, "agent chat link", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general/dm/chief`, COMMIT);
    await started(page);
    await waitForPath(page, "/app/general/dm/chief");
    await settle(page);
    await page.reload(COMMIT);
    await started(page);
    await waitForPath(page, "/app/general/dm/chief");
  });
  await shot(page, "7-agent");

  // 8. A link to something gone shows the space's home, Today, with a notice.
  await step(page, "a gone channel falls back with a notice", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general/c/no-such-channel`, COMMIT);
    await started(page);
    await page.getByText(english("webClient.location.unavailable")).waitFor({ timeout: UI_WAIT_MS });
    await waitForPath(page, "/app/general/today");
  });
  await shot(page, "8-gone");

  // 9. A settings page over a place: Back closes it.
  await step(page, "a settings page is a step of its own", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general/c/random?page=settings`, COMMIT);
    await started(page);
    await page.getByRole("heading", { name: english("app.settingsPage.title") }).waitFor({ timeout: UI_WAIT_MS });
    await page.keyboard.press("Escape");
    await waitForPath(page, "/app/general/c/random");
    await page.goBack(COMMIT);
    await waitForPath(page, "/app/general/c/random?page=settings");
    await page.getByRole("heading", { name: english("app.settingsPage.title") }).waitFor({ timeout: UI_WAIT_MS });
  });

  // 9b. A page with no place opens over the space's home, not over the last chat.
  await step(page, "a page address with no place opens over Today", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general?page=settings`, COMMIT);
    await started(page);
    await page.getByRole("heading", { name: english("app.settingsPage.title") }).waitFor({ timeout: UI_WAIT_MS });
    await waitForPath(page, "/app/general/today?page=settings");
  });

  // 9c. A link to a section of the server settings opens it, and the client still answers: a sync
  // throw of the section's first read halted every update.
  await step(page, "a server settings section link opens and the client still answers", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general/c/random?page=server-settings&section=workspace`, COMMIT);
    await started(page);
    // One Settings page: the old server-settings address opens it on the server's section.
    await page.getByRole("heading", { name: english("app.settingsPage.title") }).waitFor({ timeout: UI_WAIT_MS });
    await waitForPath(page, "/app/general/c/random?page=settings&section=workspace");
    await page.keyboard.press("Escape");
    await waitForPath(page, "/app/general/c/random");
    assert.equal(
      report.pageErrors.some((error) => error.includes(english("webClient.error.connectServerFirst"))),
      false,
    );
  });

  // 9d. The section stays in the address: an old `preferences` link opens Appearance, and a tab the
  // user picks is what a reload opens.
  await step(page, "a settings section survives the load and a reload", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general/c/random?page=settings&section=preferences`, COMMIT);
    await started(page);
    const sections = page.getByRole("navigation", { name: english("settings.sections.label") });
    await sections
      .getByRole("button", { name: english("webClient.settings.appearance.title"), exact: true })
      .waitFor({ timeout: UI_WAIT_MS });
    await page.waitForFunction(
      () => document.querySelector('[data-tab="appearance"]')?.checkVisibility() === true,
      undefined,
      { timeout: UI_WAIT_MS },
    );
    await waitForPath(page, "/app/general/c/random?page=settings&section=appearance");
    await sections
      .getByRole("button", { name: english("webClient.settings.notifications.title"), exact: true })
      .click();
    await waitForPath(page, "/app/general/c/random?page=settings&section=notifications");
    await settle(page);
    await page.reload(COMMIT);
    await started(page);
    await page.waitForFunction(
      () => document.querySelector('[data-tab="notifications"]')?.checkVisibility() === true,
      undefined,
      { timeout: UI_WAIT_MS },
    );
    await waitForPath(page, "/app/general/c/random?page=settings&section=notifications");
    await page.keyboard.press("Escape");
    await waitForPath(page, "/app/general/c/random");
  });

  // 9e. A server section in the one section list opens the server settings, and the client still
  // answers: the dialog read the section's options in an effect callback, which halted every update.
  await step(page, "a server section of the one list opens and the client still answers", async () => {
    await settle(page);
    const halted = report.consoleErrors.length;
    await page.goto(`${origin}/app/general/c/random?page=settings&section=appearance`, COMMIT);
    await started(page);
    await page
      .getByRole("navigation", { name: english("settings.sections.label") })
      .getByRole("button", { name: english("server.settings.workspaceTitle"), exact: true })
      .click({ timeout: UI_WAIT_MS });
    await waitForPath(page, "/app/general/c/random?page=settings&section=workspace");
    await page
      .getByRole("heading", { name: english("server.settings.workspaceTitle") })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    await page.keyboard.press("Escape");
    await waitForPath(page, "/app/general/c/random");
    assert.equal(
      report.consoleErrors.slice(halted).some((error) => error.includes("REACTIVITY_HALTED")),
      false,
      "The client stopped updating.",
    );
  });

  // 10. Copy link of a channel header; a link that names the wrong space opens the channel's own.
  await step(page, "Copy link of a channel", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general/c/cakemaker`, COMMIT);
    await started(page);
    await channelHeading(page, "cakemaker").waitFor({ timeout: UI_WAIT_MS });
    await waitForPath(page, "/app/market-trading/c/cakemaker");
    await channelHeading(page, "cakemaker").locator("header").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: english("workspace.app.channel.copyLink") }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(new URL(link).pathname, "/app/s/preview-host/market-trading/c/cakemaker");
  });

  // 10b. The command bar: a sentence that starts with "tell" goes to the lead; a verb with nothing to
  // act on offers no channel of that name.
  await step(page, "the command bar sends a 'tell me' sentence to the lead", async () => {
    await settle(page);
    await page.goto(`${origin}/app/general/c/general`, COMMIT);
    await started(page);
    await channelHeading(page, "general").waitFor({ timeout: UI_WAIT_MS });
    await page.keyboard.press("Control+k");
    const field = page.getByRole("combobox", { name: english("workspace.app.switcher.placeholder") });
    await field.waitFor({ timeout: UI_WAIT_MS });
    const sentence = "Tell me what the costs are this week";
    await field.fill(sentence);
    const items = page.locator(".ws-switcher-item");
    await page.waitForFunction(
      (text) => (document.querySelector(".ws-switcher-item")?.textContent ?? "").includes(text),
      sentence,
      { timeout: UI_WAIT_MS },
    );
    assert.ok(!(await items.first().textContent())?.startsWith(english("workspace.jump.create", { name: "" })));
    await field.fill("approve");
    await page.waitForFunction(
      () => (document.querySelector(".ws-switcher-item")?.textContent ?? "").length > 0,
      undefined,
      { timeout: UI_WAIT_MS },
    );
    const labels = await items.allTextContents();
    assert.equal(
      labels.some((label) => label.includes("#approve")),
      false,
      `The bar offers a channel: ${labels.join(" | ")}`,
    );
    await page.keyboard.press("Escape");
  });

  // 11. A phone opens the conversation of the address, and Back goes to the list, not to another place.
  await step(page, "phone opens the linked conversation", async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await settle(page);
    await page.goto(`${origin}/app/market-trading/c/cakemaker`, COMMIT);
    await started(page);
    await channelHeading(page, "cakemaker").waitFor({ timeout: UI_WAIT_MS });
    await waitForPath(page, "/app/market-trading/c/cakemaker");
  });
  await shot(page, "11-phone");
  await step(page, "phone Back shows the list and keeps the address", async () => {
    // The step stays in the page and on its address, so the browser may report no navigation for it.
    await page.evaluate(() => history.back());
    await page.getByRole("navigation", { name: english("workspace.phone.tabs") }).waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await channelHeading(page, "cakemaker").isVisible(), false);
    await waitForPath(page, "/app/market-trading/c/cakemaker");
  });
  await shot(page, "11-phone-list");

  report.passed = report.pageErrors.length === 0 && report.consoleErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps. Report: ${resolve(OUT, "report.json")}`,
);
process.exit(report.passed ? 0 : 1);
