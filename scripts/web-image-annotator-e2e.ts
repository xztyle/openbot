// Checks the image annotator in the web client, on a computer with a mouse and on an iPhone with real
// touch events (CDP `Input.dispatchTouchEvent`), against a mock host
// (`src/renderer/stories/web-client-annotate-harness.tsx`):
// 1. an image pasted in the message box opens in the annotator from its chip; an arrow, a rectangle
//    and a crop drawn on it, then Done, put a new image in the box in its place, with another size
//    and other pixel dimensions than the pasted one;
// 2. on a computer, the tool keys pick a tool and ⌘Z takes a stroke back;
// 3. an image an agent sent opens in the annotator from Annotate in the image viewer; a pen stroke
//    and "Send to agent" attach a new image to the message box, and the original message keeps its
//    image;
// 4. on the iPhone, two fingers zoom the image and draw nothing.
// It writes a screenshot of the open annotator in light and dark, for each device.
//
// `bun scripts/web-image-annotator-e2e.ts [--only=desktop|phone] [--browser-executable=<path>] [--headed] [--out=<dir>]`
// Writes report.json to .openbot-build/web-image-annotator-e2e, or to --out.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type CDPSession, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

interface HarnessImageUpload {
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
}

declare global {
  interface Window {
    harnessImageUploads?: HarnessImageUpload[];
  }
}

const logger = createOpenBotLogger("web-image-annotator-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const UI_WAIT_MS = 90_000;
const CHANNEL_PATH = "/app/general/c/general";
const PASTED_NAME = "captura.png";
const PASTED_WIDTH = 800;
const PASTED_HEIGHT = 600;
const AGENT_IMAGE = "maqueta-A1-pavo-al-horno.webp";

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const OUT = resolve(option("out") ?? resolve(ROOT, ".openbot-build/web-image-annotator-e2e"));

const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-annotate-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-web-annotate-harness",
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

interface Device {
  name: "desktop" | "phone";
  phone: boolean;
}

async function newPage(browser: Browser, device: Device, appearance: "light" | "dark"): Promise<Page> {
  const context = await browser.newContext(
    device.phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } },
  );
  await context.addInitScript((value) => {
    try {
      localStorage.setItem("visual.appearance", value);
    } catch {}
  }, appearance);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await page.goto(`${origin}${CHANNEL_PATH}`, { waitUntil: "commit", timeout: UI_WAIT_MS });
  await page.locator("[data-attachment-id]").first().waitFor({ timeout: UI_WAIT_MS });
  return page;
}

const composer = (page: Page): Locator => page.locator(".ws-layout-main .ws-composer-frame").last();
const editor = (page: Page): Locator => composer(page).locator("[contenteditable='true']").last();
const uploads = (page: Page) => page.evaluate(() => window.harnessImageUploads?.slice() ?? []);
const annotator = (page: Page): Locator => page.getByRole("dialog", { name: "Annotate image" });
const canvas = (page: Page): Locator => annotator(page).getByRole("img", { name: /^Drawing area over / });
const tool = (page: Page, name: string): Locator => annotator(page).getByRole("button", { name, exact: true });

/** Pastes a PNG with noise into the message box, as a screenshot from the clipboard. */
async function pasteImage(page: Page): Promise<void> {
  await editor(page).evaluate(
    async (element, input) => {
      const canvas = document.createElement("canvas");
      canvas.width = input.width;
      canvas.height = input.height;
      const draw = canvas.getContext("2d");
      if (!draw) throw new Error("No canvas context.");
      // Noise, so the PNG has a size that a drawing changes.
      const pixels = draw.createImageData(input.width, input.height);
      let seed = 7;
      for (let index = 0; index < pixels.data.length; index += 4) {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        const shade = 180 + (seed % 60);
        pixels.data[index] = shade;
        pixels.data[index + 1] = shade - 20;
        pixels.data[index + 2] = shade - 40;
        pixels.data[index + 3] = 255;
      }
      draw.putImageData(pixels, 0, 0);
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
      if (!blob) throw new Error("The canvas made no PNG.");
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([blob], input.name, { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    },
    { name: PASTED_NAME, width: PASTED_WIDTH, height: PASTED_HEIGHT },
  );
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point inside the canvas, as a share of its width and height. */
function at(box: Box, fx: number, fy: number): [number, number] {
  return [box.x + box.width * fx, box.y + box.height * fy];
}

/** Drags across the canvas with the mouse, or with one finger. */
async function drag(page: Page, cdp: CDPSession | null, from: [number, number], to: [number, number]): Promise<void> {
  const steps = 10;
  if (cdp) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
    for (let index = 1; index <= steps; index += 1) {
      const x = from[0] + ((to[0] - from[0]) * index) / steps;
      const y = from[1] + ((to[1] - from[1]) * index) / steps;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return;
  }
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let index = 1; index <= steps; index += 1) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * index) / steps, from[1] + ((to[1] - from[1]) * index) / steps);
  }
  await page.mouse.up();
}

