// Checks the web client's phone shell with the on-screen keyboard, as Safari on an iPhone shows it:
// the header stays at the top of the visible part of the screen, the messages fill the room, and the
// message box sits on the keyboard, with a short and a long draft, with the @ list open, and after the
// keyboard closes. In landscape it checks that the app takes the visible part. It also takes a
// screenshot of Chrome on Android, which shrinks the page.
//
// Chromium has no iOS keyboard, so the page gets a model of one: `window.visualViewport` is replaced
// by an object that does what Safari's does. When a text field takes the focus, the visible height
// shrinks by the keyboard, and the visible part pans down (`offsetTop`) until the field shows over
// the keyboard; it pans again when the caret leaves the visible part. The layout viewport keeps its
// full height, as in Safari. The safe-area insets come from Chromium's override. The screenshots
// show what the phone shows: the visible part, a status bar, and the keyboard under it.
//
// It serves the web client on a mock host (`src/renderer/stories/web-client-inbox-harness.tsx`).
//
// `bun scripts/web-phone-keyboard-e2e.ts [--browser-executable=<path>] [--headed] [--out=<dir>]`
// Writes report.json and the screenshots to .openbot-build/web-phone-keyboard-e2e, or to --out.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("web-phone-keyboard-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const UI_WAIT_MS = 60_000;
const DM_PATH = "/app/general/dm/chief";
const CHANNEL_PATH = "/app/general/c/general";

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const OUT = resolve(option("out") ?? resolve(ROOT, ".openbot-build/web-phone-keyboard-e2e"));

/** The site's /app page sets the same viewport. */
const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-inbox-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-web-phone-keyboard-harness",
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

/**
 * An iPhone 13 as the app on the Home Screen shows it (`apple-mobile-web-app-status-bar-style:
 * black`): the page starts under the status bar, and the home indicator is in the page.
 */
interface Phone {
  name: string;
  /** The page's size: the screen without the status bar. */
  width: number;
  height: number;
  /** The status bar over the page, drawn in the screenshot only. */
  statusBar: number;
  /** The keyboard with its accessory bar, from the bottom of the screen. */
  keyboard: number;
  insets: { top: number; right: number; bottom: number; left: number };
}

const PORTRAIT: Phone = {
  name: "portrait",
  width: 390,
  height: 797,
  statusBar: 47,
  keyboard: 336,
  insets: { top: 0, right: 0, bottom: 34, left: 0 },
};
const LANDSCAPE: Phone = {
  name: "landscape",
  width: 844,
  height: 390,
  statusBar: 0,
  keyboard: 206,
  insets: { top: 0, right: 47, bottom: 21, left: 47 },
};

/** The model of Safari's visual viewport and keyboard. It runs in the page before the app. */
function installKeyboardModel(keyboard: number): void {
  const state = { open: false, height: window.innerHeight, offsetTop: 0 };
  class FakeVisualViewport extends EventTarget {
    get width() {
      return window.innerWidth;
    }
    get height() {
      return state.height;
    }
    get offsetTop() {
      return state.offsetTop;
    }
    get offsetLeft() {
      return 0;
    }
    get pageTop() {
      return window.scrollY + state.offsetTop;
    }
    get pageLeft() {
      return window.scrollX;
    }
    get scale() {
      return 1;
    }
    onresize = null;
    onscroll = null;
  }
  const viewport = new FakeVisualViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });
  const editable = (node: Element | null) =>
    node?.matches("input:not([type='checkbox'], [type='radio']), textarea, [contenteditable='true']") ?? false;
  /** The caret's box, or the field's when it has no caret. */
  const caretRect = (): DOMRect | null => {
    const active = document.activeElement;
    if (!active || !editable(active)) return null;
    const selection = document.getSelection();
    if (selection && selection.rangeCount > 0 && active.contains(selection.anchorNode)) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.height > 0) return rect;
    }
    const rect = active.getBoundingClientRect();
    return new DOMRect(rect.left, Math.max(rect.top, rect.bottom - 24), rect.width, Math.min(24, rect.height));
  };
  /** Safari pans the visible part until the caret shows, with a small margin. */
  const reveal = () => {
    const rect = caretRect();
    if (!rect) return false;
    const max = Math.max(0, window.innerHeight - state.height);
    let next = state.offsetTop;
    if (rect.bottom + 12 > state.offsetTop + state.height) next = rect.bottom + 12 - state.height;
    else if (rect.top - 12 < state.offsetTop) next = rect.top - 12;
    next = Math.round(Math.min(max, Math.max(0, next)));
    if (next === state.offsetTop) return false;
    state.offsetTop = next;
    return true;
  };
  const fire = (type: "resize" | "scroll") => viewport.dispatchEvent(new Event(type));
  const open = () => {
    if (state.open) return;
    state.open = true;
    state.height = window.innerHeight - keyboard;
    reveal();
    fire("resize");
    fire("scroll");
  };
  const close = () => {
    if (!state.open) return;
    state.open = false;
    state.height = window.innerHeight;
    state.offsetTop = 0;
    fire("resize");
    fire("scroll");
  };
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof Element && editable(event.target)) setTimeout(open, 30);
  });
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!editable(document.activeElement)) close();
    }, 30);
  });
  // Safari keeps the caret in view while the user types.
  const follow = () =>
    requestAnimationFrame(() => {
      if (state.open && reveal()) fire("scroll");
    });
  document.addEventListener("input", follow);
  document.addEventListener("selectionchange", follow);
  // Chrome on Android resizes the page itself (`keyboard` is 0 there).
  window.addEventListener("resize", () => {
    state.height = window.innerHeight - (state.open ? keyboard : 0);
    fire("resize");
  });
}

