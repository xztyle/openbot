// Checks that a right-click or a long press on a message offers the actions of what it landed on,
// before the message's own actions, in the web client on a mock host: an image offers Copy image,
// Save image and Open; a link offers Open and Copy link; a code block offers Copy code, and the copy
// lands on the clipboard; selected text offers Copy; the author's face offers View profile and Direct
// message. The message's items follow in every case. Shift+F10 on a focused row opens the row's menu.
// In the owner's chat with an agent (`src/renderer/stories/web-client-context-menu-harness.tsx`), an
// image of a row of five, a single image of the agent and an image of the owner each offer Copy image
// and Annotate, and the video, PDF, document and ZIP cards offer their actions. A right-click on a
// space, the General space included, shows the space's actions. No menu ever opens with no item: the
// check sweeps the messages, images, files, links, code, channels, DMs, agents, spaces, sidebar rows,
// Today cards and the Motion strip. On an iPhone a long press opens the same items in a sheet.
//
// The harnesses run as a production build, as the site serves the client: the empty menus of
// 2026-11-26 showed only there (a lucide icon read its context outside an owner, which a development
// build allows). `--dev` serves them through Vite's development server instead.
//
// `bun scripts/web-context-menu-e2e.ts [--browser-executable=<path>] [--headed] [--out=<dir>] [--shots] [--dev]`
// Writes report.json to .openbot-build/web-context-menu-e2e, or to --out; `--shots` also keeps a
// screenshot of each menu, in light and in dark.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright-core";
import { build, createServer, type Plugin } from "vite";

declare global {
  interface Window {
    /** The names of the menus that opened with no item. */
    harnessEmptyMenus?: string[];
  }
}

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

/** The pages of the check: each is a story harness that the script serves at every address under `/app`. */
const HARNESSES = {
  /** #general with images, a PDF and a CSV (the `ChannelMedia` story). */
  media: "web-client-media-harness",
  /** The owner's chat with Research: a row of five images, one image each of the agent and the owner, files. */
  menu: "web-client-context-menu-harness",
  /** The spaces workspace: General, Trading and Piks on the rail. */
  spaces: "web-client-harness",
  /** Today with things that wait for the owner. */
  today: "web-client-today-harness",
} as const;
type HarnessName = keyof typeof HARNESSES;
const HARNESS_NAMES: readonly HarnessName[] = ["media", "menu", "spaces", "today"];

function harnessHtml(name: HarnessName): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/${HARNESSES[name]}.tsx"></script>
  </body>
