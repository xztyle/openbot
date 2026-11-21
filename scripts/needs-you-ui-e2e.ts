// Checks "Needs you" in the web client on a computer and on an iPhone. Chief gave Sales Outbound work,
// and the reader wrote only to Chief, so Sales Outbound has no DM row. The script acts as the host
// (`src/renderer/stories/web-client-needsyou-harness.tsx`): Sales Outbound asks the reader to sign in
// on accounts.google.com in a browser tab, with the events that `scripts/needs-you-host-e2e.ts` sees
// a real host send (the request, its escalation to Chief, and `agent-attention-changed`).
//
// Computer: the Sales Outbound row shows with the Needs you mark; the top bar has "Needs you" with the
// count; Chief's "Waiting for replies" row says what to do and where, with Take over; Activity starts
// with the request; a row of the top bar list opens Sales Outbound's chat with the takeover card in
// view; "I'm done" answers it once, and every mark goes. iPhone: the Home has the Needs you chip; it
// opens Activity; the row opens the chat with the card in view; "I'm done" clears the chip.
//
// `bun scripts/needs-you-ui-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/needs-you-ui-e2e/report.json and a screenshot of each checked screen.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("needs-you-ui-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/needs-you-ui-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");
const SITE = "accounts.google.com";

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
    name: "openbot-needs-you-harness",
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

const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: typeof name === "string" });
const needsYouTitle = english("workspace.needsYou.title");
/** A sidebar row of an agent, with the Needs you mark in its name or without. */
const agentRow = (page: Page, name: string) =>
  page.locator("[data-ws-conversation]").filter({ hasText: new RegExp(`^${name}`, "u") });
const markedRow = (page: Page, name: string) =>
  page.locator(`[data-ws-conversation][data-needs-you]`).filter({ hasText: new RegExp(`^${name}`, "u") });
const card = (page: Page) => page.getByText(english("prompt.browser.title.pending", { host: SITE }));
const action = english("workspace.needsYou.action.takeoverAt", { site: SITE });

async function request(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.dataset.needsYouReady !== undefined, null, {
    timeout: UI_WAIT_MS,
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("needs-you-harness", { detail: "request" })));
}

/** The element is inside its scroller's view, not under the fold. */
async function inView(page: Page, target: Locator): Promise<void> {
  const handle = await target.elementHandle({ timeout: UI_WAIT_MS });
  assert.ok(handle, "The element is not on the page.");
  await page.waitForFunction(
    (element) => {
      const scroller = element.closest(".conversation-scroll");
      if (!scroller) return false;
      const box = element.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
    },
    handle,
    { timeout: UI_WAIT_MS },
  );
}

async function answered(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.documentElement.dataset.needsYouAnswered ?? 0));
}

