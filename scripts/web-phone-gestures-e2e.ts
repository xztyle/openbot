// Checks the touch gestures of the web client on an iPhone, with real touch events (CDP
// `Input.dispatchTouchEvent`), as a finger sends them:
// 1. a long press on a message opens its actions; a long press on the message box's buttons, or on the
//    space around the messages, opens nothing (the workspace's menu is a right-click on a computer);
//    a text field inside a message, as an agent's form, still selects text;
// 2. a sheet follows a finger that drags it down: a short drag springs back, a long one closes it;
//    an edge swipe over an open sheet does not slide the conversation under it;
// 3. in the image viewer, a pinch that starts while the first finger drifts down leaves the image in
//    place and the backdrop at full strength.
// It serves the web client on a mock host (`src/renderer/stories/web-client-inbox-harness.tsx`) at
// `/app`, and the image viewer alone (`src/renderer/stories/image-lightbox-touch-harness.tsx`) at `/viewer`.
//
// `bun scripts/web-phone-gestures-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/web-phone-gestures-e2e/report.json, with a screenshot of a failed step.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type CDPSession, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("web-phone-gestures-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-phone-gestures-e2e");
const UI_WAIT_MS = 60_000;
const CHANNEL_PATH = "/app/general/c/general";
/** Longer than the long press (450 ms in `packages/ui/src/long-press.ts`). */
const HOLD_MS = 700;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const page = (entry: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${entry}"></script>
  </body>
</html>`;

const ENTRIES = {
  app: "/src/renderer/stories/web-client-inbox-harness.tsx",
  viewer: "/src/renderer/stories/image-lightbox-touch-harness.tsx",
};

function harnessPages(): Plugin {
  return {
    name: "openbot-web-phone-gestures-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        const entry = /^\/app(?:[/?]|$)/u.test(url)
          ? ENTRIES.app
          : /^\/viewer(?:[/?]|$)/u.test(url)
            ? ENTRIES.viewer
            : undefined;
        if (!entry) return next();
        const html = await server.transformIndexHtml(url, page(entry));
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      });
    },
  };
}

interface Step {
  name: string;
  passed: boolean;
  detail?: string;
}

const report: { device: string; steps: Step[]; pageErrors: string[]; screenshots: string[]; passed: boolean } = {
  device: "iPhone 13",
  steps: [],
  pageErrors: [],
  screenshots: [],
  passed: false,
};

async function step(target: Page, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ name, passed: true });
  } catch (error) {
    report.steps.push({ name, passed: false, detail: String(error).slice(0, 800) });
    const shot = resolve(OUT, `${report.steps.length}-failed.png`);
    await target.screenshot({ path: shot }).catch(() => undefined);
    report.screenshots.push(shot);
  }
}

interface Point {
  x: number;
  y: number;
}

/** A finger on the screen, through the same path as a real touch screen's events. */
function finger(cdp: CDPSession) {
  const send = (type: "touchStart" | "touchMove" | "touchEnd", points: (Point & { id: number })[]) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  return {
    send,
    async hold(target: Page, at: Point): Promise<void> {
      await send("touchStart", [{ ...at, id: 1 }]);
      await target.waitForTimeout(HOLD_MS);
      await send("touchEnd", []);
      await target.waitForTimeout(400);
    },
    /** Drags down from `from` by `dy` in steps, and returns before the finger lifts. */
    async dragDown(target: Page, from: Point, dy: number): Promise<() => Promise<void>> {
      await send("touchStart", [{ ...from, id: 1 }]);
      for (let index = 1; index <= 8; index += 1) {
        await send("touchMove", [{ x: from.x, y: from.y + (dy * index) / 8, id: 1 }]);
        await target.waitForTimeout(16);
      }
      return async () => {
        await send("touchEnd", []);
        await target.waitForTimeout(700);
      };
    },
  };
}

const sheet = (target: Page) => target.locator(".ui-dialog-content.ui-sheet");

async function closeDialogs(target: Page): Promise<void> {
  for (let index = 0; index < 3 && (await target.locator("[role=dialog]").count()) > 0; index += 1) {
    await target.keyboard.press("Escape");
    await target.waitForTimeout(400);
  }
}

/** The centre of an element, for a finger. */
async function centre(target: Page, selector: string): Promise<Point> {
  const box = await target.locator(selector).first().boundingBox();
  assert.ok(box, `${selector} is not on screen.`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
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
    entries: Object.values(ENTRIES).map((entry) => entry.slice(1)),
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
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  const context = await browser.newContext({ ...iphone, hasTouch: true, isMobile: true });
  const app = await context.newPage();
  app.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  const touch = finger(await context.newCDPSession(app));

  await app.goto(`${origin}${CHANNEL_PATH}`, { waitUntil: "commit" });
  await app.locator(".ws-message").first().waitFor({ timeout: UI_WAIT_MS });
  await app.waitForTimeout(1500);

  // 1. Long press.
  await step(app, "a long press on a message opens its actions", async () => {
    await touch.hold(app, await centre(app, ".ws-message .ws-message-body"));
    await sheet(app).waitFor({ timeout: 5000 });
    await closeDialogs(app);
  });
  for (const [name, selector] of [
    ["the attach button", ".ws-composer-tools button"],
    ["the send button", ".ws-composer-send-group"],
  ] as const) {
    await step(app, `a long press on ${name} opens no menu`, async () => {
      await touch.hold(app, await centre(app, selector));
      assert.equal(await app.locator("[role=dialog]").count(), 0, "A sheet opened.");
    });
    await closeDialogs(app);
  }

  await step(app, "a field in a message keeps its text selection", async () => {
    // A message holds no text selection on a touch screen, but a field in it, as an agent's form, does.
    const selection = await app.evaluate(() => {
      const body = document.querySelector(".ws-message .ws-message-body");
      if (!body) return null;
      const field = document.createElement("input");
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      body.append(field, editor);
      const values = [
        getComputedStyle(body).userSelect,
        getComputedStyle(field).userSelect,
        getComputedStyle(editor).userSelect,
      ];
      field.remove();
      editor.remove();
      return values;
    });
    assert.ok(selection, "No message.");
    assert.equal(selection[0], "none", "The message text is selectable on a touch screen.");
    assert.notEqual(selection[1], "none", "The field has no text selection.");
    assert.notEqual(selection[2], "none", "The editable text has no text selection.");
  });

  // 2. A sheet follows the finger.
  await step(app, "a short drag down springs the sheet back", async () => {
    await touch.hold(app, await centre(app, ".ws-message .ws-message-body"));
    await sheet(app).waitFor({ timeout: 5000 });
    await app.waitForTimeout(400);
    const box = await sheet(app).boundingBox();
    assert.ok(box);
    const lift = await touch.dragDown(app, { x: box.x + box.width / 2, y: box.y + 8 }, 40);
    const moved = await sheet(app).boundingBox();
    assert.ok(moved && moved.y > box.y + 30, `The sheet did not follow the finger: ${box.y} → ${moved?.y}.`);
    await lift();
    const back = await sheet(app).boundingBox();
    assert.ok(back && Math.abs(back.y - box.y) < 2, `The sheet did not spring back: ${box.y} → ${back?.y}.`);
  });
  await step(app, "a long drag down closes the sheet", async () => {
    const box = await sheet(app).boundingBox();
    assert.ok(box);
    const lift = await touch.dragDown(app, { x: box.x + box.width / 2, y: box.y + 8 }, 260);
    await lift();
    await sheet(app).waitFor({ state: "detached", timeout: 5000 });
  });
  await closeDialogs(app);
  await step(app, "an edge swipe over an open sheet leaves the conversation in place", async () => {
    await touch.hold(app, await centre(app, ".ws-message .ws-message-body"));
    await sheet(app).waitFor({ timeout: 5000 });
    await touch.send("touchStart", [{ x: 4, y: 600, id: 1 }]);
    for (const x of [30, 80, 140, 200, 260]) {
      await touch.send("touchMove", [{ x, y: 600, id: 1 }]);
      await app.waitForTimeout(16);
    }
    const moved = await app.evaluate(
      () => document.querySelector<HTMLElement>(".web-app-frame > .app-frame-panes")?.style.transform ?? "",
    );
    await touch.send("touchEnd", []);
    await app.waitForTimeout(700);
    assert.equal(moved, "", "The conversation slid under the sheet.");
    assert.ok(await app.locator(".ws-message").first().isVisible(), "The conversation left.");
  });
  await closeDialogs(app);

  // 3. The image viewer.
  const viewer = await context.newPage();
  viewer.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  const viewerTouch = finger(await context.newCDPSession(viewer));
  await viewer.goto(`${origin}/viewer`, { waitUntil: "commit" });
  await viewer.locator(".image-lightbox-image").first().waitFor({ timeout: UI_WAIT_MS });
  await viewer.waitForTimeout(1200);
  await step(viewer, "a pinch after a drift down leaves the image in place", async () => {
    const at = await centre(viewer, ".image-lightbox-stage");
    // The first finger lands and drifts down, as fingers do before the second one lands.
    await viewerTouch.send("touchStart", [{ ...at, id: 1 }]);
    for (const dy of [10, 20, 30]) {
      await viewerTouch.send("touchMove", [{ x: at.x, y: at.y + dy, id: 1 }]);
      await viewer.waitForTimeout(16);
    }
    for (let index = 0; index <= 6; index += 1) {
      await viewerTouch.send(index === 0 ? "touchStart" : "touchMove", [
        { x: at.x, y: at.y + 30 - 15 * index, id: 1 },
        { x: at.x, y: at.y + 100 + 15 * index, id: 2 },
      ]);
      await viewer.waitForTimeout(16);
    }
    await viewerTouch.send("touchEnd", [{ x: at.x, y: at.y + 190, id: 2 }]);
    await viewerTouch.send("touchEnd", []);
    await viewer.waitForTimeout(500);
    const state = await viewer.evaluate(() => ({
      translate: document.querySelector<HTMLElement>(".image-lightbox-track")?.style.translate ?? "",
      opacity: document.querySelector<HTMLElement>(".image-lightbox-backdrop")?.style.opacity ?? "",
      zoomed: document.querySelector(".image-lightbox-image[data-zoomed]") !== null,
    }));
    assert.ok(state.zoomed, "The pinch did not zoom in.");
    assert.equal(state.translate, "", "The image stayed moved down.");
    assert.equal(state.opacity, "", "The backdrop stayed faded.");
  });

  report.passed = report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
for (const item of report.steps)
  logger.info(`${item.passed ? "pass" : "FAIL"}: ${item.name}${item.detail ? `\n${item.detail}` : ""}`);
logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps. Report: ${resolve(OUT, "report.json")}`,
);
process.exit(report.passed ? 0 : 1);