</html>`;
}

const SITE_SOURCE = resolve(OUT, "site-source");
const SITE = resolve(OUT, "site");
const FIXTURES = resolve(ROOT, "scripts/fixtures");

/** Builds every harness for production, as the site's client is built. */
async function buildSite(): Promise<void> {
  mkdirSync(SITE_SOURCE, { recursive: true });
  const input: Record<string, string> = {};
  for (const name of HARNESS_NAMES) {
    const html = resolve(SITE_SOURCE, `${name}.html`);
    writeFileSync(html, harnessHtml(name));
    input[name] = html;
  }
  await build({
    root: ROOT,
    configFile: false,
    cacheDir: "node_modules/.vite-e2e/web-context-menu-e2e",
    logLevel: "error",
    base: "/",
    plugins: [tailwindcss(), solidPlugin()],
    resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
    build: { outDir: SITE, emptyOutDir: true, minify: true, chunkSizeWarningLimit: 100_000, rollupOptions: { input } },
  });
}

/** The built page of a harness at every address under `/app`; its assets; the fixture files under `/__fixtures/`. */
function serveBuilt(name: HarnessName): { origin: string; stop: () => void } {
  const page = resolve(SITE, relative(ROOT, SITE_SOURCE), `${name}.html`);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      if (/^\/app(?:\/|$)/u.test(path))
        return new Response(Bun.file(page), { headers: { "Content-Type": "text/html" } });
      const file = path.startsWith("/__fixtures/")
        ? resolve(FIXTURES, path.slice("/__fixtures/".length))
        : resolve(SITE, `.${path}`);
      const inside = file.startsWith(`${path.startsWith("/__fixtures/") ? FIXTURES : SITE}/`);
      const found = inside ? Bun.file(file) : null;
      return found && (await found.exists()) ? new Response(found) : new Response("Not found", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}

/** The development server: the harness named by the `?harness=` of the first address, under `/app`. */
function devPages(name: HarnessName): Plugin {
  return {
    name: `openbot-web-context-menu-${name}`,
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        if (url.startsWith("/__fixtures/")) {
          request.url = `/@fs${FIXTURES}/${url.slice("/__fixtures/".length)}`;
          return next();
        }
        if (!/^\/app(?:[/?]|$)/u.test(url)) return next();
        const html = await server.transformIndexHtml(url, harnessHtml(name));
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      });
    },
  };
}

async function serveDev(name: HarnessName): Promise<{ origin: string; stop: () => void }> {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    // A cache of its own: the deploy suite runs several scripts at once, and a server that
    // rebuilds a shared cache for its own entries pulls the modules from under the others.
    cacheDir: `node_modules/.vite-e2e/web-context-menu-e2e-${name}`,
    appType: "custom",
    logLevel: "error",
    plugins: [devPages(name), tailwindcss({ optimize: false }), solidPlugin()],
    resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
    optimizeDeps: {
      entries: [`src/renderer/stories/${HARNESSES[name]}.tsx`],
      include: ["@norbert_bodziony/bloub"],
    },
    server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object", "The harness server has no port.");
  return { origin: `http://127.0.0.1:${address.port}`, stop: () => void server.close() };
}