/** Two fingers move apart over the canvas. */
async function pinch(page: Page, cdp: CDPSession, centre: [number, number]): Promise<void> {
  const steps = 8;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: centre[0] - 20, y: centre[1] },
      { x: centre[0] + 20, y: centre[1] },
    ],
  });
  for (let index = 1; index <= steps; index += 1) {
    const spread = 20 + index * 12;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: centre[0] - spread, y: centre[1] },
        { x: centre[0] + spread, y: centre[1] },
      ],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function press(target: Locator, phone: boolean): Promise<void> {
  if (phone) await target.tap();
  else await target.click();
}

/** The canvas, once the image is in it and it has a size on the screen. */
async function readyCanvas(page: Page): Promise<Box> {
  const picture = canvas(page);
  await picture.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const element = document.querySelector(".image-annotator-canvas");
      return element instanceof HTMLElement && element.getBoundingClientRect().width > 50;
    },
    null,
    { timeout: 15_000 },
  );
  const box = await picture.boundingBox();
  assert.ok(box, "The annotator shows no canvas.");
  return box;
}

async function shot(page: Page, label: string): Promise<void> {
  const path = resolve(OUT, `${label}.png`);
  await page.screenshot({ path });
  report.screenshots.push(path);
}

async function checkDevice(browser: Browser, device: Device): Promise<void> {
  const page = await newPage(browser, device, "light");
  const cdp = device.phone ? await page.context().newCDPSession(page) : null;
  try {
    await checkOnPage(page, cdp, device);
  } catch (error) {
    await shot(page, `${device.name}-failed`).catch(() => undefined);
    throw error;
  } finally {
    await page
      .context()
      .close()
      .catch(() => undefined);
  }
  await checkDark(browser, device);
}

async function checkOnPage(page: Page, cdp: CDPSession | null, device: Device): Promise<void> {
  // 1. A pasted image, annotated from its chip.
  await pasteImage(page);
  const chip = composer(page).getByRole("button", { name: `Annotate ${PASTED_NAME}` });
  await chip.waitFor({ timeout: 15_000 });
  const pasted = (await uploads(page)).find((upload) => upload.name === PASTED_NAME);
  assert.ok(pasted, "The pasted image did not go up.");
  await press(chip, device.phone);
  await annotator(page).waitFor({ timeout: 10_000 });
  const box = await readyCanvas(page);

  await press(tool(page, "Arrow"), device.phone);
  await drag(page, cdp, at(box, 0.15, 0.2), at(box, 0.6, 0.65));
  await press(tool(page, "Rectangle"), device.phone);
  await drag(page, cdp, at(box, 0.3, 0.3), at(box, 0.85, 0.8));
  if (!device.phone) {
    await step(device.name, "the tool keys pick a tool and ⌘Z takes a stroke back", async () => {
      await page.keyboard.press("e");
      assert.equal(await tool(page, "Ellipse").getAttribute("aria-pressed"), "true");
      await drag(page, cdp, at(box, 0.5, 0.1), at(box, 0.9, 0.4));
      await page.keyboard.press("ControlOrMeta+z");
      await page.keyboard.press("r");
      assert.equal(await tool(page, "Rectangle").getAttribute("aria-pressed"), "true");
    });
  }
  await press(tool(page, "Crop"), device.phone);
  await drag(page, cdp, at(box, 0.1, 0.1), at(box, 0.9, 0.9));
  await shot(page, `${device.name}-light-annotator`);
  await press(annotator(page).getByRole("button", { name: "Done" }), device.phone);
  await step(device.name, "Done on a pasted image puts a new, smaller image in its place", async () => {
    await annotator(page).waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForFunction(() => (window.harnessImageUploads?.length ?? 0) >= 2, null, { timeout: 15_000 });
    const list = await uploads(page);
    const result = list[list.length - 1];
    assert.ok(result, "No annotated image went up.");
    assert.equal(result.name, "captura-annotated.png");
    assert.equal(result.type, "image/png");
    assert.notEqual(result.size, pasted.size, "The annotated image has the size of the original.");
    assert.ok(
      result.width < PASTED_WIDTH && result.height < PASTED_HEIGHT,
      `The crop did not apply: ${result.width}×${result.height}.`,
    );
    assert.ok(result.width > 0 && result.height > 0, "The annotated image has no pixels.");
    await composer(page).getByRole("button", { name: "Annotate captura-annotated.png" }).waitFor({ timeout: 5_000 });
    assert.equal(
      await composer(page)
        .getByRole("button", { name: `Annotate ${PASTED_NAME}` })
        .count(),
      0,
    );
  });

  // 2. An agent's image, annotated from the viewer.
  const tile = page.locator(".image-gallery-tile").first();
  await press(tile, device.phone);
  const viewer = page.locator(".image-lightbox");
  await viewer.waitFor({ timeout: 10_000 });
  await press(viewer.getByRole("button", { name: "Annotate", exact: true }), device.phone);
  await annotator(page).waitFor({ timeout: 10_000 });
  const agentBox = await readyCanvas(page);
  if (cdp) {
    await step(device.name, "two fingers zoom the image and draw nothing", async () => {
      await pinch(page, cdp, at(agentBox, 0.5, 0.5));
      const zoomed = await page.evaluate(() => {
        const frame = document.querySelector(".image-annotator-frame");
        return frame instanceof HTMLElement ? frame.getBoundingClientRect().width : 0;
      });
      assert.ok(zoomed > agentBox.width * 1.1, `The image did not grow: ${zoomed} over ${agentBox.width}.`);
      // Back to the fitted size for the stroke below.
      await press(tool(page, "Move and zoom"), true);
      await drag(page, cdp, at(agentBox, 0.5, 0.5), at(agentBox, 0.5, 0.5));
    });
  }
  await press(tool(page, "Pen"), device.phone);
  await drag(page, cdp, at(agentBox, 0.2, 0.3), at(agentBox, 0.7, 0.5));
  const before = (await uploads(page)).length;
  await press(annotator(page).getByRole("button", { name: "Send to agent" }), device.phone);
  await step(device.name, "Send to agent attaches an annotated copy of the agent's image", async () => {
    await annotator(page).waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForFunction((count) => (window.harnessImageUploads?.length ?? 0) > count, before, {
      timeout: 15_000,
    });
    const list = await uploads(page);
    const result = list[list.length - 1];
    assert.ok(result, "No annotated image went up.");
    assert.equal(result.name, AGENT_IMAGE.replace(/\.webp$/u, "-annotated.png"));
    assert.equal(result.width, 1080);
    assert.equal(result.height, 1080);
    assert.ok(result.size > 0);
  });
  await step(device.name, "the viewer and the original message keep the image", async () => {
    assert.ok(await viewer.isVisible(), "The viewer closed with the annotator.");
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached", timeout: 5_000 });
    await composer(page)
      .getByRole("button", { name: "Annotate maqueta-A1-pavo-al-horno-annotated.png" })
      .waitFor({ timeout: 5_000 });
    assert.ok((await page.locator(".image-gallery-tile").count()) >= 2, "The message lost an image.");
  });
}

