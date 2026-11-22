// Checks that a member on the web client can work in the agent's browser when the agent waits for
// them, on a computer and on an iPhone. It serves the web client on a mock host
// (`src/renderer/stories/web-client-live-view-harness.tsx`), where Chief waits for the reader on a
// sign-up tab. The tab is a real page in a second Chromium page: this script streams its screencast
// to the client as the host's live view does, and sends the client's pointer and key input to it with
// the host's own CDP key table (`src/backend/browser-cdp-input.ts`).
//
// `bun scripts/web-live-view-e2e.ts [--browser-executable=<path>] [--headed] [--only=desktop|phone|wide|wide-2x]`
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
    openbotLiveViewStart?: (tabId: string, viewport?: { width: number; height: number }) => Promise<void>;
    openbotLiveViewStop?: () => Promise<void>;
    openbotLiveViewInput?: (input: BrowserLiveViewInput) => Promise<void>;
    liveViewHost?: {
      start(tabId: string, viewport?: { width: number; height: number }): Promise<void>;
      stop(): Promise<void>;
      input(input: BrowserLiveViewInput): Promise<void>;
    };
    liveViewBridge?: {
      frame(tabId: string, sequence: number, width: number, height: number, base64: string): void;
      connection(state: "online" | "offline"): void;
      addTab(tabId: string, title: string): void;
      removeTab(tabId: string): void;
      failNextClose(): void;
      acting(on: boolean): void;
    };
    takeoverResponses?: { requestId: string | number; decision: string }[];
    closedTabs?: string[];
  }
}

const logger = createOpenBotLogger("web-live-view-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-live-view-e2e");
const UI_WAIT_MS = Number(process.env.UI_WAIT_MS ?? 60_000);
const english = translateFor("en");
const DM_PATH = "/app/general/dm/chief";
const TAB_ID = "browser-tab-signup";
const TAB_SIZE = { width: 800, height: 600 };

/** A 1920 x 1080 screen at a browser zoom of 110 %: the page has 1/1.1 of the CSS pixels, each 1.1 times as dense. */
const ZOOM = 1.1;
const zoomed = (scale: number) => ({
  viewport: { width: Math.round(1920 / ZOOM), height: Math.round(1080 / ZOOM) },
  deviceScaleFactor: scale * ZOOM,
});
const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  "wide-1x": zoomed(1),
  "wide-1.25x": zoomed(1.25),
  "wide-2x": zoomed(2),
} as const;
type ViewportName = keyof typeof VIEWPORTS;
/**
 * The frame bound of a host before the views asked for frames of their panel's size
 * (`src/backend/browser-host.ts`): a page wider than this comes as a smaller image, and the view
 * must scale it to the panel all the same.
 */
const HOST_FRAME_MAX = { width: 1_280, height: 800 };

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
    <button id="oauth" type="button" onclick="window.open('/popup', 'oauth', 'width=480,height=600')">Continue with Example</button>
    <script>
      addEventListener("message", (event) => {
        if (event.data === "authorized") document.body.dataset.auth = "ok";
      });
    </script>
    <div class="tall"></div>
    <p id="end">End of page</p>
  </body>
</html>`;

/** The sign-in popup the tab opens, as an OAuth provider's window: it answers its opener and closes. */
const POPUP_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Sign in to Example</title>
    <style>body { font: 18px system-ui, sans-serif; margin: 24px; background: #eef4ff; } button { font: inherit; padding: 12px 24px; }</style>
  </head>
  <body>
    <h1>Sign in to Example</h1>
    <button id="authorize" type="button" onclick="window.opener.postMessage('authorized', '*'); window.close()">Authorize</button>
  </body>
</html>`;
const POPUP_ID = "browser-tab-popup";