const origins = new Map<HarnessName, string>();
const stops: (() => void)[] = [];
async function originOf(name: HarnessName): Promise<string> {
  const known = origins.get(name);
  if (known) return known;
  const served = flag("dev") ? await serveDev(name) : serveBuilt(name);
  origins.set(name, served.origin);
  stops.push(served.stop);
  return served.origin;
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

interface PageOptions {
  harness?: HarnessName;
  path?: string;
  /** What shows once the page is ready. */
  ready?: string;
}

async function newPage(browser: Browser, phone: boolean, dark = false, options: PageOptions = {}): Promise<Page> {
  const context: BrowserContext = await browser.newContext({
    ...(phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } }),
    colorScheme: dark ? "dark" : "light",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  // Every menu that opens with no item, for the whole life of the page.
  await context.addInitScript(() => {
    const empty: string[] = [];
    window.harnessEmptyMenus = empty;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const menus = [...(node.matches("[role=menu]") ? [node] : []), ...node.querySelectorAll("[role=menu]")];
          for (const menu of menus)
            setTimeout(() => {
              if (menu.isConnected && menu.querySelectorAll("[role^=menuitem]").length === 0)
                empty.push(menu.getAttribute("aria-label") ?? "(no name)");
            }, 400);
        }
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  const origin = await originOf(options.harness ?? "media");
  await page.goto(`${origin}${options.path ?? CHANNEL_PATH}`, { waitUntil: "commit", timeout: UI_WAIT_MS });
  // The pictures show once their small copies are read through the host connection.
  await page
    .locator(options.ready ?? ".ws-layout-main [data-attachment-id] img[src]")
    .first()
    .waitFor({ timeout: UI_WAIT_MS });
  return page;
}

/** The names of the menus that opened with no item on this page. */
async function emptyMenus(page: Page): Promise<string[]> {
  return page.evaluate(() => window.harnessEmptyMenus ?? []);
}

/** The menus that show now, with the number of their items. */
async function openMenus(page: Page): Promise<{ label: string; items: number }[]> {
  return page.locator("[role=menu]").evaluateAll((menus) =>
    menus.map((node) => ({
      label: node.getAttribute("aria-label") ?? "",
      items: node.querySelectorAll("[role^=menuitem]").length,
    })),
  );
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

/** A finger held on `target` for longer than a long press. */
async function hold(page: Page, target: Locator): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert.ok(box, "The target has no box.");
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await page.waitForTimeout(HOLD_MS);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
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

  await step(device, "a long press on an image opens a sheet with the image's actions first", async () => {
    await hold(page, main(page).locator("[data-attachment-id] img[src]").first());
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
    await hold(page, main(page).locator(".ws-message .ws-message-text, .ws-message .message-copy p").first());
    await sheet(page).waitFor({ timeout: 5_000 });
    const items = await sheet(page).locator(".ui-sheet-item").allInnerTexts();
    assert.equal(items[0], MESSAGE_ITEM, `The sheet starts with ${items[0]}.`);
    await page.keyboard.press("Escape");
    await sheet(page).waitFor({ state: "hidden", timeout: 5_000 });
  });

  await page.context().close();
}

/** The chat row's own first item: Reply, which quotes the message. */
const CHAT_ITEM = english("chat.menu.reply");
const AGENT_CHAT = "/app/general/dm/research";
const IMAGE_ACTIONS = [
  english("workspace.context.copyImage"),
  english("workspace.context.saveImage"),
  english("common.open"),
  english("workspace.context.annotate"),
];

/** The three images of the owner's report: one of a row of five, the agent's single one, the owner's. */
function chatImages(page: Page): [string, Locator][] {
  const row = (text: string) => page.locator(".ws-message").filter({ hasText: text });
  return [
    ["an image of a row of five", page.locator(".image-gallery-tile img[src]").nth(2)],
    ["the agent's single image", row("Y la portada.").locator("img[src]").first()],
    ["the owner's image", row("Esta es la foto del local.").locator("img[src]").first()],
  ];
}

async function checkAgentChat(browser: Browser, dark: boolean): Promise<void> {
  const device = dark ? "desktop-dark" : "desktop";
  const page = await newPage(browser, false, dark, {
    harness: "menu",
    path: AGENT_CHAT,
    ready: ".image-gallery-tile img[src]",
  });
  for (const [name, image] of chatImages(page))
    await step(
      device,
      `a right-click on ${name} offers Copy image and Annotate, then the message's actions`,
      async () => {
        await image.waitFor({ timeout: UI_WAIT_MS });
        await rightClick(image);
        const items = await menuItems(page);
        await shot(page, `${device}-${name.replaceAll(/\W+/gu, "-")}`);
        assert.deepEqual(items.slice(0, IMAGE_ACTIONS.length), IMAGE_ACTIONS, `The items: ${items.join(", ")}`);
        assert.ok(items.includes(CHAT_ITEM), `The message's actions are missing: ${items.join(", ")}`);
        assert.equal(await dividedBefore(page, CHAT_ITEM), true, "No divider before the message's actions.");
        await closeMenu(page);
      },
    );

  await step(device, "Annotate in the menu of an image of the row opens the image editor", async () => {
    await rightClick(page.locator(".image-gallery-tile img[src]").first());
    await menu(page)
      .getByRole("menuitem", { name: english("workspace.context.annotate") })
      .click();
    const editor = page.locator(".image-annotator");
    await editor.waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "hidden", timeout: 5_000 });
  });

  await step(
    device,
    "a right-click on a video, a PDF, a document and a ZIP card offers the file's actions",
    async () => {
      const cards = page.locator(".message-attachment");
      assert.equal(await cards.count(), 4, "The four file cards do not show.");
      for (let index = 0; index < 4; index++) {
        const card = cards.nth(index);
        await rightClick(card.locator("strong").first());
        const items = await menuItems(page);
        const view = await card.getAttribute("data-view");
        assert.ok(items.includes(english("common.download")), `${view}: ${items.join(", ")}`);
        assert.ok(
          items.includes(english("common.open")) || items.includes(english("workspace.context.viewContents")),
          `${view}: ${items.join(", ")}`,
        );
        assert.ok(items.includes(CHAT_ITEM), `${view}: the message's actions are missing.`);
        await closeMenu(page);
      }
    },
  );

  await step(device, "no menu opened empty in the chat", async () => {
    assert.deepEqual(await emptyMenus(page), []);
  });
  await page.context().close();
}

