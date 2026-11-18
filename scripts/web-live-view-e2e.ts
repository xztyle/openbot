// Checks that a member on the web client can work in the agent's browser when the agent waits for
// them, on a computer and on an iPhone. It serves the web client on a mock host
// (`src/renderer/stories/web-client-live-view-harness.tsx`), where Chief waits for the reader on a
// sign-up tab. The tab is a real page in a second Chromium page: this script streams its screencast
// to the client as the host's live view does, and sends the client's pointer and key input to it with
// the host's own CDP key table (`src/backend/browser-cdp-input.ts`).
//
// `bun scripts/web-live-view-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/web-live-view-e2e/report.json and a screenshot of each checked screen.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserLiveViewInput } from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, type CDPSession, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";
import { buttonMask, namedKey, SHIFT_MODIFIER } from "../src/backend/browser-cdp-input";

declare global {
  interface Window {
    /** Exposed by this script: the host's side of the harness's live view. */
    openbotLiveViewStart?: (tabId: string) => Promise<void>;
    openbotLiveViewStop?: () => Promise<void>;
    openbotLiveViewInput?: (input: BrowserLiveViewInput) => Promise<void>;
    liveViewHost?: {
      start(tabId: string): Promise<void>;
      stop(): Promise<void>;
      input(input: BrowserLiveViewInput): Promise<void>;
    };
    liveViewBridge?: {
      frame(tabId: string, sequence: number, width: number, height: number, base64: string): void;
      connection(state: "online" | "offline"): void;
    };
    takeoverResponses?: { requestId: string | number; decision: string }[];
  }
}

const logger = createOpenBotLogger("web-live-view-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-live-view-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");
const DM_PATH = "/app/general/dm/chief";
const TAB_ID = "browser-tab-signup";
const TAB_SIZE = { width: 800, height: 600 };

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
    <script type="module" src="/src/renderer/stories/web-client-live-view-harness.tsx"></script>
  </body>
</html>`;

/** The agent's tab: a sign-up form, a button that counts its clicks, and a page taller than the view. */
const TAB_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Create your account</title>
    <style>
      body { font: 18px system-ui, sans-serif; margin: 24px; background: #fff; color: #111; }
      input { font: inherit; width: 320px; padding: 8px; display: block; margin: 8px 0 16px; }
      button { font: inherit; padding: 12px 24px; }
      .tall { height: 1600px; background: linear-gradient(#fff, #ddd); }
    </style>
  </head>
  <body>
    <h1>Create your account</h1>
    <label>Name <input id="name" autocomplete="off" /></label>
    <button id="next" type="button" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1); this.textContent = 'Clicked ' + this.dataset.clicks">Next</button>
    <div class="tall"></div>
    <p id="end">End of page</p>
  </body>
</html>`;

