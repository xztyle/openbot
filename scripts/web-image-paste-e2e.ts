// Checks that an image the owner pastes in the chat with an agent shows as an image, in the web client
// on a computer and on a phone, against the mock host of
// `src/renderer/stories/web-client-image-paste-harness.tsx`:
// 1. a pasted PNG of more than 4 MB goes in the row of files of the message box, and the text of the
//    box gets no file marker; the image there opens in the annotator;
// 2. after Send, the host gets the owner's words only, with the file beside them;
// 3. the sent message shows the image inline, from the host's small copy, and no file card; its
//    text has no file name and no "@";
// 4. a right-click (a long press on the phone) on the image offers Copy image and Annotate;
// 5. a tap on the image opens the viewer;
// 6. an older message whose text holds a file marker shows its words without the marker, and its
//    image under them.
//
// `bun scripts/web-image-paste-e2e.ts [--only=desktop|phone] [--browser-executable=<path>] [--headed] [--out=<dir>]`
// Writes report.json and a screenshot of each device to .openbot-build/web-image-paste-e2e, or to --out.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type CDPSession, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

declare global {
  interface Window {
    harnessImagePaste?: {
      sent: { text: string; attachmentIds: string[] }[];
      reads: { id: string; variant: "full" | "inline"; bytes: number }[];
    };
  }
}

const logger = createOpenBotLogger("web-image-paste-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const UI_WAIT_MS = 90_000;
const HOLD_MS = 700;
const DM_PATH = "/app/general/dm/research";
const PASTED_NAME = "Screenshot 2026-11-26 at 12.11.04.png";
const WORDS = "quitale eso por favor";
const english = translateFor("en");

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const OUT = resolve(option("out") ?? resolve(ROOT, ".openbot-build/web-image-paste-e2e"));

const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-image-paste-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-web-image-paste-harness",
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

const report: {
  steps: Step[];
  screenshots: string[];
  pageErrors: string[];
  pastedBytes: number;
  passed: boolean;
} = { steps: [], screenshots: [], pageErrors: [], pastedBytes: 0, passed: false };

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

async function shot(page: Page, label: string): Promise<void> {
  const path = resolve(OUT, `${label}.png`);
  await page.screenshot({ path });
  report.screenshots.push(path);
}

const main = (page: Page): Locator => page.locator("body");
const editor = (page: Page): Locator => page.getByRole("textbox", { name: "Message Research", exact: true });
/** The pasted image in the row of files over the message box. */
const composerImage = (page: Page): Locator =>
  page.getByRole("button", { name: english("chat.image.annotateFile", { name: PASTED_NAME }), exact: true });
const menu = (page: Page): Locator => page.getByRole("menu", { name: english("workspace.message.more") });
const sheet = (page: Page): Locator => page.locator(".ui-dialog-content.ui-sheet");
/** The first row with these words: the agent's mock answer can repeat them. */
const row = (page: Page, words: string): Locator =>
  main(page).locator(".ws-message").filter({ hasText: words }).first();

/** Pastes a PNG of noise, larger than 4 MB, in the message box, as a screenshot from the clipboard. */
async function pasteBigImage(page: Page): Promise<number> {
  return editor(page).evaluate(async (element, name) => {
    const width = 1500;
    const height = 1100;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const draw = canvas.getContext("2d");
    if (!draw) throw new Error("No canvas context.");
    const pixels = draw.createImageData(width, height);
    // Noise does not compress, so the PNG is larger than 4 MB.
    for (let offset = 0; offset < pixels.data.length; offset += 65_536)
      crypto.getRandomValues(pixels.data.subarray(offset, Math.min(offset + 65_536, pixels.data.length)));
    for (let index = 3; index < pixels.data.length; index += 4) pixels.data[index] = 255;
    draw.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
    if (!blob) throw new Error("The canvas made no PNG.");
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([blob], name, { type: "image/png" }));
    element.focus();
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    return blob.size;
  }, PASTED_NAME);
}