interface Step {
  phone: string;
  name: string;
  passed: boolean;
  detail?: string;
}

const report: { steps: Step[]; pageErrors: string[]; screenshots: string[]; passed: boolean } = {
  steps: [],
  pageErrors: [],
  screenshots: [],
  passed: false,
};

async function step(phone: Phone, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ phone: phone.name, name, passed: true });
  } catch (error) {
    report.steps.push({ phone: phone.name, name, passed: false, detail: String(error).slice(0, 800) });
  }
}

interface Visible {
  open: boolean;
  height: number;
  offsetTop: number;
}

const visible = (page: Page): Promise<Visible> =>
  page.evaluate(() => {
    // The model's viewport: the keyboard is open while the visible part is shorter than the page.
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    return { open: window.innerHeight - height > 100, height, offsetTop: viewport?.offsetTop ?? 0 };
  });

/** Waits for the keyboard to open or close, and for the app to follow it. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(250);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** What the phone shows: the status bar, the visible part of the page, and the keyboard. */
async function phoneShot(browser: Browser, page: Page, phone: Phone, label: string): Promise<void> {
  const view = await visible(page);
  const clip = { x: 0, y: view.offsetTop, width: phone.width, height: view.height };
  const image = (await page.screenshot({ clip })).toString("base64");
  const screen = phone.statusBar + phone.height;
  const keyboard = view.open ? phone.keyboard : 0;
  const composite = await browser.newPage({ viewport: { width: phone.width, height: screen }, deviceScaleFactor: 2 });
  await composite.setContent(`<!doctype html><html><body style="margin:0;background:#000;height:${screen}px;position:relative;overflow:hidden;font:600 15px -apple-system,system-ui,sans-serif">
    <div style="height:${phone.statusBar}px;color:#fff;display:flex;align-items:center;padding:0 32px">${phone.statusBar ? "11:31" : ""}</div>
    <img style="position:absolute;top:${phone.statusBar}px;left:0;width:${phone.width}px;height:${view.height}px;display:block" src="data:image/png;base64,${image}">
    ${
      keyboard
        ? `<div style="position:absolute;left:0;right:0;bottom:0;height:${keyboard}px;background:#2b2b2d;border-top:1px solid #444;display:flex;flex-direction:column">
        <div style="height:44px;border-bottom:1px solid #3a3a3c;color:#aaa;display:flex;align-items:center;justify-content:flex-end;padding:0 16px">✓</div>
        <div style="flex:1;display:grid;place-items:center;color:#777">keyboard</div></div>`
        : ""
    }
    <div style="position:absolute;left:50%;bottom:8px;width:134px;height:5px;margin-left:-67px;border-radius:3px;background:#888"></div>
  </body></html>`);
  const file = resolve(OUT, `${phone.name}-${label}.png`);
  await composite.screenshot({ path: file });
  await composite.close();
  report.screenshots.push(file);
}

/** The visible box of a locator, relative to the visible part of the page. */
async function box(page: Page, locator: Locator) {
  const rect = await locator.boundingBox();
  assert.ok(rect, "The element has no box.");
  const view = await visible(page);
  return { top: rect.y - view.offsetTop, bottom: rect.y + rect.height - view.offsetTop, height: rect.height, view };
}