/** The annotator in dark, for the eye. */
async function checkDark(browser: Browser, device: Device): Promise<void> {
  const dark = await newPage(browser, device, "dark");
  const darkCdp = device.phone ? await dark.context().newCDPSession(dark) : null;
  await pasteImage(dark);
  const darkChip = composer(dark).getByRole("button", { name: `Annotate ${PASTED_NAME}` });
  await darkChip.waitFor({ timeout: 15_000 });
  await press(darkChip, device.phone);
  await annotator(dark).waitFor({ timeout: 10_000 });
  const darkBox = await readyCanvas(dark);
  await press(tool(dark, "Arrow"), device.phone);
  await drag(dark, darkCdp, at(darkBox, 0.2, 0.7), at(darkBox, 0.7, 0.3));
  await press(tool(dark, "Hide area"), device.phone);
  await drag(dark, darkCdp, at(darkBox, 0.55, 0.55), at(darkBox, 0.9, 0.9));
  await shot(dark, `${device.name}-dark-annotator`);
  await dark.context().close();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  // A cache of its own: the deploy suite runs several scripts at once, and a server that
  // rebuilds a shared cache for its own entries pulls the modules from under the others.
  cacheDir: "node_modules/.vite-e2e/web-image-annotator-e2e",
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: ["src/renderer/stories/web-client-annotate-harness.tsx"],
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
  for (const device of (
    [
      { name: "desktop", phone: false },
      { name: "phone", phone: true },
    ] as const
  ).filter((entry) => !only || entry.name === only)) {
    try {
      await checkDevice(browser, device);
    } catch (error) {
      report.steps.push({
        device: device.name,
        name: "the check ran to its end",
        passed: false,
        detail: String(error),
      });
      logger.error(`failed ${device.name}`, { error: String(error).slice(0, 800) });
    }
  }
} finally {
  await browser?.close();
  await server.close();
  report.passed = report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  logger.info(report.passed ? "web-image-annotator-e2e passed" : "web-image-annotator-e2e failed", { out: OUT });
}
if (!report.passed) process.exit(1);