async function checkDevice(browser: Browser, phone: boolean): Promise<void> {
  const device = phone ? "phone" : "desktop";
  const context = await browser.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(`${device}: ${error.stack ?? error.message}`));
  const cdp: CDPSession | null = phone ? await context.newCDPSession(page) : null;
  try {
    await page.goto(`${origin}${DM_PATH}`, { waitUntil: "commit", timeout: UI_WAIT_MS });
    await editor(page).waitFor({ timeout: UI_WAIT_MS });

    await step(device, "an older message shows its words without the file marker, and its image", async () => {
      const legacy = row(page, "quitale eso");
      await legacy.waitFor({ timeout: 15_000 });
      await legacy.locator("[data-attachment-id='legacy-image'] img[src]").first().waitFor({ timeout: 15_000 });
      const text = (await legacy.locator(".message-content-blocks").innerText()).trim();
      assert.equal(text.replace(/\s+/gu, " "), "quitale eso de la foto", `The text reads: ${text}`);
      assert.equal(await legacy.locator(".message-content-blocks [data-file-tone]").count(), 0, "A file chip shows.");
      assert.equal(await legacy.locator(".message-attachment").count(), 0, "The image shows as a file card.");
    });

    await editor(page).click();
    await page.keyboard.type(WORDS);
    report.pastedBytes = await pasteBigImage(page);
    await step(device, "a pasted image goes in the row of files, not in the text", async () => {
      assert.ok(report.pastedBytes > 4 * 1024 * 1024, `The PNG has only ${report.pastedBytes} bytes.`);
      await composerImage(page).waitFor({ timeout: 30_000 });
      assert.equal(
        await editor(page).locator("[data-attachment-reference-id]").count(),
        0,
        "A file chip is in the text.",
      );
      const typed = (await editor(page).innerText()).trim();
      assert.equal(typed, WORDS, `The box reads: ${typed}`);
    });

    await step(device, "the pasted image opens in the annotator from the row of files", async () => {
      if (phone) await composerImage(page).tap();
      else await composerImage(page).click();
      const annotator = page.getByRole("dialog", { name: "Annotate image" });
      await annotator.waitFor({ timeout: 10_000 });
      await annotator.getByRole("img", { name: /^Drawing area over / }).waitFor({ timeout: 15_000 });
      await page.keyboard.press("Escape");
      await annotator.waitFor({ state: "detached", timeout: 5_000 });
    });

    // On a phone, Return makes a new line, so the send button sends.
    if (phone) await page.getByRole("button", { name: english("composer.send.message"), exact: true }).tap();
    else await editor(page).press("Enter");
    await step(device, "the host gets the words only, with the file beside them", async () => {
      await page.waitForFunction(() => (window.harnessImagePaste?.sent.length ?? 0) > 0, null, { timeout: 15_000 });
      const sent = await page.evaluate(() => window.harnessImagePaste?.sent.at(-1));
      assert.ok(sent, "Nothing went to the host.");
      assert.equal(sent.text.trim(), WORDS);
      assert.equal(sent.attachmentIds.length, 1);
    });

    const message = row(page, WORDS);
    const image = message.locator("[data-attachment-id] img[src]").first();
    await step(device, "the sent message shows the image inline, from the host's small copy", async () => {
      await image.waitFor({ timeout: 30_000 });
      await page.waitForFunction(
        (element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
        await image.elementHandle(),
        { timeout: 15_000 },
      );
      assert.equal(await message.locator(".message-attachment").count(), 0, "The image shows as a file card.");
      const text = (await message.locator(".message-content-blocks").innerText()).trim();
      assert.equal(text, WORDS, `The text reads: ${text}`);
      assert.ok(!text.includes("@") && !text.includes("Screenshot"), `A file reference shows: ${text}`);
      const reads = await page.evaluate(() => window.harnessImagePaste?.reads ?? []);
      const inline = reads.find((read) => read.variant === "inline");
      assert.ok(inline, `The chat did not read the small copy: ${JSON.stringify(reads)}`);
      assert.ok(inline.bytes < 1024 * 1024, `The small copy has ${inline.bytes} bytes.`);
      await shot(page, `${device}-sent-image`);
    });

    await step(device, "the image's menu offers Copy image and Annotate", async () => {
      await image.scrollIntoViewIfNeeded();
      let items: string[];
      if (cdp) {
        const box = await image.boundingBox();
        assert.ok(box, "The image has no box.");
        const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
        await page.waitForTimeout(HOLD_MS);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sheet(page).waitFor({ timeout: 5_000 });
        items = await sheet(page).locator(".ui-sheet-item").allInnerTexts();
      } else {
        await image.click({ button: "right" });
        await menu(page).waitFor({ timeout: 5_000 });
        items = await menu(page).getByRole("menuitem").allInnerTexts();
      }
      await shot(page, `${device}-image-menu`);
      const labels = items.map((item) => item.trim());
      assert.equal(labels[0], english("workspace.context.copyImage"), `The menu: ${labels.join(", ")}`);
      assert.ok(labels.includes(english("workspace.context.annotate")), `No Annotate: ${labels.join(", ")}`);
      await page.keyboard.press("Escape");
      await (cdp ? sheet(page) : menu(page)).waitFor({ state: "hidden", timeout: 5_000 });
    });

    await step(device, "a tap on the image opens the viewer", async () => {
      if (phone) await image.tap();
      else await image.click();
      const viewer = page.locator(".image-lightbox");
      await viewer.waitFor({ timeout: 10_000 });
      await viewer.getByRole("button", { name: "Annotate", exact: true }).waitFor({ timeout: 5_000 });
      await page.keyboard.press("Escape");
      await viewer.waitFor({ state: "detached", timeout: 5_000 });
    });
  } catch (error) {
    await shot(page, `${device}-failed`).catch(() => undefined);
    throw error;
  } finally {
    await context.close().catch(() => undefined);
  }
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
    entries: ["src/renderer/stories/web-client-image-paste-harness.tsx"],
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
  for (const phone of [false, true].filter((value) => !only || (only === "phone") === value)) {
    try {
      await checkDevice(browser, phone);
    } catch (error) {
      report.steps.push({
        device: phone ? "phone" : "desktop",
        name: "the check ran to its end",
        passed: false,
        detail: String(error),
      });
      logger.error(`failed ${phone ? "phone" : "desktop"}`, { error: String(error).slice(0, 800) });
    }
  }
} finally {
  await browser?.close();
  await server.close();
  report.passed = report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  logger.info(report.passed ? "web-image-paste-e2e passed" : "web-image-paste-e2e failed", { out: OUT });
}
if (!report.passed) process.exit(1);
