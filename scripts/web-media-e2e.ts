// Checks files and images in a channel of the web client against a mock host
// (`src/renderer/stories/web-client-media-harness.tsx`), on a computer and on an iPhone:
// - a second pick of files that would take the message over the attachment limit keeps the limit,
//   says why, and gives the rest back, since the host refuses such a message at Send;
// - a file dropped on the conversation goes up as a draft of its box, and a file dropped elsewhere
//   in the app does not make the browser leave the app to show it;
// - an iPhone photo in HEIC that the browser can draw goes up as a JPEG with the same name, and one
//   it cannot draw is named as a type the host refuses. Chromium draws no HEIC, so the drawable photo
//   holds PNG bytes: an image element reads the bytes, not the type;
// - on a phone, the image viewer steps with a swipe and closes with a drag down.
//
// `bun scripts/web-media-e2e.ts [--browser-executable=<path>] [--headed] [--out=<dir>]`
// Writes report.json to .openbot-build/web-media-e2e, or to --out.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

/** The names of the files that the harness took as uploads. */
declare global {
  interface Window {
    harnessUploads?: string[];
  }
}

const logger = createOpenBotLogger("web-media-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const UI_WAIT_MS = 90_000;
const CHANNEL_PATH = "/app/general/c/general";
const ATTACHMENT_LIMIT = 10;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const OUT = resolve(option("out") ?? resolve(ROOT, ".openbot-build/web-media-e2e"));

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
    name: "openbot-web-media-harness",
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

const report: { steps: Step[]; pageErrors: string[]; passed: boolean } = { steps: [], pageErrors: [], passed: false };

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

async function newPage(browser: Browser, phone: boolean): Promise<Page> {
  const context = await browser.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await page.goto(`${origin}${CHANNEL_PATH}`, { waitUntil: "commit", timeout: UI_WAIT_MS });
  await page.locator("[data-attachment-id]").first().waitFor({ timeout: UI_WAIT_MS });
  return page;
}

const composer = (page: Page): Locator => page.locator(".ws-layout-main .ws-composer-frame").last();
const chips = (page: Page) => composer(page).locator(".ws-composer-file");
const uploads = (page: Page) => page.evaluate(() => window.harnessUploads?.slice() ?? []);

function files(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${index + 1}.png`,
    mimeType: "image/png",
    buffer: Buffer.from("png"),
  }));
}

async function pick(page: Page, chosen: ReturnType<typeof files>) {
  const chooser = page.waitForEvent("filechooser", { timeout: 5_000 });
  await composer(page).getByRole("button", { name: "Attach files" }).click();
  await (await chooser).setFiles(chosen);
}

/** Drops a file on the element at `selector`, as a drag from the desktop does. Says whether the page took the drop. */
function dropFile(page: Page, selector: string, name: string) {
  return page.evaluate(
    ([selector, name]) => {
      const target = document.querySelector(selector);
      if (!target) throw new Error(`Nothing at ${selector}.`);
      const data = new DataTransfer();
      data.items.add(new File(["dropped"], name, { type: "text/plain" }));
      const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data });
      target.dispatchEvent(over);
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data });
      target.dispatchEvent(drop);
      return { over: over.defaultPrevented, drop: drop.defaultPrevented };
    },
    [selector, name] as const,
  );
}

async function checkLimit(browser: Browser) {
  const page = await newPage(browser, false);
  await pick(page, files(8, "first"));
  await chips(page).nth(7).waitFor({ timeout: 10_000 });
  await pick(page, files(5, "second"));
  await page.waitForFunction(() => (window.harnessUploads?.length ?? 0) >= 13, null, { timeout: 10_000 });
  await page.waitForTimeout(300);
  await step("desktop", "a second pick over the limit keeps the limit and says why", async () => {
    assert.equal(await chips(page).count(), ATTACHMENT_LIMIT, "The box holds more files than a message may carry.");
    const error = await composer(page).locator(".ws-composer-error").textContent();
    assert.match(error ?? "", /at most 10 files/u);
  });
  await page.context().close();
}

async function checkDrop(browser: Browser) {
  const page = await newPage(browser, false);
  const dropped = await dropFile(page, ".ws-layout-main .ws-message-list, .ws-layout-main", "notas del café.txt");
  await step("desktop", "a file dropped on the conversation goes up as a draft of its box", async () => {
    assert.deepEqual(dropped, { over: true, drop: true }, "The browser would leave the app to show the file.");
    await chips(page).first().waitFor({ timeout: 5_000 });
    assert.match(await chips(page).first().innerText(), /notas del café\.txt/u);
  });
  const before = (await uploads(page)).length;
  const elsewhere = await dropFile(page, ".ws-layout-sidebar", "otro.txt");
  await page.waitForTimeout(500);
  await step("desktop", "a file dropped on the sidebar stays in the app and attaches nowhere", async () => {
    assert.equal(elsewhere.drop, true, "The browser would leave the app to show the file.");
    assert.equal((await uploads(page)).length, before);
  });
  await page.context().close();
}

/** The bytes of a 2 by 2 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP438AARAwQCgAt7gX9iz9uhAAAAABJRU5ErkJggg==",
  "base64",
);

async function checkIphonePhoto(browser: Browser) {
  const page = await newPage(browser, true);
  const chooser = page.waitForEvent("filechooser", { timeout: 5_000 });
  await composer(page).getByRole("button", { name: "Attach files" }).tap();
  await (await chooser).setFiles([
    { name: "IMG_4021.HEIC", mimeType: "image/heic", buffer: PNG },
    { name: "IMG_4022.HEIC", mimeType: "image/heic", buffer: Buffer.from("not a photo") },
  ]);
  await page.waitForTimeout(1_500);
  await step("phone", "an iPhone photo the browser can draw goes up as a JPEG with its name", async () => {
    assert.deepEqual(await uploads(page), ["IMG_4021.jpeg"]);
    assert.match(await chips(page).first().innerText(), /IMG_4021\.jpeg/u);
  });
  await step("phone", "an iPhone photo the browser cannot draw is named as a refused type", async () => {
    assert.match((await composer(page).locator(".ws-composer-error").textContent()) ?? "", /IMG_4022\.HEIC/u);
  });
  await page.context().close();
}

async function checkPhoneViewer(browser: Browser) {
  const page = await newPage(browser, true);
  const cdp = await page.context().newCDPSession(page);
  const swipe = async (from: [number, number], to: [number, number]) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
    for (let index = 1; index <= 8; index += 1) {
      const x = from[0] + ((to[0] - from[0]) * index) / 8;
      const y = from[1] + ((to[1] - from[1]) * index) / 8;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(800);
  };
  const viewer = page.locator(".image-lightbox");
  await page.locator(".image-gallery-tile").first().tap();
  await viewer.waitFor({ timeout: 5_000 });
  await page.waitForTimeout(800);
  await step("phone", "a swipe to the left shows the next image", async () => {
    await swipe([300, 420], [60, 430]);
    assert.equal(await page.locator(".image-lightbox-position").textContent(), "2 of 2");
  });
  await step("phone", "a drag down closes the viewer", async () => {
    await swipe([195, 400], [200, 700]);
    await viewer.waitFor({ state: "detached", timeout: 3_000 });
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
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  await checkLimit(browser);
  await checkDrop(browser);
  await checkIphonePhoto(browser);
  await checkPhoneViewer(browser);
} finally {
  await browser?.close();
  await server.close();
  report.passed = report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  logger.info(report.passed ? "web-media-e2e passed" : "web-media-e2e failed", { out: OUT });
}
if (!report.passed) process.exit(1);