/** Serves the harness at `/app` and every address under it, and the agent's page at `/tab`. */
function harnessPages(): Plugin {
  return {
    name: "openbot-live-view-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        if (url === "/tab") {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(TAB_PAGE);
          return;
        }
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

/**
 * The host's side of the live view for one client page: the screencast of the agent's tab goes to
 * the client, and the client's input goes to the tab as the host dispatches it (`browser-cdp.ts`).
 */
class TabHost {
  readonly inputs: BrowserLiveViewInput[] = [];
  #cdp: CDPSession | null = null;
  #sequence = 0;
  #sizes = new Map<number, { width: number; height: number }>();
  #button: "left" | "middle" | "right" | null = null;
  starts = 0;
  stops = 0;

  constructor(
    readonly tab: Page,
    readonly client: Page,
  ) {}

  async install(): Promise<void> {
    await this.client.exposeFunction("openbotLiveViewStart", (tabId: string) => this.start(tabId));
    await this.client.exposeFunction("openbotLiveViewStop", () => this.stop());
    await this.client.exposeFunction("openbotLiveViewInput", (input: BrowserLiveViewInput) => this.input(input));
    await this.client.addInitScript(() => {
      window.liveViewHost = {
        start: async (tabId) => window.openbotLiveViewStart?.(tabId),
        stop: async () => window.openbotLiveViewStop?.(),
        input: async (input) => window.openbotLiveViewInput?.(input),
      };
    });
  }

  async start(tabId: string): Promise<void> {
    assert.equal(tabId, TAB_ID, "The client watches the tab of the takeover.");
    await this.stop();
    this.starts += 1;
    const cdp = await this.tab.context().newCDPSession(this.tab);
    this.#cdp = cdp;
    cdp.on("Page.screencastFrame", (frame) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      if (this.#cdp !== cdp) return;
      const sequence = ++this.#sequence;
      const size = { width: Math.round(frame.metadata.deviceWidth), height: Math.round(frame.metadata.deviceHeight) };
      this.#sizes.set(sequence, size);
      void this.client
        .evaluate(
          ([tab, number, width, height, data]) => window.liveViewBridge?.frame(tab, number, width, height, data),
          [tabId, sequence, size.width, size.height, frame.data] as const,
        )
        .catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70 });
  }

  async stop(): Promise<void> {
    const cdp = this.#cdp;
    if (cdp) this.stops += 1;
    this.#cdp = null;
    if (!cdp) return;
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }

  async input(input: BrowserLiveViewInput): Promise<void> {
    this.inputs.push(input);
    const cdp = this.#cdp;
    if (!cdp) return;
    if (input.type === "ack" || input.type === "copy" || input.type === "cut") return;
    if (input.type === "paste") {
      await cdp.send("Input.insertText", { text: input.text });
      return;
    }
    if (input.type === "key") {
      const modifiers = input.modifiers ?? 0;
      if (input.action === "char") {
        await cdp.send("Input.dispatchKeyEvent", { type: "char", modifiers, text: input.text ?? "" });
        return;
      }
      const { text, ...codes } = namedKey(input.key);
      const character = input.action === "down" && (modifiers & ~SHIFT_MODIFIER) === 0 ? text : undefined;
      await cdp.send("Input.dispatchKeyEvent", {
        type: input.action === "up" ? "keyUp" : character === undefined ? "rawKeyDown" : "keyDown",
        modifiers,
        key: input.key,
        code: input.code,
        ...codes,
        ...(character === undefined ? {} : { text: character, unmodifiedText: character }),
      });
      return;
    }
    const size = (input.sequence === undefined ? undefined : this.#sizes.get(input.sequence)) ?? TAB_SIZE;
    const x = input.x * size.width;
    const y = input.y * size.height;
    if (input.action === "wheel") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY ?? 0,
        modifiers: input.modifiers ?? 0,
      });
      return;
    }
    const held = this.#button;
    if (input.action === "down") this.#button = input.button;
    if (input.action === "up") this.#button = null;
    await cdp.send("Input.dispatchMouseEvent", {
      type: input.action === "move" ? "mouseMoved" : input.action === "down" ? "mousePressed" : "mouseReleased",
      x,
      y,
      button: input.action === "move" ? (held ?? "none") : input.button,
      buttons:
        input.action === "down" ? buttonMask(input.button) : input.action === "move" && held ? buttonMask(held) : 0,
      clickCount: input.action === "move" ? 0 : (input.clickCount ?? 1),
      modifiers: input.modifiers ?? 0,
    });
  }
}

async function open(browser: Browser, origin: string, viewport: ViewportName) {
  const tabContext = await browser.newContext({ viewport: TAB_SIZE, deviceScaleFactor: 1 });
  const tab = await tabContext.newPage();
  await tab.goto(`${origin}/tab`);
  const context: BrowserContext = await browser.newContext({
    ...VIEWPORTS[viewport],
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  watch(page, viewport);
  const host = new TabHost(tab, page);
  await host.install();
  return { tab, tabContext, context, page, host };
}

const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: typeof name === "string" });
const takeoverCard = (page: Page) =>
  page.getByRole("region", { name: english("prompt.browser.label.pending"), exact: true });