/** Serves the harness at `/app` and every address under it, and the agent's page at `/tab`. */
function harnessPages(): Plugin {
  return {
    name: "openbot-live-view-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        if (url === "/popup") {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(POPUP_PAGE);
          return;
        }
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
  /** The tab of the last stream the client started. */
  current = "";
  /** The host's pages by tab, the agent's tab and the popups it opened. */
  readonly pages = new Map<string, Page>();

  constructor(
    readonly tab: Page,
    readonly client: Page,
  ) {
    this.pages.set(TAB_ID, tab);
  }

  async install(): Promise<void> {
    await this.client.exposeFunction(
      "openbotLiveViewStart",
      (tabId: string, viewport?: { width: number; height: number }) => this.start(tabId, viewport),
    );
    await this.client.exposeFunction("openbotLiveViewStop", () => this.stop());
    await this.client.exposeFunction("openbotLiveViewInput", (input: BrowserLiveViewInput) => this.input(input));
    await this.client.addInitScript(() => {
      window.liveViewHost = {
        start: async (tabId, viewport) => window.openbotLiveViewStart?.(tabId, viewport),
        stop: async () => window.openbotLiveViewStop?.(),
        input: async (input) => window.openbotLiveViewInput?.(input),
      };
    });
  }

  /** The page sizes the client asked for, as the host's `browser-view-viewport` holds them. */
  readonly viewports: Array<{ width: number; height: number }> = [];

  async start(tabId: string, viewport?: { width: number; height: number }): Promise<void> {
    const page = this.pages.get(tabId);
    assert.ok(page, `The client watches a tab of the host: ${tabId}.`);
    if (viewport) {
      this.viewports.push(viewport);
      await page.setViewportSize(viewport);
    } else if (tabId === TAB_ID) {
      // The host gives the page back its own size when the view that asked for one stops.
      await page.setViewportSize(TAB_SIZE);
    }
    await this.stop();
    this.starts += 1;
    this.current = tabId;
    const cdp = await page.context().newCDPSession(page);
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
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: HOST_FRAME_MAX.width,
      maxHeight: HOST_FRAME_MAX.height,
    });
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

/** The dock over the page says "Hand back"; the card in the chat says "I'm done". Both end the takeover. */
const handBackName = new RegExp(
  `^(${[english("browser.dock.handBack"), english("prompt.browser.done")].map((text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})$`,
  "u",
);

const liveView = (page: Page) => page.getByRole("img", { name: english("browser.liveView.label") }).last();