async function checkSpaces(browser: Browser): Promise<void> {
  const device = "desktop";
  const page = await newPage(browser, false, false, {
    harness: "spaces",
    path: "/app/general/c/general",
    ready: ".space-rail-button",
  });
  for (const name of ["General", "Trading"])
    await step(device, `a right-click on the ${name} space shows the space's actions`, async () => {
      await rightClick(page.locator(`.space-rail-button[aria-label^="${name}"]`).first());
      const spaceMenu = page.getByRole("menu", { name: english("workspace.spaces.menu", { name }) });
      await spaceMenu.waitFor({ timeout: 5_000 });
      const items = await spaceMenu.getByRole("menuitem").allInnerTexts();
      await shot(page, `${device}-space-${name}`);
      assert.ok(items.includes(english("workspace.spaces.agents")), `The items: ${items.join(", ")}`);
      await page.keyboard.press("Escape");
      await spaceMenu.waitFor({ state: "hidden", timeout: 5_000 });
    });
  await page.context().close();
}

interface Surface {
  name: string;
  selector: string;
  /** A menu must open there. Otherwise only an empty menu fails: the browser's own menu may show. */
  required: boolean;
}

/** Every surface of the workspace that a right-click can land on, by page. */
const SURFACES: { harness: HarnessName; path: string; ready: string; surfaces: Surface[] }[] = [
  {
    harness: "media",
    path: CHANNEL_PATH,
    ready: ".ws-layout-main [data-attachment-id] img[src]",
    surfaces: [
      { name: "a message's text", selector: ".ws-layout-main .ws-message .ws-message-text", required: true },
      { name: "a channel image", selector: ".ws-layout-main [data-attachment-id] img[src]", required: true },
      { name: "a channel file", selector: ".ws-layout-main .message-attachment strong", required: true },
      { name: "a link", selector: ".ws-layout-main a.message-link", required: true },
      { name: "a code block", selector: ".ws-layout-main .message-code-header", required: true },
      { name: "a channel row", selector: ".ws-sidebar-row:has-text('general')", required: true },
      { name: "a DM row", selector: ".ws-sidebar-row:has-text('Ana')", required: true },
      { name: "an agent row", selector: ".ws-sidebar-row:has-text('Research')", required: true },
      { name: "a space", selector: ".space-rail-button", required: true },
      { name: "the channel header", selector: ".ws-channel-pane > :first-child", required: false },
      { name: "the sidebar's free area", selector: ".ws-sidebar", required: false },
    ],
  },
  {
    harness: "media",
    path: "/app/general/c/dm-ana",
    ready: ".ws-message",
    surfaces: [{ name: "a DM message", selector: ".ws-message .ws-message-text", required: true }],
  },
  {
    harness: "menu",
    path: AGENT_CHAT,
    ready: ".image-gallery-tile img[src]",
    surfaces: [
      { name: "an image of a row", selector: ".image-gallery-tile img[src]", required: true },
      { name: "a file of an agent", selector: ".ws-chat-row .message-attachment strong", required: true },
      { name: "an agent's message", selector: ".ws-chat-row .message-copy p", required: true },
      { name: "the agent's face", selector: ".ws-chat-row .ws-message-gutter .ws-profile-trigger", required: true },
      { name: "the Motion strip", selector: ".ws-agent-dm-wait", required: false },
      { name: "the Motion ticket", selector: ".ws-channel-header-ticket", required: false },
    ],
  },
  {
    harness: "today",
    path: "/app/general/today",
    ready: ".ws-today-card",
    surfaces: [
      { name: "a Today card", selector: ".ws-today-card", required: false },
      { name: "a Motion ticket on Today", selector: ".ws-ticket-chip-key", required: false },
    ],
  },
];

