// Checks that a right-click or a long press on a message offers the actions of what it landed on,
// before the message's own actions, in the web client on a mock host
// (`src/renderer/stories/web-client-media-harness.tsx`): an image offers Copy image, Save image and
// Open; a link offers Open and Copy link; a code block offers Copy code, and the copy lands on the
// clipboard; selected text offers Copy; the author's face offers View profile and Direct message.
// The message's items follow in every case. Shift+F10 on a focused row opens the row's menu. On an
// iPhone a long press on an image opens the same items in a sheet.
//
// `bun scripts/web-context-menu-e2e.ts [--browser-executable=<path>] [--headed] [--out=<dir>] [--shots]`
// Writes report.json to .openbot-build/web-context-menu-e2e, or to --out; `--shots` also keeps a
// screenshot of each menu, in light and in dark.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("web-context-menu-e2e");
function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** `--root=<checkout>` serves another checkout's web client, such as main for "before" screenshots. */
const ROOT = resolve(option("root") ?? resolve(import.meta.dirname, ".."));
const UI_WAIT_MS = 90_000;
const CHANNEL_PATH = "/app/general/c/general";
/** Longer than the long press (450 ms in `packages/ui/src/long-press.ts`). */
const HOLD_MS = 700;
const english = translateFor("en");

const OUT = resolve(option("out") ?? resolve(ROOT, ".openbot-build/web-context-menu-e2e"));

const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-media-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-web-context-menu-harness",
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
  device: string;
  name: string;
  passed: boolean;
  detail?: string;
}

const report: { steps: Step[]; screenshots: string[]; pageErrors: string[]; passed: boolean } = {
  steps: [],
  screenshots: [],
  pageErrors: [],
  passed: false,
};

async function step(device: string, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ device, name, passed: true });
    logger.info(`ok ${device}: ${name}`);
  } catch (error) {
    report.steps.push({ device, name, passed: false, detail: String(error).slice(0, 800) });
    logger.error(`failed ${device}: ${name}`, { error: String(error).slice(0, 800) });
  }
}

async function shot(page: Page, name: string): Promise<void> {
  if (!flag("shots")) return;
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path });
  report.screenshots.push(path);
}

async function newPage(browser: Browser, phone: boolean, dark = false): Promise<Page> {
  const context: BrowserContext = await browser.newContext({
    ...(phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } }),
    colorScheme: dark ? "dark" : "light",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await page.goto(`${origin}${CHANNEL_PATH}`, { waitUntil: "commit", timeout: UI_WAIT_MS });
  // The pictures show once their small copies are read through the host connection.
  await page.locator(".ws-layout-main [data-attachment-id] img[src]").first().waitFor({ timeout: UI_WAIT_MS });
  return page;
}

const main = (page: Page) => page.locator(".ws-layout-main");
const menu = (page: Page) => page.getByRole("menu", { name: english("workspace.message.more") });
const sheet = (page: Page) => page.locator(".ui-dialog-content.ui-sheet");

/** The labels of the open menu's items, in order. */
async function menuItems(page: Page): Promise<string[]> {
  await menu(page).waitFor({ timeout: 5_000 });
  return menu(page).getByRole("menuitem").allInnerTexts();
}

/** Whether a separator sits between the item at `index - 1` and the one at `index`. */
async function dividedBefore(page: Page, label: string): Promise<boolean> {
  return menu(page).evaluate((node, label) => {
    const children = Array.from(node.children);
    const index = children.findIndex((child) => child.textContent?.trim() === label);
    const before = children[index - 1];
    return index > 0 && (before?.tagName === "HR" || before?.getAttribute("role") === "separator");
  }, label);
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await menu(page)
    .waitFor({ state: "hidden", timeout: 5_000 })
    .catch(() => undefined);
}

async function rightClick(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await target.click({ button: "right" });
}

/** The row's own first item: Reply in thread in a channel. */
const MESSAGE_ITEM = english("workspace.message.reply");