async function desktop(browser: Browser, origin: string): Promise<void> {
  const viewport = "desktop";
  const context = await browser.newContext(VIEWPORTS.desktop);
  const page = await context.newPage();
  watch(page, viewport);

  await step(page, viewport, "Sales Outbound has no DM row before it needs the reader", async () => {
    await load(page, origin, "/app/general/dm/chief", agentRow(page, "Chief"));
    assert.equal(await agentRow(page, "Sales Outbound").count(), 0, "Sales Outbound has a row before it asks.");
    assert.equal(await button(page, new RegExp(needsYouTitle, "u")).count(), 0, "Needs you shows with nothing.");
    await shot(page, "desktop-before");
  });

  await step(
    page,
    viewport,
    "the request shows the row with its mark, the top bar count and the waiting row",
    async () => {
      await request(page);
      await markedRow(page, "Sales Outbound").waitFor({ timeout: UI_WAIT_MS });
      await markedRow(page, "Chief").waitFor({ timeout: UI_WAIT_MS });
      await page
        .getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 1 }) })
        .waitFor({ timeout: UI_WAIT_MS });
      const waiting = page.locator(".awaiting-replies-item").filter({ hasText: "Sales Outbound" });
      await waiting.getByText(action).waitFor({ timeout: UI_WAIT_MS });
      await button(waiting, new RegExp(english("sidebar.waiting.action.takeover"), "u")).waitFor({
        timeout: UI_WAIT_MS,
      });
      await shot(page, "desktop-request");
    },
  );

  await step(page, viewport, "Activity starts with the request", async () => {
    await page
      .locator("[data-ws-row]")
      .filter({ hasText: english("workspace.view.activity") })
      .first()
      .click();
    await page
      .getByRole("button", { name: english("workspace.needsYou.rowLabel", { name: "Sales Outbound", action }) })
      .waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "desktop-activity");
  });

  await step(page, viewport, "a row of the top bar list opens the chat with the card in view", async () => {
    await page.getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 1 }) }).click();
    const dialog = page.getByRole("dialog");
    await shot(page, "desktop-list");
    await dialog
      .getByRole("button", { name: english("workspace.needsYou.rowLabel", { name: "Sales Outbound", action }) })
      .click();
    // The card is taller than a laptop's chat; its actions are what must show.
    await inView(page, button(page, english("prompt.browser.done")));
    await shot(page, "desktop-card");
  });

  await step(page, viewport, "I'm done answers once, and every mark goes", async () => {
    await button(page, english("prompt.browser.done")).click();
    await page.waitForFunction(() => Number(document.documentElement.dataset.needsYouAnswered ?? 0) > 0, null, {
      timeout: UI_WAIT_MS,
    });
    await page
      .getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 1 }) })
      .waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await page
      .locator("[data-ws-conversation][data-needs-you]")
      .first()
      .waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await card(page).waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await answered(page), 1, "The card answered more than once.");
    await shot(page, "desktop-cleared");
  });
  await context.close();
}

async function phone(browser: Browser, origin: string): Promise<void> {
  const viewport = "phone";
  const context = await browser.newContext(VIEWPORTS.phone);
  const page = await context.newPage();
  watch(page, viewport);
  const chip = () => page.getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 1 }) });
  const chipList = () => page.getByRole("list", { name: english("workspace.phone.shortcuts") });

  await step(page, viewport, "the Home has the Needs you chip once Sales Outbound asks", async () => {
    await load(page, origin, "/app/general", chipList());
    assert.equal(await agentRow(page, "Sales Outbound").count(), 0, "Sales Outbound has a row before it asks.");
    await request(page);
    await page.locator(".ws-phone-chip[data-urgent]").waitFor({ timeout: UI_WAIT_MS });
    await markedRow(page, "Sales Outbound").waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "phone-home");
  });

  await step(page, viewport, "the chip opens Activity, and its row opens the chat with the card in view", async () => {
    await page.locator(".ws-phone-chip[data-urgent]").tap();
    const row = page.getByRole("button", {
      name: english("workspace.needsYou.rowLabel", { name: "Sales Outbound", action }),
    });
    await row.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "phone-activity");
    await row.tap();
    await inView(page, card(page));
    await inView(page, button(page, english("prompt.browser.done")));
    await shot(page, "phone-card");
  });

  await step(page, viewport, "I'm done clears the chip", async () => {
    await button(page, english("prompt.browser.done")).tap();
    await page.waitForFunction(() => Number(document.documentElement.dataset.needsYouAnswered ?? 0) > 0, null, {
      timeout: UI_WAIT_MS,
    });
    await card(page).waitFor({ state: "detached", timeout: UI_WAIT_MS });
    // Back goes to Activity, where the request is gone too; Home has no chip.
    await button(page, english("workspace.layout.back")).first().tap();
    await page.getByRole("region", { name: english("workspace.view.activity") }).waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await page.locator(".ws-needs-you-row").count(), 0, "Activity keeps the answered request.");
    await page
      .getByRole("button", { name: english("workspace.phone.home") })
      .first()
      .tap();
    await chipList().waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await chip().count(), 0, "The chip stays after the answer.");
    await shot(page, "phone-cleared");
  });
  await context.close();
}

