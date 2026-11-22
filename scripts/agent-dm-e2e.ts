// Checks the owner's DM with an agent as a workspace conversation, on a computer and on an iPhone:
// its messages are workspace rows with the author's name and time; one header row names the agent
// and holds the chat's controls; the action bar's Reply quotes the message in the box; the message
// menu has Copy text and Copy link; the box has the channel's formatting toolbar, and Bold wraps the
// selection; a link to a message opens the DM there, in view; a condensed answer opens the agent's
// original text and closes it again. On a phone: the header keeps one row
// with Back and More at a finger's size, More opens the chat's controls in a sheet, a long press
// opens the actions in a sheet with the quick reactions, and the formatting toolbar shows only
// after "Aa", and a message sent while the host reconnects or the agent restarts waits and goes once,
// while a stopped provider keeps Send off. It serves the web client on a mock host
// (`src/renderer/stories/web-client-inbox-harness.tsx`) and drives it in Chromium. No account
// service, host or provider is needed.
//
// `bun scripts/agent-dm-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/agent-dm-e2e/report.json and a screenshot of each checked screen.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

/** The harness's lost connection and agent phase on demand (`web-client-inbox-harness.tsx`). */
declare global {
  interface Window {
    harnessConnection?: {
      drop(holdMs: number): void;
      phase(phase: "idle" | "starting" | "ready" | "restarting" | "blocked" | "stopped"): void;
      sent: { operationId: string; text: string }[];
    };
  }
}

const logger = createOpenBotLogger("agent-dm-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/agent-dm-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");
const DM_PATH = "/app/general/dm/chief";
/** The newest answer of the harness's chat with Chief. */
const LAST_ANSWER = "I’ll keep the final plan concise, with owners and a clear next action for each milestone.";

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
    name: "openbot-agent-dm-harness",
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
/** A message row, by the label that names its author and time. */
const messages = (page: Page, author: string) =>
  page.getByRole("article", {
    name: new RegExp(`^${author}${english("workspace.message.label", { name: "", time: "" })}`, "u"),
  });
const lastAnswer = (page: Page) => messages(page, "Chief").filter({ hasText: LAST_ANSWER });
/** The DM's header: the one that opens the agent's details. */
const header = (page: Page) =>
  page.locator("header").filter({ has: button(page, english("workspace.header.openDetails", { name: "Chief" })) });
const box = (page: Page) =>
  page.getByRole("textbox", { name: english("composer.placeholder.message", { name: "Chief" }) });

/** How many times the host took a message with this text. */
const sentCount = (page: Page, text: string) =>
  page.evaluate((body) => window.harnessConnection?.sent.filter((item) => item.text === body).length ?? 0, text);

/** The quote of the reply in the box names the message. */
async function quoted(page: Page): Promise<void> {
  const cancel = button(page, english("composer.reply.cancel"));
  await cancel.waitFor({ timeout: UI_WAIT_MS });
  const preview = cancel.locator("xpath=..");
  assert.ok((await preview.innerText()).includes("final plan concise"), "The quote names the message it answers.");
  await cancel.click();
}

/** The header's controls stand in one row: each one's height overlaps every other's. */
async function oneRow(page: Page, names: readonly string[]): Promise<void> {
  const boxes: { top: number; bottom: number }[] = [];
  for (const name of names) {
    const found = await button(header(page), name).first().boundingBox();
    assert.ok(found, `The header has no "${name}".`);
    boxes.push({ top: found.y, bottom: found.y + found.height });
  }
  const top = Math.max(...boxes.map((entry) => entry.top));
  const bottom = Math.min(...boxes.map((entry) => entry.bottom));
  assert.ok(top < bottom, `The header's controls are not in one row: ${JSON.stringify(boxes)}`);
}

/** Back and More are at least as large as a finger, 44px. */
async function fingerSized(page: Page, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const found = await button(header(page), name).first().boundingBox();
    assert.ok(
      found && found.width >= 44 && found.height >= 44,
      `"${name}" is smaller than 44px: ${JSON.stringify(found)}`,
    );
  }
}