/** Where a point of the agent's page is on the client's screen: the live view letterboxes the frame. */
async function onScreen(page: Page, tab: Page, selector: string, offset = { x: 0.5, y: 0.5 }) {
  const target = await tab.locator(selector).boundingBox();
  await liveView(page).evaluate((element) => element.scrollIntoView({ block: "center" }));
  const view = await liveView(page).boundingBox();
  assert.ok(target && view, `No box for ${selector} or for the live view.`);
  // A popup has the size its opener asked for, not the tab's.
  const size = tab.viewportSize() ?? TAB_SIZE;
  const scale = Math.min(view.width / size.width, view.height / size.height);
  const left = view.x + (view.width - size.width * scale) / 2;
  const top = view.y + (view.height - size.height * scale) / 2;
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
/**
 * While the agent works, the DM header holds "Why is this slow?" beside the chat's controls, in its
 * one row: the button and the model picker overlap in height, and both are inside the header.
 */
async function headerInOneRow(page: Page): Promise<void> {
  const header = page.locator(".ws-agent-dm-header");
  const slow = header.getByRole("button", { name: `${english("insight.slow.button")} · Chief`, exact: true });
  await slow.waitFor({ timeout: UI_WAIT_MS });
  const boxes = await Promise.all([
    header.boundingBox(),
    slow.boundingBox(),
    header.locator(".provider-model-trigger").first().boundingBox(),
  ]);
  const [frame, button, picker] = boxes;
  assert.ok(frame && button && picker, `The header has no box: ${JSON.stringify(boxes)}`);
  assert.ok(
    Math.max(button.y, picker.y) < Math.min(button.y + button.height, picker.y + picker.height),
    `"Why is this slow?" and the model are not in one row: ${JSON.stringify(boxes)}`,
  );
  for (const inner of [button, picker])
    assert.ok(
      inner.y >= frame.y - 1 && inner.y + inner.height <= frame.y + frame.height + 1,
      `A control stands outside the header: ${JSON.stringify(boxes)}`,
    );
}

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
    // The status goes under the title on a phone: beside it, the title had a third of the card and
    // cut the site's name in the middle.
    const title = await takeoverCard(page).getByRole("heading").first().boundingBox();
    assert.ok(title && title.width >= 240, `The card's title is squeezed: ${JSON.stringify(title)}.`);
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
    // The keyboard the person opened stays up for the page: a tap does not take its field's focus.
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      english("browser.liveView.keyboardInput"),
      "The keyboard field keeps the focus after a tap on the page.",
    );
  });

  await step(page, viewport, "a drag scrolls the page", async () => {
    const view = await liveView(page).boundingBox();
    assert.ok(view);
    const x = view.x + view.width / 2;
    await swipe(page, { x, y: view.y + view.height * 0.8 }, { x, y: view.y + view.height * 0.2 });
    await waitForTab(tab, scrolledPast, scrollTop, "100", "A finger that moves up scrolls the page down");
  });

  await step(page, viewport, "a finger held still on the page does not open the workspace's menu", async () => {
    const view = await liveView(page).boundingBox();
    assert.ok(view);
    const cdp = await page.context().newCDPSession(page);
    const point = { x: view.x + view.width / 2, y: view.y + view.height * 0.75, id: 1 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    // Longer than the long press of the workspace's sheet, as a person who holds to read does.
    await page.waitForTimeout(900);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await page.waitForTimeout(300);
    assert.equal(
      await page.getByText(english("workspace.app.menu.createChannel"), { exact: true }).count(),
      0,
      "The workspace's menu opened over the page.",
    );
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

  await step(
    page,
    viewport,
    "a tap opens a sign-in popup full screen, and its close goes back to the page",
    async () => {
      await button(page, english("browser.liveView.fit"))
        .tap({ timeout: 2_000 })
        .catch(() => undefined);
      await signInThroughPopup(page, host, tab, true, async () => {
        // The popup is part of the step the agent asked for: the dock over it still hands the page back.
        await page
          .locator("#browser-expanded-panel")
          .getByRole("button", { name: handBackName })
          .waitFor({ timeout: 5_000 });
      });
    },
  );

  await step(page, viewport, "closing a popup from the tab list goes back to the page", async () => {
    const opened = tab.context().waitForEvent("page");
    await tab.evaluate(() => window.scrollTo(0, 0));
    const before = host.starts;
    const oauth = await onScreen(page, tab, "#oauth");
    await page.touchscreen.tap(oauth.x, oauth.y);
    const popup = await opened;
    await popup.waitForLoadState();
    host.pages.set(POPUP_ID, popup);
    await page.evaluate((id) => window.liveViewBridge?.addTab(id, "Sign in to Example"), POPUP_ID);
    await waitUntil(() => host.current === POPUP_ID && host.starts > before, "The view shows the popup");
    await viewing(page, host);
    await page.locator("#browser-expanded-panel .browser-full-switch").tap();
    await button(page, english("browser.tab.closeNamed", { name: "Sign in to Example" })).tap();
    await page.waitForFunction(() => (window.closedTabs ?? []).length > 0, undefined, { timeout: UI_WAIT_MS });
    await popup.close();
    host.pages.delete(POPUP_ID);
    await waitUntil(() => host.current === TAB_ID, "The view goes back to the page that opened the popup");
    assert.ok(await page.locator("#browser-expanded-panel").isVisible(), "The full view stays open.");
    // The list stays open for more closes; a tap on the page's row closes it.
    await page.locator(".browser-full-switch-select").first().tap();
    await viewing(page, host);
    await shot(page, "phone-popup-closed");
  });

  await step(page, viewport, "a turn of the phone gives the page the new shape", async () => {
    const asked = host.viewports.length;
    await page.setViewportSize({ width: 844, height: 390 });
    await waitUntil(
      () => host.viewports.slice(asked).some((size) => size.width > size.height),
      "The view asks the host for a wide page",
    );
    await viewing(page, host);
    let fit = await fullViewFit(page);
    for (let tries = 0; tries < 40 && !(fit && fit.drawn.width >= fit.panel.width - 2); tries += 1) {
      await page.waitForTimeout(250);
      fit = await fullViewFit(page);
    }
    await shot(page, "phone-landscape");
    // A phone on its side keeps the one bar of a phone: the page needs the little height there is.
    assert.equal(await page.locator("#browser-expanded-panel .browser-full-top").count(), 0, "The view has two bars.");
    assert.ok(fit && fit.drawn.width >= fit.panel.width - 2, `The page fills the turned view: ${JSON.stringify(fit)}.`);
    await page.setViewportSize({ width: 390, height: 844 });
    await waitUntil(
      () =>
        host.viewports.at(-1) !== undefined &&
        (host.viewports.at(-1)?.width ?? 0) < (host.viewports.at(-1)?.height ?? 0),
      "The view asks for a tall page again",
    );
  });

  await step(page, viewport, "I'm done hands the page back once", async () => {
    await page.getByRole("button", { name: handBackName }).last().tap();
    await handedBack(page);
  });

  await step(page, viewport, "the DM header's More sheet opens the agent's tab live", async () => {
    // The full view is open from the takeover; Back returns to the chat first.
    await page.goto(`${origin}${DM_PATH}`, { waitUntil: "commit" });
    const more = page.locator(".ws-agent-dm-header").getByRole("button", { name: english("workspace.message.more") });
    await more.waitFor({ timeout: UI_WAIT_MS });
    await headerInOneRow(page);
    const starts = host.starts;
    await more.tap();
    await page
      .getByRole("dialog")
      .getByRole("button", {
        name: new RegExp(`^${english("conversation.header.browser", { name: "Chief" })}: Create your account`, "u"),
      })
      .tap();
    await page
      .getByRole("tabpanel")
      .getByRole("img", { name: english("browser.liveView.label") })
      .waitFor({ timeout: UI_WAIT_MS });
    assert.ok(host.starts > starts, "The full view starts a stream of the tab.");
    await shot(page, "phone-header-browser");
  });
  await context.close();
  await tabContext.close();
}

/**
 * A click through the live view opens a sign-in popup on the host: the view shows the popup, a click
 * in it answers the opener and closes it, and the view goes back to the opener.
 */
async function signInThroughPopup(
  page: Page,
  host: TabHost,
  tab: Page,
  touch = false,
  inPopup?: () => Promise<void>,
): Promise<void> {
  const press = (at: { x: number; y: number }) =>
    touch ? page.touchscreen.tap(at.x, at.y) : page.mouse.click(at.x, at.y);
  const opened = tab.context().waitForEvent("page");
  await tab.evaluate(() => window.scrollTo(0, 0));
  const before = host.starts;
  await waitUntil(() => host.inputs.filter((input) => input.type === "ack").length > 0, "Frames are drawn");
  // The click goes through the live view, as the person's click on "Continue with Facebook" did.
  await press(await onScreen(page, tab, "#oauth"));
  const popup = await opened;
  await popup.waitForLoadState();
  host.pages.set(POPUP_ID, popup);
  const closed = popup.waitForEvent("close");
  // The host lists the new tab and keeps its own active tab on the opener: the view follows the
  // popup by itself, as main's active tab can belong to another agent's work.
  await page.evaluate((id) => window.liveViewBridge?.addTab(id, "Sign in to Example"), POPUP_ID);
  await waitUntil(() => host.current === POPUP_ID && host.starts > before, "The view shows the popup");
  await viewing(page, host);
  await page.waitForTimeout(300);
  await shot(page, touch ? "phone-popup" : "desktop-popup");
  await inPopup?.();
  await press(await onScreen(page, popup, "#authorize"));
  await closed;
  await page.evaluate((id) => window.liveViewBridge?.removeTab(id), POPUP_ID);
  host.pages.delete(POPUP_ID);
  await waitUntil(() => host.current === TAB_ID, "The view goes back to the opener");
  await waitForTab(
    tab,
    (expected) => document.body.dataset.auth === expected,
    () => document.body.dataset.auth,
    "ok",
    "The popup answered its opener",
  );
  await viewing(page, host);
}

async function desktop(browser: Browser, origin: string): Promise<void> {
  const viewport = "desktop";
  const { page, host, tab, context, tabContext } = await open(browser, origin, viewport);
  const card = () => takeoverCard(page);

  await step(page, viewport, "the card says the agent waits for the reader", async () => {
    await load(page, origin, DM_PATH, card());
    await headerInOneRow(page);
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

  await step(
    page,
    viewport,
    "a sign-in popup opens in the card's view, and the card goes back when it closes",
    async () => {
      await signInThroughPopup(page, host, tab);
      assert.equal(
        await card()
          .getByRole("img", { name: english("browser.liveView.label") })
          .count(),
        1,
        "The card still shows the page live.",
      );
      // The full view's popup step below checks the answer again.
      await tab.evaluate(() => delete document.body.dataset.auth);
    },
  );

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

  await step(page, viewport, "a press that ends outside the view still lets the button go", async () => {
    await tab.evaluate(() => {
      window.scrollTo(0, 0);
      document.body.dataset.mouseUps = "0";
      addEventListener("mouseup", () => {
        document.body.dataset.mouseUps = String(Number(document.body.dataset.mouseUps) + 1);
      });
    });
    await waitUntil(() => host.inputs.some((input) => input.type === "ack"), "Frames are drawn");
    // A drag that selects text in the field and lets go above the view, as a person's drag often does.
    const field = await onScreen(page, tab, "#name", { x: 0.9, y: 0.5 });
    const view = await liveView(page).boundingBox();
    assert.ok(view);
    await page.mouse.move(field.x, field.y);
    await page.mouse.down();
    await page.mouse.move(field.x - 40, view.y - 30, { steps: 4 });
    await page.mouse.up();
    await waitForTab(
      tab,
      (expected) => document.body.dataset.mouseUps === expected,
      () => document.body.dataset.mouseUps,
      "1",
      "The page sees the button go up, or it drags on every move after",
    );
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

  await step(page, viewport, "a sign-in popup opens in the view, and the view goes back when it closes", () =>
    signInThroughPopup(page, host, tab),
  );

  await step(page, viewport, "Escape in the page goes to the page, and the full view stays open", async () => {
    await tab.evaluate(() => {
      document.body.dataset.escapes = "0";
      window.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Escape") document.body.dataset.escapes = String(Number(document.body.dataset.escapes) + 1);
      });
    });
    const name = await onScreen(page, tab, "#name");
    await page.mouse.click(name.x, name.y);
    await page.keyboard.press("Escape");
    await waitForTab(
      tab,
      (expected) => document.body.dataset.escapes === expected,
      () => document.body.dataset.escapes,
      "1",
      "The page gets the Escape, as a dialog in it needs",
    );
    assert.ok(await page.locator("#browser-expanded-panel").isVisible(), "The full view stays open.");
    // Escape from the chat closes the full view, as before the page had the focus.
    await page
      .locator("#browser-expanded-panel")
      .getByRole("button", { name: english("browser.hide") })
      .click();
    await page.locator("#browser-expanded-panel").waitFor({ state: "hidden", timeout: UI_WAIT_MS });
  });

  await step(page, viewport, "Hand back ends the takeover once", async () => {
    await page.keyboard.press("Escape");
    // The full view's dock and the card both answer; two presses are one answer.
    const done = page.getByRole("button", { name: handBackName }).last();
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

  await step(page, viewport, "a copy while the agent acts does not hold back the copies after it", async () => {
    await page.evaluate(() => window.liveViewBridge?.acting(true));
    await page.getByText(english("browser.liveView.agentUsing"), { exact: true }).waitFor({ timeout: UI_WAIT_MS });
    const view = page.getByRole("tabpanel").getByRole("img", { name: english("browser.liveView.label") });
    await view.focus();
    await page.keyboard.press("ControlOrMeta+C");
    await page.evaluate(() => window.liveViewBridge?.acting(false));
    await page
      .getByText(english("browser.liveView.agentUsing"), { exact: true })
      .waitFor({ state: "detached", timeout: UI_WAIT_MS });
    const copies = host.inputs.filter((input) => input.type === "copy").length;
    await view.focus();
    await page.keyboard.press("ControlOrMeta+C");
    await waitUntil(
      () => host.inputs.filter((input) => input.type === "copy").length > copies,
      "A copy after the agent stopped reaches the host",
    );
  });

  await step(page, viewport, "Take over on a page the agent uses gives the person the page", async () => {
    await page.evaluate(() => window.liveViewBridge?.acting(true));
    const lock = page.getByRole("status").filter({ hasText: english("browser.liveView.agentUsing") });
    await lock.waitFor({ timeout: UI_WAIT_MS });
    await tab.evaluate(() => window.scrollTo(0, 0));
    const clicks = Number(await tab.evaluate(nextClicks));
    const next = await onScreen(page, tab, "#next");
    await page.mouse.click(next.x, next.y);
    await page.waitForTimeout(500);
    assert.equal(Number(await tab.evaluate(nextClicks)), clicks, "A click while the agent acts waits.");
    await button(lock, english("island.action.takeOver")).click();
    await lock.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await page.mouse.click(next.x, next.y);
    await waitForTab(tab, clicksAre, nextClicks, String(clicks + 1), "A click after Take over reaches the page");
    await shot(page, "desktop-taken-over");
    await page.evaluate(() => window.liveViewBridge?.acting(false));
  });
  await context.close();
  await tabContext.close();
}

/** How the page of the full view sits in its panel, as drawn. */
interface Fit {
  panel: { width: number; height: number };
  drawn: { width: number; height: number };
  image: { width: number; height: number };
  /** The alpha of the canvas pixel at the bottom-right corner: 0 where no frame was drawn. */
  cornerAlpha: number;
}

async function fullViewFit(page: Page): Promise<Fit | null> {
  return page.evaluate((label) => {
    const canvas = [
      ...document.querySelectorAll<HTMLCanvasElement>(`[role="tabpanel"] canvas[aria-label="${label}"]`),
    ].find((element) => !element.hidden && element.width > 0);
    const panel = canvas?.closest(".browser-live-view")?.getBoundingClientRect();
    if (!canvas || !panel) return null;
    const box = canvas.getBoundingClientRect();
    const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
    const corner = canvas.getContext("2d")?.getImageData(canvas.width - 2, canvas.height - 2, 1, 1).data[3] ?? 0;
    return {
      panel: { width: panel.width, height: panel.height },
      drawn: { width: canvas.width * scale, height: canvas.height * scale },
      image: { width: canvas.width, height: canvas.height },
      cornerAlpha: corner,
    };
  }, english("browser.liveView.label"));
}

const chipOf = (page: Page, tabId: string) => page.locator(`.browser-full-chip[data-tab-id="${tabId}"]`);

/**
 * The full view on a wide screen at 110 % zoom: the page fills the panel, and the tab row closes a
 * tab with the middle button and with its X at once, before the host answers.
 */
async function wide(browser: Browser, origin: string, viewport: "wide-1x" | "wide-1.25x" | "wide-2x"): Promise<void> {
  const { page, host, tab, context, tabContext } = await open(browser, origin, viewport);
  const card = () => takeoverCard(page);

  await step(page, viewport, "the expanded view's page fills the panel", async () => {
    await load(page, origin, DM_PATH, card());
    await button(card(), english("prompt.browser.takeOver")).click();
    await viewing(page, host);
    await button(card(), english("prompt.browser.expand")).click();
    await page
      .getByRole("tabpanel")
      .getByRole("img", { name: english("browser.liveView.label") })
      .waitFor({ timeout: UI_WAIT_MS });
    let fit: Fit | null = null;
    const deadline = Date.now() + UI_WAIT_MS / 2;
    const fills = (value: Fit | null) =>
      value !== null &&
      value.drawn.width / value.panel.width >= 0.98 &&
      value.drawn.height / value.panel.height >= 0.98 &&
      value.cornerAlpha > 0;
    while (Date.now() < deadline) {
      fit = await fullViewFit(page);
      if (fills(fit)) break;
      await page.waitForTimeout(200);
    }
    await shot(page, `${viewport}-expanded`);
    assert.ok(fit && fills(fit), `The page fills the panel within 2 %: ${JSON.stringify(fit)}.`);
    const asked = host.viewports.at(-1);
    assert.ok(
      asked && Math.abs(asked.width - fit.panel.width) <= 25 && Math.abs(asked.height - fit.panel.height) <= 25,
      `The view asks for the panel's CSS size: asked ${JSON.stringify(asked)}, panel ${JSON.stringify(fit.panel)}.`,
    );
    // The panel is wider than the host's frame bound, so the image is smaller than the page and is scaled up.
    assert.ok(
      fit.image.width <= HOST_FRAME_MAX.width && fit.panel.width > HOST_FRAME_MAX.width,
      `The frame is scaled to the panel: ${JSON.stringify(fit)}.`,
    );
  });

  await step(page, viewport, "a click in the scaled page lands where it was aimed", async () => {
    await tab.evaluate(() => window.scrollTo(0, 0));
    const clicks = Number(await tab.evaluate(nextClicks));
    const next = await onScreen(page, tab, "#next");
    await page.mouse.click(next.x, next.y);
    await waitForTab(tab, clicksAre, nextClicks, String(clicks + 1), "One click is one click");
  });

  const extra = [
    { id: "browser-tab-docs", title: "Docs" },
    { id: "browser-tab-mail", title: "Mail" },
    { id: "browser-tab-calendar", title: "Calendar" },
  ];
  for (const entry of extra) {
    host.pages.set(entry.id, tab);
    await page.evaluate(({ id, title }) => window.liveViewBridge?.addTab(id, title), entry);
    await chipOf(page, entry.id).waitFor({ timeout: UI_WAIT_MS });
  }
  const closedOnce = async (tabId: string) => {
    const closed = await page.evaluate(() => window.closedTabs ?? []);
    assert.equal(closed.filter((id) => id === tabId).length, 1, `One close of ${tabId}: ${JSON.stringify(closed)}.`);
  };

  await step(page, viewport, "a middle click closes a tab at once", async () => {
    const chip = chipOf(page, "browser-tab-docs");
    const box = await chip.boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "middle" });
    // The host answers after 600 ms; the tab leaves the row before that.
    await chip.waitFor({ state: "detached", timeout: 400 });
    await page.waitForTimeout(900);
    assert.equal(await chip.count(), 0, "The tab stays closed after the host answers.");
    await closedOnce("browser-tab-docs");
  });

  await step(page, viewport, "the X closes a tab at once, and its press area is 24 px", async () => {
    const chip = chipOf(page, "browser-tab-mail");
    await chip.hover();
    const close = chip.locator(".browser-full-chip-close");
    const box = await close.boundingBox();
    assert.ok(box);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const reach = await page.evaluate(
      ({ x, y }) =>
        [
          [x - 11.5, y],
          [x + 11.5, y],
          [x, y - 11.5],
          [x, y + 11.5],
        ].every(([px, py]) => document.elementFromPoint(px ?? 0, py ?? 0)?.closest(".browser-full-chip-close")),
      center,
    );
    assert.ok(reach, `The X takes presses 24 px square: ${JSON.stringify(box)}.`);
    // A press that wobbles a few pixels is still a click on the X, not a drag of the tab.
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 4, center.y + 2, { steps: 3 });
    await page.mouse.move(center.x + 7, center.y + 3, { steps: 3 });
    await page.mouse.move(center.x + 4, center.y + 1, { steps: 2 });
    await page.mouse.up();
    await chip.waitFor({ state: "detached", timeout: 400 });
    await page.waitForTimeout(900);
    assert.equal(await chip.count(), 0, "The tab stays closed after the host answers.");
    await closedOnce("browser-tab-mail");
  });

  await step(page, viewport, "a close the host refuses puts the tab back", async () => {
    await page.evaluate(() => window.liveViewBridge?.failNextClose());
    const chip = chipOf(page, "browser-tab-calendar");
    await chip.hover();
    await chip.locator(".browser-full-chip-close").click();
    await chip.waitFor({ state: "detached", timeout: 400 });
    await chip.waitFor({ state: "attached", timeout: UI_WAIT_MS });
    await closedOnce("browser-tab-calendar");
    await shot(page, `${viewport}-tabs`);
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
  const only = option("only");
  if (!only || only === "desktop") await desktop(browser, origin);
  if (!only || only === "phone") await phone(browser, origin);
  for (const name of ["wide-1x", "wide-1.25x", "wide-2x"] as const)
    if (!only || only === "wide" || only === name) await wide(browser, origin, name);
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