const liveView = (page: Page) => page.getByRole("img", { name: english("browser.liveView.label") }).last();

/** Where a point of the agent's page is on the client's screen: the live view letterboxes the frame. */
async function onScreen(page: Page, tab: Page, selector: string, offset = { x: 0.5, y: 0.5 }) {
  const target = await tab.locator(selector).boundingBox();
  await liveView(page).evaluate((element) => element.scrollIntoView({ block: "center" }));
  const view = await liveView(page).boundingBox();
  assert.ok(target && view, `No box for ${selector} or for the live view.`);
  const scale = Math.min(view.width / TAB_SIZE.width, view.height / TAB_SIZE.height);
  const left = view.x + (view.width - TAB_SIZE.width * scale) / 2;
  const top = view.y + (view.height - TAB_SIZE.height * scale) / 2;
  return {
    x: left + (target.x + target.width * offset.x) * scale,
    y: top + (target.y + target.height * offset.y) * scale,
  };
}

/** Waits until `check(expected)` holds in the agent's page; on a timeout, says what `read` finds. */
async function waitForTab(
  tab: Page,
  check: (expected: string) => boolean,
  read: () => unknown,
  expected: string,
  what: string,
): Promise<void> {
  await tab
    .waitForFunction(check, expected, { timeout: UI_WAIT_MS })
    .catch(async () => assert.fail(`${what}: the page has ${JSON.stringify(await tab.evaluate(read))}.`));
}
const nameValue = () => document.querySelector<HTMLInputElement>("#name")?.value;
const nameIs = (expected: string) => document.querySelector<HTMLInputElement>("#name")?.value === expected;
const nextClicks = () => document.getElementById("next")?.dataset.clicks ?? "0";
const clicksAre = (expected: string) => (document.getElementById("next")?.dataset.clicks ?? "0") === expected;
const scrollTop = () => window.scrollY;
const scrolledPast = (expected: string) => window.scrollY > Number(expected);

/** Waits for a condition of this script's own state, such as what the fake host saw. */
async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + UI_WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(what);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The view shows the page: a frame is drawn and the host has a stream for it. */
async function viewing(page: Page, host: TabHost): Promise<void> {
  await liveView(page).waitFor({ timeout: UI_WAIT_MS });
  await page.waitForFunction(
    (label) => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>(`canvas[aria-label="${label}"]`)];
      return canvases.some((canvas) => !canvas.hidden && canvas.width > 0);
    },
    english("browser.liveView.label"),
    { timeout: UI_WAIT_MS },
  );
  assert.ok(host.starts >= 1, "The client started a live view of the tab.");
}