/** A long press as a finger makes it: the touch stays down until the sheet shows. */
async function longPress(context: BrowserContext, page: Page, target: Locator, until: Locator): Promise<void> {
  const found = await target.boundingBox();
  assert.ok(found, "The pressed element has no box.");
  const cdp = await context.newCDPSession(page);
  const point = { x: found.x + found.width / 2, y: found.y + Math.min(24, found.height / 2), id: 1 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await until.waitFor({ timeout: UI_WAIT_MS });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function desktop(browser: Browser, origin: string): Promise<void> {
  const viewport = "desktop";
  const context = await browser.newContext({
    ...VIEWPORTS.desktop,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  watch(page, viewport);

  await step(page, viewport, "the DM draws rows with the author's name and time", async () => {
    await load(page, origin, DM_PATH, lastAnswer(page));
    assert.ok((await messages(page, "Chief").count()) >= 2, "The agent's messages are rows named after it.");
    await shot(page, "desktop-dm");
  });

  await step(page, viewport, "one header row names the agent and holds the chat's controls", async () => {
    await oneRow(page, [
      english("workspace.header.openDetails", { name: "Chief" }),
      english("chat.search.label"),
      english("conversation.sidePanel.open"),
    ]);
  });

  await step(page, viewport, "the action bar's Reply quotes the message in the box", async () => {
    await lastAnswer(page).hover();
    await button(lastAnswer(page), english("chat.menu.reply")).click();
    await quoted(page);
    await shot(page, "desktop-reply");
  });

  await step(page, viewport, "a condensed answer opens the agent's original and closes it again", async () => {
    const answer = lastAnswer(page);
    await button(answer, english("workspace.message.showOriginal")).click();
    await answer.getByText("Budget sign-off").waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "desktop-condensed-original");
    await button(answer, english("workspace.message.showCondensed")).click();
    await answer.getByText("Budget sign-off").waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await button(answer, english("workspace.message.showOriginal")).waitFor({ timeout: UI_WAIT_MS });
  });

  await step(page, viewport, "the message menu has Copy text and Copy link", async () => {
    await lastAnswer(page).hover();
    await button(lastAnswer(page), english("workspace.message.more")).click();
    const menu = page.getByRole("menu");
    await menu
      .getByRole("menuitem", { name: english("workspace.app.message.copyText") })
      .waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "desktop-menu");
    await menu.getByRole("menuitem", { name: english("workspace.app.message.copyLink") }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(link, /\/dm\/chief\/m\/message-agent-2$/u, `Copy link names the message: ${link}`);
  });

  await step(page, viewport, "Bold in the box's toolbar wraps the selection", async () => {
    await box(page).click();
    await page.keyboard.type("ship it");
    await page.keyboard.press("Control+a");
    await button(page, english("workspace.composer.bold")).click();
    await page.waitForFunction(
      (label) => document.querySelector(`[aria-label="${label}"]`)?.textContent?.includes("**ship it**") === true,
      english("composer.placeholder.message", { name: "Chief" }),
      { timeout: UI_WAIT_MS },
    );
    await shot(page, "desktop-bold");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
  });

  await step(page, viewport, "a link to a message opens the DM with that message in view", async () => {
    const first = messages(page, ".+").filter({ hasText: "Release notes" }).first();
    await load(page, origin, `${DM_PATH}/m/message-user-1`, first);
    await page.waitForFunction(
      () => {
        const row = document.querySelector('[data-chat-search-message="message-user-1"]');
        const scroller = row?.closest(".conversation-scroll");
        if (!row || !scroller) return false;
        const box = row.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
      },
      null,
      { timeout: UI_WAIT_MS },
    );
    await shot(page, "desktop-linked-message");
  });
  await context.close();
}

async function phone(browser: Browser, origin: string): Promise<void> {
  const viewport = "phone";
  const context = await browser.newContext(VIEWPORTS.phone);
  const page = await context.newPage();
  watch(page, viewport);

  await step(page, viewport, "the DM draws rows, and the header keeps one row", async () => {
    await load(page, origin, DM_PATH, lastAnswer(page));
    await oneRow(page, [english("workspace.layout.back"), english("workspace.message.more")]);
    await fingerSized(page, [english("workspace.layout.back"), english("workspace.message.more")]);
    await shot(page, "phone-dm");
  });

  await step(page, viewport, "More opens the chat's other controls in a sheet", async () => {
    await button(header(page), english("workspace.message.more")).first().tap();
    const sheet = page.getByRole("dialog");
    await button(sheet, english("chat.search.label")).waitFor({ timeout: UI_WAIT_MS });
    await button(sheet, english("conversation.sidePanel.open")).waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "phone-more");
    await button(sheet, english("chat.search.label")).tap();
    await sheet.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await page.keyboard.press("Escape");
  });

  await step(page, viewport, "a long press opens the actions in a sheet, and Reply quotes", async () => {
    const sheet = page.getByRole("dialog");
    await longPress(context, page, lastAnswer(page), sheet);
    await button(sheet, english("workspace.reaction.add", { emoji: "👍" })).waitFor({ timeout: UI_WAIT_MS });
    await button(sheet, english("workspace.app.message.copyText")).waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "phone-sheet");
    await button(sheet, english("chat.menu.reply")).tap();
    await quoted(page);
  });

  await step(
    page,
    viewport,
    "Send while the host reconnects: the message waits and goes once, when it is back",
    async () => {
      const text = "Sent while the host reconnects";
      const sendButton = button(page, english("composer.send.message")).filter({ visible: true }).last();
      const waiting = page.getByText(english("chat.send.waitingForConnection"));
      await box(page).tap();
      await page.evaluate(() => window.harnessConnection?.drop(3_000));
      await page.keyboard.type(text);
      // Send stays on while the connection is away.
      await page.waitForFunction(
        (name) =>
          [...document.querySelectorAll(`button[aria-label="${name}"]`)].some(
            (node) => node instanceof HTMLButtonElement && node.offsetParent !== null && !node.disabled,
          ),
        english("composer.send.message"),
        { timeout: 2_000 },
      );
      await sendButton.tap();
      await waiting.waitFor({ timeout: UI_WAIT_MS });
      assert.equal((await box(page).innerText()).trim(), "", "The box kept the text that was sent.");
      assert.equal(await sentCount(page, text), 0, "The host took the message while it was away.");
      await shot(page, "phone-sent-while-reconnecting");
      await page.waitForFunction(
        (body) => (window.harnessConnection?.sent.filter((item) => item.text === body).length ?? 0) > 0,
        text,
        {
          timeout: UI_WAIT_MS,
        },
      );
      await waiting.waitFor({ state: "detached", timeout: UI_WAIT_MS });
      await messages(page, "Preview User").filter({ hasText: text }).first().waitFor({ timeout: UI_WAIT_MS });
      assert.equal(await sentCount(page, text), 1, "The message went more than once.");
    },
  );

  await step(page, viewport, "a provider that stops keeps Send off; a restart lets a message wait", async () => {
    const text = "Sent while the agent restarts";
    const sendButton = button(page, english("composer.send.message")).filter({ visible: true }).last();
    await box(page).tap();
    await page.keyboard.type(text);
    await page.evaluate(() => window.harnessConnection?.phase("blocked"));
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll(`button[aria-label="${name}"]`)].some(
          (node) => node instanceof HTMLButtonElement && node.offsetParent !== null && node.disabled,
        ),
      english("composer.send.message"),
      { timeout: UI_WAIT_MS },
    );
    await page.evaluate(() => window.harnessConnection?.phase("restarting"));
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll(`button[aria-label="${name}"]`)].some(
          (node) => node instanceof HTMLButtonElement && node.offsetParent !== null && !node.disabled,
        ),
      english("composer.send.message"),
      { timeout: UI_WAIT_MS },
    );
    await sendButton.tap();
    await page.getByText(english("chat.send.waitingForConnection")).waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await sentCount(page, text), 0, "The message went before the agent was ready.");
    await page.evaluate(() => window.harnessConnection?.phase("ready"));
    await page.waitForFunction(
      (body) => (window.harnessConnection?.sent.filter((item) => item.text === body).length ?? 0) > 0,
      text,
      {
        timeout: UI_WAIT_MS,
      },
    );
    assert.equal(await sentCount(page, text), 1, "The message went more than once.");
  });

  await step(page, viewport, "the formatting toolbar shows after Aa", async () => {
    const bold = button(page, english("workspace.composer.bold"));
    assert.equal(await bold.count(), 0, "A phone starts with the formatting toolbar hidden.");
    await button(page, english("workspace.composer.showFormatting")).tap();
    await bold.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "phone-toolbar");
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