async function checkDesktop(browser: Browser, dark: boolean): Promise<void> {
  const device = dark ? "desktop-dark" : "desktop";
  const page = await newPage(browser, false, dark);
  const image = main(page).locator("[data-attachment-id] img[src]").first();

  await step(device, "a right-click on an image offers the image's actions, then the message's", async () => {
    await rightClick(image);
    const items = await menuItems(page);
    await shot(page, `${device}-image-menu`);
    assert.deepEqual(items.slice(0, 3), [
      english("workspace.context.copyImage"),
      english("workspace.context.saveImage"),
      english("common.open"),
    ]);
    assert.ok(items.includes(MESSAGE_ITEM), `The message's actions are missing: ${items.join(", ")}`);
    assert.ok(items.includes(english("workspace.app.message.copyText")));
    assert.equal(await dividedBefore(page, MESSAGE_ITEM), true, "No divider before the message's actions.");
  });
  await step(device, "Open in the image's menu opens the viewer", async () => {
    await menu(page)
      .getByRole("menuitem", { name: english("common.open"), exact: true })
      .click();
    const viewer = page.locator("[role=dialog] img").first();
    await viewer.waitFor({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "hidden", timeout: 5_000 });
  });

  await step(device, "a right-click on a link offers Open and Copy link, then the message's actions", async () => {
    const link = main(page).locator("a.message-link").first();
    await rightClick(link);
    const items = await menuItems(page);
    assert.deepEqual(items.slice(0, 2), [english("common.open"), english("workspace.app.message.copyLink")]);
    assert.ok(items.includes(MESSAGE_ITEM));
    assert.equal(
      items.filter((item) => item === english("workspace.app.message.copyLink")).length,
      1,
      "Copy link twice.",
    );
    await menu(page)
      .getByRole("menuitem", { name: english("workspace.app.message.copyLink") })
      .click();
    await page.waitForFunction(() => navigator.clipboard.readText().then((text) => text.startsWith("https://")), null, {
      timeout: 5_000,
    });
  });

  await step(device, "a right-click on a code block offers Copy code, which copies the code", async () => {
    // The block is in the last message, under the unread rows: the list scrolls to it first.
    await main(page)
      .getByRole("button", { name: english("workspace.app.channel.jumpToLatest") })
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    const block = main(page).locator(".message-code-block").first();
    await block.scrollIntoViewIfNeeded();
    const state = await block.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hidden: string[] = [];
      for (let el: Element | null = node; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.contentVisibility === "hidden")
          hidden.push(`${el.tagName}.${el.className}`);
      }
      return { rect: [rect.x, rect.y, rect.width, rect.height], hidden };
    });
    assert.ok(
      (state.rect[2] ?? 0) > 0 && (state.rect[3] ?? 0) > 0,
      `The code block has no size: ${JSON.stringify(state)}`,
    );
    await shot(page, `${device}-code-block`);
    await rightClick(block.locator(".message-code-header").first());
    const items = await menuItems(page);
    assert.equal(items[0], english("chat.code.copy"));
    assert.ok(items.includes(MESSAGE_ITEM));
    await shot(page, `${device}-code-menu`);
    await menu(page)
      .getByRole("menuitem", { name: english("chat.code.copy") })
      .click();
    await page.waitForFunction(() => navigator.clipboard.readText().then((text) => text.includes("track.js")), null, {
      timeout: 5_000,
    });
  });

  await step(device, "a right-click on selected text offers Copy first", async () => {
    const text = main(page).locator(".ws-message .message-copy p, .ws-message .ws-message-text").first();
    await text.scrollIntoViewIfNeeded();
    await text.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await rightClick(text);
    const items = await menuItems(page);
    assert.equal(items[0], english("common.copy"));
    assert.ok(items.includes(MESSAGE_ITEM));
    await closeMenu(page);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
  });

  await step(device, "a right-click on the author's face offers View profile and Direct message", async () => {
    const row = main(page)
      .locator(".ws-message:not([data-grouped])")
      .filter({ has: page.locator("img[src]") })
      .first();
    await row.hover();
    const face = row.locator(".ws-message-gutter .ws-profile-trigger").first();
    await rightClick(face);
    const items = await menuItems(page);
    assert.deepEqual(items.slice(0, 2), [
      english("workspace.context.viewProfile"),
      english("workspace.context.directMessage"),
    ]);
    assert.ok(items.includes(MESSAGE_ITEM));
    await shot(page, `${device}-author-menu`);
    await closeMenu(page);
  });

  await step(device, "Shift+F10 on a focused row opens the row's own actions", async () => {
    const row = main(page).locator(".ws-message").first();
    await row.focus();
    await page.keyboard.press("Shift+F10");
    const items = await menuItems(page);
    assert.equal(items[0], MESSAGE_ITEM, `The keyboard menu starts with ${items[0]}.`);
    await closeMenu(page);
  });

  await step(device, "a right-click on a field keeps the browser's menu", async () => {
    const field = main(page)
      .locator(".ws-composer-frame [contenteditable='true'], .ws-composer-frame textarea")
      .first();
    await field.click({ button: "right" });
    await page.waitForTimeout(300);
    assert.equal(await menu(page).count(), 0, "The workspace menu opened over the message box.");
  });

  await page.context().close();
}