const secretAction = english("workspace.needsYou.action.secretAt", { site: SITE });
const secretTitle = () => english("browser.secret.title.code");

/**
 * `submit_secret`: Sales Outbound asks for a 6-digit SMS code. "Needs you" lists it, a row opens the
 * chat with the secure card in view, and the typed code goes to the runtime's secret answer once.
 */
async function secretCard(browser: Browser, origin: string, viewport: ViewportName): Promise<void> {
  const context = await browser.newContext(VIEWPORTS[viewport]);
  const page = await context.newPage();
  watch(page, viewport);
  const tap = (target: Locator) => (viewport === "phone" ? target.tap() : target.click());

  await step(page, viewport, "a secret request shows in Needs you", async () => {
    await load(
      page,
      origin,
      viewport === "phone" ? "/app/general" : "/app/general/dm/chief",
      page.locator("[data-ws-conversation]").first(),
    );
    await page.waitForFunction(() => document.documentElement.dataset.needsYouReady !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("needs-you-harness", { detail: "secret" })));
    await markedRow(page, "Sales Outbound").waitFor({ timeout: UI_WAIT_MS });
    if (viewport === "phone") await tap(page.locator(".ws-phone-chip[data-urgent]"));
    else await page.getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 1 }) }).click();
    const row = page.getByRole("button", {
      name: english("workspace.needsYou.rowLabel", { name: "Sales Outbound", action: secretAction }),
    });
    await row.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-secret-list`);
    await tap(row);
  });

  await step(page, viewport, "the chat shows the secure code card in view", async () => {
    await inView(page, button(page, english("browser.secret.submit")));
    await shot(page, `${viewport}-secret-card`);
  });

  await step(page, viewport, "the typed code goes to the secret answer once, and the card goes", async () => {
    await page.getByLabel(english("browser.secret.codeLength", { digits: 6 }), { exact: true }).focus();
    await page.keyboard.type("482913");
    await tap(button(page, english("browser.secret.submit")));
    await page.waitForFunction(() => document.documentElement.dataset.needsYouSecrets !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.needsYouSecrets), "482913");
    await page.getByText(secretTitle()).first().waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-secret-cleared`);
  });
  await context.close();
}

/**
 * The live case: Sales Outbound's turn runs, and its event stream stalls while reads still work, so
 * the secret request and the requested runtime snapshot never come. The silent-turn check finds the
 * missing snapshot and replaces the connection; the new stream brings the card.
 */
async function stalledSecret(browser: Browser, origin: string): Promise<void> {
  const viewport = "desktop";
  const context = await browser.newContext(VIEWPORTS.desktop);
  const page = await context.newPage();
  watch(page, viewport);
  await step(page, viewport, "a stalled event stream is replaced, and the secret card shows", async () => {
    await load(page, origin, "/app/general/dm/sales?stall", page.locator("[data-ws-conversation]").first());
    await page.waitForFunction(() => document.documentElement.dataset.needsYouStalled !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
    // 30 s of silence, the check every 5 s, then 10 s for the snapshot that does not come.
    await page.waitForFunction(() => document.documentElement.dataset.needsYouReplaced !== undefined, null, {
      timeout: 120_000,
    });
    assert.ok(
      Number(await page.evaluate(() => document.documentElement.dataset.needsYouSnapshotRequests ?? 0)) > 0,
      "The silent-turn check did not ask for the runtime snapshot first.",
    );
    await inView(page, button(page, english("browser.secret.submit")));
    await page.getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 1 }) }).waitFor({
      timeout: UI_WAIT_MS,
    });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.needsYouReplaced), "1");
    await shot(page, "desktop-stalled-secret");
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
  await desktop(browser, origin);
  await phone(browser, origin);
  await secretCard(browser, origin, "desktop");
  await secretCard(browser, origin, "phone");
  await stalledSecret(browser, origin);
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