const header = (page: Page) => page.locator(".ws-agent-dm-header, .ws-channel-header").first();
const composer = (page: Page) => page.locator(".composer, .ws-composer").filter({ visible: true }).last();
const editor = (page: Page) => composer(page).locator("[contenteditable='true'], textarea").first();

/** The header shows at the top of the visible part, and the box sits on the keyboard. */
async function checkKeyboardLayout(page: Page, phone: Phone): Promise<void> {
  const top = await box(page, header(page));
  assert.ok(Math.abs(top.top - phone.insets.top) <= 2, `The header is at ${top.top}px, not at the top.`);
  const bottom = await box(page, composer(page));
  const gap = top.view.height - bottom.bottom;
  assert.ok(gap >= 0 && gap <= 24, `The box ends ${gap}px over the keyboard.`);
  const scroll = await page.evaluate(() => ({ x: window.scrollX, width: document.documentElement.scrollWidth }));
  assert.equal(scroll.x, 0, "The page scrolled sideways.");
  assert.ok(scroll.width <= phone.width, `The page is ${scroll.width}px wide.`);
}

async function newPhone(browser: Browser, phone: Phone): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: phone.width, height: phone.height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  await context.addInitScript(installKeyboardModel, phone.keyboard);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: phone.insets }).catch(() => {
    logger.warn("This Chromium has no safe-area override; the insets are 0.");
  });
  return { context, page };
}

async function load(page: Page, url: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(url, { waitUntil: "commit" });
    if (
      await editor(page)
        .waitFor({ timeout: UI_WAIT_MS / 2 })
        .then(
          () => true,
          () => false,
        )
    )
      break;
  }
  await editor(page).waitFor({ timeout: UI_WAIT_MS });
  await settle(page);
}

async function typeDraft(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 0 });
  await settle(page);
}

async function clearDraft(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await settle(page);
}

declare global {
  interface Window {
    /** The harness's connection, from `web-client-inbox-harness.tsx`. */
    harnessConnection?: { drop(holdMs: number): void; sent: { operationId: string; text: string }[] };
    /** The editor this check watches, and how often it stopped taking text. */
    composerNode?: Element;
    composerLocked?: number;
  }
}

/**
 * A phone on a weak network loses and replaces its connection often. The box keeps the focus and
 * takes every key through each loss, its editor stays the same element, and Send while the
 * connection is away waits and sends once it is back.
 */