async function checkPhone(browser: Browser, dark: boolean): Promise<void> {
  const device = dark ? "phone-dark" : "phone";
  const page = await newPage(browser, true, dark);
  const cdp = await page.context().newCDPSession(page);
  const hold = async (target: Locator) => {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert.ok(box, "The target has no box.");
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await page.waitForTimeout(HOLD_MS);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };

  await step(device, "a long press on an image opens a sheet with the image's actions first", async () => {
    await hold(main(page).locator("[data-attachment-id] img[src]").first());
    await sheet(page).waitFor({ timeout: 5_000 });
    const items = await sheet(page).locator(".ui-sheet-item").allInnerTexts();
    await shot(page, `${device}-image-sheet`);
    assert.deepEqual(items.slice(0, 3), [
      english("workspace.context.copyImage"),
      english("workspace.context.saveImage"),
      english("common.open"),
    ]);
    assert.ok(items.includes(MESSAGE_ITEM), `The message's actions are missing: ${items.join(", ")}`);
    assert.equal((await sheet(page).locator(".ui-sheet-item-row[data-divided]").count()) > 0, true, "No divider.");
    await shot(page, `${device}-image-sheet`);
    await page.keyboard.press("Escape");
    await sheet(page).waitFor({ state: "hidden", timeout: 5_000 });
  });

  await step(device, "a long press on the text opens the message's actions only", async () => {
    await hold(main(page).locator(".ws-message .ws-message-text, .ws-message .message-copy p").first());
    await sheet(page).waitFor({ timeout: 5_000 });
    const items = await sheet(page).locator(".ui-sheet-item").allInnerTexts();
    assert.equal(items[0], MESSAGE_ITEM, `The sheet starts with ${items[0]}.`);
    await page.keyboard.press("Escape");
    await sheet(page).waitFor({ state: "hidden", timeout: 5_000 });
  });

  await page.context().close();
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
    entries: ["src/renderer/stories/web-client-media-harness.tsx"],
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
    headless: !flag("headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  await checkDesktop(browser, false);
  await checkPhone(browser, false);
  if (flag("shots")) {
    await checkDesktop(browser, true);
    await checkPhone(browser, true);
  }
} finally {
  await browser?.close();
  await server.close();
  report.passed = report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  logger.info(report.passed ? "web-context-menu-e2e passed" : "web-context-menu-e2e failed", { out: OUT });
}
if (!report.passed) process.exit(1);