async function checkNeverEmpty(browser: Browser): Promise<void> {
  for (const area of SURFACES) {
    const page = await newPage(browser, false, false, area);
    for (const surface of area.surfaces)
      await step("desktop", `no empty menu: ${surface.name}`, async () => {
        const target = page.locator(surface.selector).first();
        if ((await target.count()) === 0) {
          assert.ok(!surface.required, `${surface.selector} is not on ${area.path}.`);
          logger.info(`absent: ${surface.name}`);
          return;
        }
        await target.hover().catch(() => undefined);
        await rightClick(target);
        await page.waitForTimeout(400);
        const menus = await openMenus(page);
        assert.ok(
          menus.every((shown) => shown.items > 0),
          `A menu opened with no item: ${JSON.stringify(menus)}`,
        );
        assert.ok(menus.length <= 1, `Two menus opened: ${JSON.stringify(menus)}`);
        if (surface.required) assert.equal(menus.length, 1, "No menu opened.");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
      });
    await step("desktop", `no menu opened empty on ${area.path}`, async () => {
      assert.deepEqual(await emptyMenus(page), []);
    });
    await page.context().close();
  }
}

async function checkPhoneAgentChat(browser: Browser): Promise<void> {
  const device = "phone";
  const page = await newPage(browser, true, false, {
    harness: "menu",
    path: AGENT_CHAT,
    ready: ".image-gallery-tile img[src]",
  });
  for (const [name, image] of chatImages(page))
    await step(device, `a long press on ${name} opens a sheet with Copy image and Annotate`, async () => {
      await image.waitFor({ timeout: UI_WAIT_MS });
      await hold(page, image);
      await sheet(page).waitFor({ timeout: 5_000 });
      const items = await sheet(page).locator(".ui-sheet-item").allInnerTexts();
      await shot(page, `${device}-${name.replaceAll(/\W+/gu, "-")}`);
      assert.deepEqual(items.slice(0, IMAGE_ACTIONS.length), IMAGE_ACTIONS, `The items: ${items.join(", ")}`);
      assert.ok(items.includes(CHAT_ITEM), `The message's actions are missing: ${items.join(", ")}`);
      await page.keyboard.press("Escape");
      await sheet(page).waitFor({ state: "hidden", timeout: 5_000 });
    });
  await step(device, "a long press on a file card opens a sheet with the file's actions", async () => {
    await hold(page, page.locator(".message-attachment strong").nth(1));
    await sheet(page).waitFor({ timeout: 5_000 });
    const items = await sheet(page).locator(".ui-sheet-item").allInnerTexts();
    assert.ok(items.includes(english("common.download")), `The items: ${items.join(", ")}`);
    await page.keyboard.press("Escape");
    await sheet(page).waitFor({ state: "hidden", timeout: 5_000 });
  });
  await page.context().close();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
if (!flag("dev")) await buildSite();
let browser: Browser | null = null;

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !flag("headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  await checkDesktop(browser, false);
  await checkAgentChat(browser, false);
  await checkSpaces(browser);
  await checkNeverEmpty(browser);
  await checkPhone(browser, false);
  await checkPhoneAgentChat(browser);
  if (flag("shots")) {
    await checkDesktop(browser, true);
    await checkAgentChat(browser, true);
    await checkPhone(browser, true);
  }
} catch (error) {
  report.steps.push({
    device: "-",
    name: "the check ran to its end",
    passed: false,
    detail: String(error).slice(0, 800),
  });
  logger.error("the check stopped", { error: String(error).slice(0, 800) });
} finally {
  await browser?.close();
  for (const stop of stops) stop();
  report.passed = report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  logger.info(report.passed ? "web-context-menu-e2e passed" : "web-context-menu-e2e failed", { out: OUT });
}
if (!report.passed) process.exit(1);
