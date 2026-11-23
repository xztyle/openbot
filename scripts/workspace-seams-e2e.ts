// Checks the seams between the Slack-parity parts of the workspace on a computer and on an iPhone:
// the tab title names the place; ⌘J goes to the first unread message; a thread reply also sent to
// the channel says "Replied to a thread" and opens its thread; the row menu has Mark as read;
// Activity names a DM as a DM; Unreads filters and sorts. On a phone: the Chat tab lists the DMs
// (Jump to "DMs" opens their view), a long press on a DM opens its actions, the bell opens a sheet, a
// thread has Back and no close, the address of Activity opens the Inbox tab, and the search field takes
// the focus. It serves the web client on a
// mock host with unread messages (`src/renderer/stories/web-client-inbox-harness.tsx`) and drives it
// in Chromium. No account service, host or provider is needed.
//
// `bun scripts/workspace-seams-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/workspace-seams-e2e/report.json and a screenshot of each checked screen.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("workspace-seams-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/workspace-seams-e2e");
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
    <script type="module" src="/src/renderer/stories/web-client-inbox-harness.tsx"></script>
  </body>
</html>`;

/** Serves the harness page at `/app` and every address under it, as the site's `/app/$` route does. */
function webClientPages(): Plugin {
  return {
    name: "openbot-workspace-seams-harness",
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
  titles: string[];
  pageErrors: string[];
  consoleErrors: string[];
  screenshots: string[];
  passed: boolean;
} = { steps: [], titles: [], pageErrors: [], consoleErrors: [], screenshots: [], passed: false };

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

const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });
const sidebar = (page: Page) => page.getByRole("navigation", { name: english("workspace.sidebar.label"), exact: true });
const pane = (page: Page, name: string) => page.getByRole("region", { name, exact: true }).first();
const tab = (page: Page, key: "workspace.view.today" | "workspace.phone.chat" | "workspace.phone.inbox") =>
  page
    .getByRole("navigation", { name: english("workspace.phone.tabs") })
    .getByRole("button", { name: new RegExp(`^${english(key)}`, "u") });

/** A long press as a finger makes it: the touch stays down until the sheet shows. */
async function longPress(context: BrowserContext, page: Page, target: Locator, until: Locator): Promise<void> {
  const box = await target.boundingBox();
  assert.ok(box, "The pressed element has no box.");
  const cdp = await context.newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await until.waitFor({ timeout: UI_WAIT_MS });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function desktop(browser: Browser, origin: string): Promise<void> {
  const viewport = "desktop";
  const context = await browser.newContext(VIEWPORTS.desktop);
  const page = await context.newPage();
  watch(page, viewport);
  const general = () =>
    sidebar(page)
      .getByRole("button", {
        name: new RegExp(`^${english("workspace.sidebar.publicChannel", { name: "general" })}`, "u"),
      })
      .first();

  await step(page, viewport, "the tab title names the channel and the space", async () => {
    await load(page, origin, "/app/general/c/general", pane(page, "general"));
    await page.waitForFunction(() => document.title.includes("#general - General - Atelier"), null, {
      timeout: UI_WAIT_MS,
    });
    report.titles.push(await page.title());
  });

  await step(page, viewport, "Ctrl+J goes to the first unread message", async () => {
    const divider = page.getByText(english("workspace.divider.new"), { exact: true }).first();
    await page.locator(".ws-message-scroll").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.keyboard.press("Control+j");
    await divider.waitFor({ timeout: UI_WAIT_MS });
    await page.waitForFunction(
      (label) => {
        const scroller = document.querySelector(".ws-message-scroll");
        const line = [...document.querySelectorAll(".ws-message-scroll *")].find(
          (element) => element.childElementCount === 0 && element.textContent?.trim() === label,
        );
        if (!scroller || !line) return false;
        const box = line.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        return box.top >= view.top && box.bottom <= view.bottom;
      },
      english("workspace.divider.new"),
      { timeout: UI_WAIT_MS },
    );
    await shot(page, "desktop-first-unread");
  });

  await step(page, viewport, "a reply also sent to the channel says it replied to a thread", async () => {
    await load(page, origin, "/app/general/c/general/t/general-root", pane(page, english("workspace.thread.title")));
    const thread = pane(page, english("workspace.thread.title"));
    await thread
      .getByRole("checkbox", { name: english("workspace.composer.alsoSend", { channel: "general" }) })
      .check();
    await thread.getByRole("textbox").click();
    await page.keyboard.type("Yearly prices are in the sheet");
    await page.keyboard.press("Enter");
    await thread.getByText("Yearly prices are in the sheet").waitFor({ timeout: UI_WAIT_MS });
    await thread.getByRole("button", { name: english("common.close"), exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/app/general/c/general", { timeout: UI_WAIT_MS });
    const replied = button(page, new RegExp(`^${english("workspace.message.repliedTo", { text: "" })}`, "u"));
    await replied.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "desktop-replied-to-thread");
    await replied.click();
    await page.waitForURL((url) => url.pathname === "/app/general/c/general/t/general-root", {
      timeout: UI_WAIT_MS,
    });
  });

  await step(page, viewport, "the row menu of an unread channel marks it read", async () => {
    await load(page, origin, "/app/general/activity", page.getByRole("heading", { name: "Activity", exact: true }));
    const unread = english("workspace.sidebar.unread");
    await page.waitForFunction(
      ({ name, unread }) =>
        [...document.querySelectorAll("[data-ws-conversation]")].some((row) => {
          const label = row.getAttribute("aria-label") ?? "";
          return label.startsWith(name) && label.includes(unread);
        }),
      { name: english("workspace.sidebar.publicChannel", { name: "general" }), unread },
      { timeout: UI_WAIT_MS },
    );
    await general().click({ button: "right" });
    await page.getByRole("menuitem", { name: english("workspace.app.channel.markRead") }).click();
    await page.waitForFunction(
      ({ name, unread }) =>
        [...document.querySelectorAll("[data-ws-conversation]")].some((row) => {
          const label = row.getAttribute("aria-label") ?? "";
          return label.startsWith(name) && !label.includes(unread);
        }),
      { name: english("workspace.sidebar.publicChannel", { name: "general" }), unread },
      { timeout: UI_WAIT_MS },
    );
  });

  await step(page, viewport, "Activity names a DM as a direct message", async () => {
    const activity = pane(page, english("workspace.view.activity"));
    await activity.getByText(english("workspace.activity.directMessage"), { exact: true }).first().waitFor({
      timeout: UI_WAIT_MS,
    });
    assert.equal(await activity.getByText("in #Ana", { exact: true }).count(), 0, "a DM shows no # place");
    await shot(page, "desktop-activity");
  });

  await step(page, viewport, "Unreads keeps only the DMs and sorts", async () => {
    await load(page, origin, "/app/general/unreads", page.getByRole("heading", { name: "Unreads", exact: true }));
    const view = pane(page, english("workspace.view.unreads"));
    await view.getByRole("tab", { name: english("workspace.activity.dms") }).click();
    await view.getByRole("button", { name: /^Ana/u }).first().waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await view.getByRole("button", { name: /^#?\s*general/u }).count(), 0, "#general is filtered out");
    await view.getByRole("button", { name: new RegExp(english("workspace.unreads.sort"), "u") }).click();
    await page.getByRole("option", { name: english("workspace.unreads.sortNewest") }).click();
    await shot(page, "desktop-unreads-filter");
  });

  await step(page, viewport, "the shortcuts sheet lists Ctrl+J", async () => {
    await page.keyboard.press("Control+/");
    await page.getByText(english("workspace.shortcuts.firstUnread"), { exact: true }).waitFor({ timeout: UI_WAIT_MS });
    await page.keyboard.press("Escape");
  });
  await context.close();
}

async function phone(browser: Browser, origin: string): Promise<void> {
  const viewport = "phone";
  const context = await browser.newContext(VIEWPORTS.phone);
  const page = await context.newPage();
  watch(page, viewport);

  await step(page, viewport, "the Chat tab lists the DMs, without Back", async () => {
    await load(page, origin, "/app/general", tab(page, "workspace.phone.chat"));
    await tab(page, "workspace.phone.chat").tap();
    await sidebar(page).getByRole("button", { name: /^Ana/u }).first().waitFor({ timeout: UI_WAIT_MS });
    assert.equal(
      await page.getByRole("button", { name: english("workspace.layout.back"), exact: true }).count(),
      0,
      "a tab has no Back",
    );
    await shot(page, "phone-chat-tab");
  });

  await step(page, viewport, "a long press on an unread DM offers Mark as read", async () => {
    const row = sidebar(page).getByRole("button", { name: /^Ana/u }).first();
    const sheet = page.getByRole("dialog");
    await longPress(context, page, row, sheet.getByRole("button", { name: english("workspace.app.channel.markRead") }));
    await shot(page, "phone-dm-actions");
    await sheet.getByRole("button", { name: english("workspace.app.channel.markRead") }).tap();
    await sheet.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });

  await step(page, viewport, "Jump to DMs opens the DMs view", async () => {
    await tab(page, "workspace.phone.chat").tap();
    await button(page, english("workspace.app.menu.search")).first().tap();
    await page.keyboard.type("DMs");
    await page.keyboard.press("Enter");
    await pane(page, english("workspace.view.dms")).waitFor({ timeout: UI_WAIT_MS });
  });

  await step(page, viewport, "the bell of a channel opens its choices in a sheet", async () => {
    await load(page, origin, "/app/general/c/general", pane(page, "general"));
    await button(page, english("workspace.header.notifications", { name: "general" })).tap();
    const sheet = page.getByRole("dialog", { name: english("workspace.header.notifications", { name: "general" }) });
    await sheet.getByRole("button", { name: english("workspace.header.notifyMentions") }).waitFor({
      timeout: UI_WAIT_MS,
    });
    await shot(page, "phone-bell-sheet");
    await sheet.getByRole("button", { name: english("workspace.header.notifyMentions") }).tap();
    await sheet.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });

  await step(page, viewport, "a thread has Back and no close button", async () => {
    await load(page, origin, "/app/general/c/general/t/general-root", pane(page, english("workspace.thread.title")));
    const thread = pane(page, english("workspace.thread.title"));
    await thread.getByRole("button", { name: english("workspace.layout.back"), exact: true }).waitFor({
      timeout: UI_WAIT_MS,
    });
    assert.equal(
      await thread.getByRole("button", { name: english("common.close"), exact: true }).isVisible(),
      false,
      "Back is the one way out",
    );
  });

  await step(page, viewport, "the address of Activity opens the Inbox tab", async () => {
    await load(page, origin, "/app/general/activity", pane(page, english("workspace.view.activity")));
    await page.waitForFunction(
      (label) =>
        [...document.querySelectorAll('[aria-current="page"]')].some((element) =>
          (element.getAttribute("aria-label") ?? "").startsWith(label),
        ),
      english("workspace.phone.inbox"),
      { timeout: UI_WAIT_MS },
    );
    assert.equal(
      await pane(page, english("workspace.view.activity"))
        .getByRole("button", { name: english("workspace.layout.back"), exact: true })
        .count(),
      0,
      "a tab has no Back",
    );
  });

  await step(page, viewport, "Search from More takes the focus", async () => {
    await load(page, origin, "/app/general", tab(page, "workspace.view.today"));
    // More opens from the account button of Today.
    await tab(page, "workspace.view.today").tap();
    await button(page, english("workspace.phone.more")).tap();
    await button(page, english("workspace.view.search")).tap();
    await page.waitForFunction(
      (label) => document.activeElement?.getAttribute("aria-label") === label,
      english("workspace.search.placeholder"),
      { timeout: UI_WAIT_MS },
    );
  });
  await context.close();
}

function watch(page: Page, viewport: ViewportName): void {
  page.on("pageerror", (error) => report.pageErrors.push(`${viewport}: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    // The dev server's own socket is no part of the client: a page left during a step drops it.
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
  await desktop(browser, origin);
  await phone(browser, origin);
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