/** A finger on the client's screen: down, a few moves, and up. */
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 1 }] });
  for (let index = 1; index <= 8; index += 1) {
    const x = from.x + ((to.x - from.x) * index) / 8;
    const y = from.y + ((to.y - from.y) * index) / 8;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Two fingers that move apart. */
async function pinch(page: Page, center: { x: number; y: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const points = (gap: number) => [
    { x: center.x - gap, y: center.y, id: 1 },
    { x: center.x + gap, y: center.y, id: 2 },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(30) });
  for (let gap = 40; gap <= 120; gap += 10)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(gap) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function handedBack(page: Page): Promise<void> {
  await page.waitForFunction(() => (window.takeoverResponses ?? []).length > 0, undefined, { timeout: UI_WAIT_MS });
  const responses = await page.evaluate(() => window.takeoverResponses);
  assert.deepEqual(responses, [{ requestId: "takeover-1", decision: "complete" }], "The takeover ends once, as done.");
}

/** The Browser menu of the DM header opens the agent's tab in the full view, live. */
async function browserFromHeader(page: Page, host: TabHost, touch: boolean): Promise<void> {
  const starts = host.starts;
  const trigger = page.getByRole("button", { name: english("conversation.header.browser", { name: "Chief" }) });
  if (touch) await trigger.tap();
  else await trigger.click();
  const item = page.getByRole("menuitem", { name: /Create your account/u });
  if (touch) await item.tap();
  else await item.click();
  await page
    .getByRole("tabpanel")
    .getByRole("img", { name: english("browser.liveView.label") })
    .waitFor({ timeout: UI_WAIT_MS });
  assert.ok(host.starts > starts, "The full view starts a stream of the tab.");
}

async function phone(browser: Browser, origin: string): Promise<void> {
  const viewport = "phone";
  const { page, host, tab, context, tabContext } = await open(browser, origin, viewport);

  await step(page, viewport, "Take over opens the agent's page full screen", async () => {
    await load(page, origin, DM_PATH, takeoverCard(page));
    await shot(page, "phone-card");
    await button(page, english("prompt.browser.takeOver")).tap();
    await viewing(page, host);
    const view = await liveView(page).boundingBox();
    assert.ok(view && view.width >= 340, `The page takes the phone's width: ${JSON.stringify(view)}.`);
    await shot(page, "phone-live");
  });

  await step(page, viewport, "a tap on a field and the keyboard type into the page", async () => {
    const field = await onScreen(page, tab, "#name");
    await page.touchscreen.tap(field.x, field.y);
    await button(page, english("browser.liveView.keyboard")).tap();
    const keys = page.getByRole("textbox", { name: english("browser.liveView.keyboardInput") });
    await page.waitForFunction(
      (label) => document.activeElement?.getAttribute("aria-label") === label,
      english("browser.liveView.keyboardInput"),
      { timeout: UI_WAIT_MS },
    );
    assert.ok(await keys.count(), "The keyboard field is there.");
    await page.keyboard.type("Ada Lovelacx");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText("e ✓");
    await waitForTab(
      tab,
      nameIs,
      nameValue,
      "Ada Lovelace ✓",
      "The typed text, the Backspace and the composed text reach the field",
    );
    await shot(page, "phone-typed");
  });

  await step(page, viewport, "a tap on a button clicks it", async () => {
    const next = await onScreen(page, tab, "#next");
    await page.touchscreen.tap(next.x, next.y);
    await waitForTab(tab, clicksAre, nextClicks, "1", "One tap is one click");
  });

  await step(page, viewport, "a drag scrolls the page", async () => {
    const view = await liveView(page).boundingBox();
    assert.ok(view);
    const x = view.x + view.width / 2;
    await swipe(page, { x, y: view.y + view.height * 0.8 }, { x, y: view.y + view.height * 0.2 });
    await waitForTab(tab, scrolledPast, scrollTop, "100", "A finger that moves up scrolls the page down");
  });

  await step(page, viewport, "two fingers zoom the view, and Fit undoes it", async () => {
    const view = await liveView(page).boundingBox();
    assert.ok(view);
    await pinch(page, { x: view.x + view.width / 2, y: view.y + view.height / 2 });
    const fit = button(page, english("browser.liveView.fit"));
    await fit.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "phone-zoomed");
    await fit.tap();
    await fit.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });

  await step(page, viewport, "I'm done hands the page back once", async () => {
    await button(page, english("prompt.browser.done")).last().tap();
    await handedBack(page);
  });

  await step(page, viewport, "the DM header's Browser menu opens the agent's tab live", async () => {
    // The full view is open from the takeover; Back returns to the chat first.
    await page.goto(`${origin}${DM_PATH}`, { waitUntil: "commit" });
    await page
      .getByRole("button", { name: english("conversation.header.browser", { name: "Chief" }) })
      .waitFor({ timeout: UI_WAIT_MS });
    await browserFromHeader(page, host, true);
    await shot(page, "phone-header-browser");
  });
  await context.close();
  await tabContext.close();
}

async function desktop(browser: Browser, origin: string): Promise<void> {
  const viewport = "desktop";
  const { page, host, tab, context, tabContext } = await open(browser, origin, viewport);
  const card = () => takeoverCard(page);

  await step(page, viewport, "the card says the agent waits for the reader", async () => {
    await load(page, origin, DM_PATH, card());
    await card()
      .getByRole("status")
      .filter({ hasText: english("prompt.browser.waitingForYou") })
      .waitFor();
    await shot(page, "desktop-card");
  });

  await step(page, viewport, "Take over shows the agent's page live in the card", async () => {
    await button(card(), english("prompt.browser.takeOver")).click();
    await liveView(page).waitFor({ timeout: UI_WAIT_MS });
    assert.equal(
      await card()
        .getByRole("img", { name: english("browser.liveView.label") })
        .count(),
      1,
    );
    await viewing(page, host);
    await card().scrollIntoViewIfNeeded();
    await shot(page, "desktop-live");
  });

  await step(page, viewport, "a click on a field and the keys type into the page", async () => {
    const field = await onScreen(page, tab, "#name");
    await page.mouse.click(field.x, field.y);
    await page.keyboard.type("Grace Hopper");
    await page.keyboard.press("Enter");
    await waitForTab(tab, nameIs, nameValue, "Grace Hopper", "The keys reach the field");
  });

  await step(page, viewport, "a click on a button clicks it", async () => {
    const next = await onScreen(page, tab, "#next");
    await page.mouse.click(next.x, next.y);
    await waitForTab(tab, clicksAre, nextClicks, "1", "One click is one click");
  });

  await step(page, viewport, "the wheel scrolls the page", async () => {
    const view = await liveView(page).boundingBox();
    assert.ok(view);
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
    await page.mouse.wheel(0, 600);
    await waitForTab(tab, scrolledPast, scrollTop, "100", "The wheel scrolls the page");
  });

  await step(page, viewport, "the view starts again when the connection comes back", async () => {
    const starts = host.starts;
    const stops = host.stops;
    // The client reconnects by itself after a drop, as it does after a WebRTC restart.
    await page.evaluate(() => window.liveViewBridge?.connection("offline"));
    await waitUntil(
      () => host.stops > stops && host.starts > starts,
      "The view stops with the connection and starts again",
    );
    await viewing(page, host);
    // The page scrolled in the step before; its top is where the button is.
    await tab.evaluate(() => window.scrollTo(0, 0));
    await waitUntil(() => host.inputs.some((input) => input.type === "ack"), "The view draws frames again");
    const next = await onScreen(page, tab, "#next");
    await page.mouse.click(next.x, next.y);
    await waitForTab(tab, clicksAre, nextClicks, "2", "A click after the reconnect reaches the page");
  });

  await step(page, viewport, "Expand opens the full view, and the card's view gives it the stream", async () => {
    const starts = host.starts;
    await button(card(), english("prompt.browser.expand")).click();
    await page.waitForFunction((count) => count > 0, starts, { timeout: UI_WAIT_MS });
    await page
      .getByRole("tabpanel")
      .getByRole("img", { name: english("browser.liveView.label") })
      .waitFor({ timeout: UI_WAIT_MS });
    assert.ok(host.starts > starts, "The full view starts its own stream.");
    await shot(page, "desktop-expanded");
  });

  await step(page, viewport, "Hand back ends the takeover once", async () => {
    await page.keyboard.press("Escape");
    // The full view's dock and the card both answer; two presses are one answer.
    const done = button(page, english("prompt.browser.done")).last();
    await done.click();
    await done.click({ timeout: 2_000 }).catch(() => undefined);
    await handedBack(page);
    await card().waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await shot(page, "desktop-done");
  });

  await step(page, viewport, "the DM header's Browser menu opens the agent's tab live", async () => {
    await browserFromHeader(page, host, false);
    await shot(page, "desktop-header-browser");
  });
  await context.close();
  await tabContext.close();
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
  plugins: [harnessPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: ["src/renderer/stories/web-client-live-view-harness.tsx"],
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