async function checkTypingThroughReconnects(browser: Browser, page: Page, phone: Phone): Promise<void> {
  const surface = page.locator(".ws-composer .composer-editor-surface").filter({ visible: true }).last();
  await surface.tap();
  await settle(page);
  await surface.evaluate((element) => {
    window.composerNode = element;
    window.composerLocked = 0;
    new MutationObserver(() => {
      if (element.getAttribute("contenteditable") !== "true") window.composerLocked = (window.composerLocked ?? 0) + 1;
    }).observe(element, { attributes: true, attributeFilter: ["contenteditable"] });
  });
  const text = "cuales son los mejores productos para el lanzamiento";
  // A drop every few keys, each held for a while, as a phone between cells sees it.
  for (const [index, character] of [...text].entries()) {
    if (index % 9 === 3) await page.evaluate(() => window.harnessConnection?.drop(500));
    await page.keyboard.type(character);
    await page.waitForTimeout(35);
  }
  await page.waitForTimeout(800);
  await phoneShot(browser, page, phone, "09-channel-typed-through-reconnects");
  await step(phone, "typing through connection drops: every key lands, focus and the editor stay", async () => {
    const result = await surface.evaluate((element) => ({
      text: (element instanceof HTMLElement ? element.innerText : "").replace(/\u00a0/gu, " ").trim(),
      sameNode: window.composerNode === element,
      focused: document.activeElement === element,
      locked: window.composerLocked ?? 0,
    }));
    // Every check in one, so a failure says all that went wrong.
    assert.deepEqual(
      result,
      { text, sameNode: true, focused: true, locked: 0 },
      "Keys typed during a reconnect were lost, or the editor was locked, made again or lost the focus.",
    );
  });

  // Send while the connection is away: the message waits under the conversation, the box is free
  // at once, and the message goes once when the connection is back.
  const sentCount = (message: string) =>
    page.evaluate((body) => window.harnessConnection?.sent.filter((item) => item.text === body).length ?? 0, message);
  const outbox = page.locator(".ws-outbox-message").filter({ visible: true });
  await page.evaluate(() => window.harnessConnection?.drop(2_500));
  await page.waitForTimeout(100);
  await page.locator(".ws-composer button[aria-label='Send']").filter({ visible: true }).last().tap();
  await settle(page);
  await phoneShot(browser, page, phone, "10-channel-sent-while-offline");
  await step(
    phone,
    "Send while offline: the message waits as not sent, and the box is empty and keeps the focus",
    async () => {
      await outbox.first().waitFor({ timeout: 2_000 });
      assert.match((await outbox.first().innerText()).trim(), /^cuales son los mejores productos/u);
      assert.match(await outbox.first().innerText(), /Waiting for the connection/u);
      assert.equal(await sentCount(text), 0, "The host took the message while it was away.");
      assert.equal((await surface.innerText()).trim(), "", "The box kept the sent text.");
      assert.equal(
        await surface.evaluate((element) => document.activeElement === element),
        true,
        "The box lost the focus.",
      );
      // The next message can be written at once.
      await page.keyboard.type("y el precio");
      assert.equal((await surface.innerText()).trim(), "y el precio");
    },
  );
  await step(phone, "back online: the waiting message is delivered exactly once and leaves the outbox", async () => {
    await page.waitForFunction(
      (body) => (window.harnessConnection?.sent.filter((item) => item.text === body).length ?? 0) > 0,
      text,
      { timeout: 20_000 },
    );
    await outbox.first().waitFor({ state: "detached", timeout: 5_000 });
    await page.waitForTimeout(1_000);
    assert.equal(await sentCount(text), 1, "The message went more than once.");
    const transcript = page.locator(".ws-message").filter({ hasText: text });
    assert.equal(await transcript.count(), 1, "The message does not show once in the conversation.");
    assert.equal((await surface.innerText()).trim(), "y el precio", "The draft typed meanwhile changed.");
  });

  // A page that reloads while a message waits keeps it, and sends it once it connects.
  const queued = "mensaje que espera la conexion";
  await clearDraft(page);
  await page.evaluate(() => window.harnessConnection?.drop(60_000));
  await page.waitForTimeout(100);
  await page.keyboard.type(queued);
  await page.locator(".ws-composer button[aria-label='Send']").filter({ visible: true }).last().tap();
  await outbox.first().waitFor({ timeout: 2_000 });
  await page.reload({ waitUntil: "commit" });
  await step(phone, "a reload keeps the waiting message and sends it once on connect", async () => {
    await page.waitForFunction(
      (body) => (window.harnessConnection?.sent.filter((item) => item.text === body).length ?? 0) > 0,
      queued,
      { timeout: UI_WAIT_MS },
    );
    await page.waitForTimeout(1_000);
    assert.equal(await sentCount(queued), 1, "The waiting message went more than once.");
    assert.equal(await outbox.count(), 0, "The sent message still waits.");
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

const LONG_DRAFT = Array.from(
  { length: 9 },
  (_, line) => `Line ${line + 1} of a long draft that wraps on a phone screen`,
).join("\n");

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });

  // Portrait: the agent DM, then a channel.
  {
    const phone = PORTRAIT;
    const { context, page } = await newPhone(browser, phone);
    await load(page, `${origin}${DM_PATH}`);
    await phoneShot(browser, page, phone, "01-dm-idle");
    await step(phone, "the idle DM fills the screen, with the box over the home indicator", async () => {
      const bottom = await box(page, composer(page));
      const gap = phone.height - bottom.bottom;
      assert.ok(gap >= phone.insets.bottom && gap <= phone.insets.bottom + 24, `The box ends ${gap}px over the edge.`);
      const top = await box(page, header(page));
      assert.ok(top.top >= 0 && top.top <= 2, `The header is at ${top.top}px.`);
    });

    await editor(page).tap();
    await settle(page);
    await phoneShot(browser, page, phone, "02-dm-keyboard-empty");
    await step(phone, "with the keyboard open, the header is at the top and the box on the keyboard", async () => {
      assert.equal((await visible(page)).open, true, "The keyboard model did not open.");
      await checkKeyboardLayout(page, phone);
    });

    await typeDraft(page, "Can you check the plan?");
    await phoneShot(browser, page, phone, "03-dm-keyboard-short-draft");
    await step(phone, "a short draft keeps the layout", () => checkKeyboardLayout(page, phone));

    await clearDraft(page);
    for (const [index, line] of LONG_DRAFT.split("\n").entries()) {
      if (index > 0) await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(line, { delay: 0 });
    }
    await settle(page);
    await phoneShot(browser, page, phone, "04-dm-keyboard-long-draft");
    await step(phone, "a long draft grows the box up to a limit, and the header stays", async () => {
      await checkKeyboardLayout(page, phone);
      const height = (await box(page, composer(page))).height;
      const view = await visible(page);
      assert.ok(height <= view.height * 0.6, `The box is ${height}px high in ${view.height}px.`);
    });

    await clearDraft(page);
    await typeDraft(page, "@");
    await phoneShot(browser, page, phone, "05-dm-keyboard-mention");
    await step(phone, "the @ list shows over the box, in the visible part", async () => {
      const list = page.locator(".mention-picker, [role='listbox']").filter({ visible: true }).first();
      if ((await list.count()) === 0) return;
      const rect = await box(page, list);
      assert.ok(rect.top >= 0, `The list starts ${-rect.top}px over the visible part.`);
      assert.ok(rect.bottom <= rect.view.height, "The list goes under the keyboard.");
    });
    await page.keyboard.press("Escape");
    await clearDraft(page);

    // The keyboard closes: Done in the accessory bar blurs the field.
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await settle(page);
    await phoneShot(browser, page, phone, "06-dm-after-dismiss");
    await step(phone, "after the keyboard closes, the app fills the screen again", async () => {
      assert.equal((await visible(page)).open, false);
      const bottom = await box(page, composer(page));
      const gap = phone.height - bottom.bottom;
      assert.ok(gap >= phone.insets.bottom && gap <= phone.insets.bottom + 24, `The box ends ${gap}px over the edge.`);
      const scroll = await page.evaluate(() => window.scrollY);
      assert.equal(scroll, 0);
    });

    await load(page, `${origin}${CHANNEL_PATH}`);
    await phoneShot(browser, page, phone, "07-channel-idle");
    await editor(page).tap();
    await typeDraft(page, "Morning all");
    await phoneShot(browser, page, phone, "08-channel-keyboard");
    await step(phone, "a channel with the keyboard open", () => checkKeyboardLayout(page, phone));
    await clearDraft(page);
    await checkTypingThroughReconnects(browser, page, phone);
    await context.close();
  }

  // Landscape: the keyboard leaves a small height.
  {
    const phone = LANDSCAPE;
    const { context, page } = await newPhone(browser, phone);
    await load(page, `${origin}${DM_PATH}`);
    await phoneShot(browser, page, phone, "01-dm-idle");
    await editor(page).tap();
    await typeDraft(page, "Landscape draft");
    await phoneShot(browser, page, phone, "02-dm-keyboard");
    // A phone on its side is wider than 720px but has no height for the computer's layout, so it
    // takes the phone layout (`PHONE_LAYOUT_QUERY`): the DM fills the screen, with no sidebar.
    await step(phone, "landscape: the phone layout, with the header on top and the box on the keyboard", async () => {
      const sidebar = await page
        .locator(".ws-layout-sidebar, .web-app-frame > .sidebar")
        .filter({ visible: true })
        .count();
      assert.equal(sidebar, 0, "A sidebar shows beside the DM.");
      await checkKeyboardLayout(page, phone);
    });
    await step(phone, "landscape: the app takes the visible part", async () => {
      const view = await visible(page);
      const app = await page.locator(".web-app").boundingBox();
      assert.ok(app, "The app has no box.");
      assert.ok(
        Math.abs(app.y - view.offsetTop) <= 1 && Math.abs(app.height - view.height) <= 1,
        "The app is not the visible part.",
      );
    });
    await context.close();
  }

  // Android Chrome: `interactive-widget=resizes-content` shrinks the page itself.
  {
    const phone: Phone = {
      ...PORTRAIT,
      name: "android",
      keyboard: 0,
      statusBar: 24,
      height: 820,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    const { context, page } = await newPhone(browser, phone);
    await load(page, `${origin}${DM_PATH}`);
    await editor(page).tap();
    await page.setViewportSize({ width: phone.width, height: phone.height - 300 });
    await typeDraft(page, "Android draft");
    await phoneShot(browser, page, phone, "02-dm-keyboard");
    await step(phone, "Android: the box sits on the keyboard", () =>
      checkKeyboardLayout(page, { ...phone, height: phone.height - 300 }),
    );
    await context.close();
  }

  report.passed = report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
for (const item of report.steps)
  logger.info(
    `${item.passed ? "ok  " : "FAIL"} ${item.phone}: ${item.name}${item.detail ? `\n     ${item.detail}` : ""}`,
  );
logger.info(`${report.passed ? "Passed" : "Failed"}. Report: ${resolve(OUT, "report.json")}`);
process.exit(report.passed ? 0 : 1);
