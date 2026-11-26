// Checks the one overlay system of the web client on a computer and on an iPhone, in dark and in
// light: a confirmation, a form dialog (a sheet on the phone), an action sheet and the image viewer.
// On each it checks that
// 1. the page under the overlay is dimmed and blurred, the same way for every overlay;
// 2. the focus is in the overlay and Tab stays in it;
// 3. the page under a dialog does not scroll (a computer's wheel);
// 4. Escape closes it, the exit copy leaves the page, and the page takes presses again;
// 5. a tap beside a dialog closes it, and a drag down closes a sheet (a finger, on the phone);
// 6. the image viewer copies the image that shows to the clipboard as PNG, calls the editor hook
//    ("Annotate") with the image and its URL, steps with the arrow keys, and closes on Escape and on
//    a swipe down (the phone).
// It serves `src/renderer/stories/overlay-system-harness.tsx` on a Vite server; no host is needed.
//
// `bun scripts/overlay-system-e2e.ts [--browser-executable=<path>] [--headed] [--before]`
// `--before` also saves screenshots with the overlay values of before this system, for a comparison.
// Writes .openbot-build/overlay-system-e2e/report.json and a screenshot of every overlay.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, type CDPSession, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("overlay-system-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/overlay-system-e2e");
const UI_WAIT_MS = 60_000;
const ENTRY = "/src/renderer/stories/overlay-system-harness.tsx";
/** The dim under an overlay is at least this opaque, so the page behind reads as "behind". */
const MIN_DIM = 0.3;
/** The overlay values before this system, for the `--before` screenshots. */
const BEFORE_CSS = `:root { --openbot-dialog-overlay: rgba(0, 0, 0, 0.1); --openbot-overlay-blur: 4px; }
:root[data-openbot-color-scheme="light"] { --openbot-dialog-overlay: rgba(20, 20, 20, 0.12); }
.image-lightbox-backdrop { background: var(--openbot-bg-overlay); backdrop-filter: none; }`;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${ENTRY}"></script>
  </body>
</html>`;

function harnessPage(): Plugin {
  return {
    name: "openbot-overlay-system-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        if (!/^\/overlays(?:[/?]|$)/u.test(url)) return next();
        const html = await server.transformIndexHtml(url, HTML);
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

interface Backdrop {
  overlay: string;
  dim: number;
  blur: string;
}

const report: {
  steps: Step[];
  backdrops: Backdrop[];
  pageErrors: string[];
  screenshots: string[];
  passed: boolean;
} = { steps: [], backdrops: [], pageErrors: [], screenshots: [], passed: false };

interface Point {
  x: number;
  y: number;
}

/** A finger on the screen, through the same path as a real touch screen's events. */
function finger(cdp: CDPSession) {
  const send = (type: "touchStart" | "touchMove" | "touchEnd", points: (Point & { id: number })[]) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  return {
    async dragDown(target: Page, from: Point, dy: number): Promise<void> {
      await send("touchStart", [{ ...from, id: 1 }]);
      for (let index = 1; index <= 10; index += 1) {
        await send("touchMove", [{ x: from.x, y: from.y + (dy * index) / 10, id: 1 }]);
        await target.waitForTimeout(16);
      }
      await send("touchEnd", []);
    },
  };
}

/** The alpha of a CSS colour, as `getComputedStyle` writes it. */
function alphaOf(color: string): number {
  const rgba = /rgba?\((?<body>[^)]*)\)/u.exec(color)?.groups?.body;
  if (!rgba) return color === "transparent" ? 0 : 1;
  const parts = rgba.split(/[\s,/]+/u).filter(Boolean);
  const alpha = parts[3];
  if (alpha === undefined) return 1;
  return alpha.endsWith("%") ? Number.parseFloat(alpha) / 100 : Number.parseFloat(alpha);
}

/** The dim and the blur of the overlay under the open dialog, as the page shows them. */
async function backdrop(page: Page, overlay: string): Promise<Backdrop> {
  const style = await page
    .locator(".ui-dialog-overlay")
    .last()
    .evaluate((element) => {
      const computed = getComputedStyle(element);
      return { background: computed.backgroundColor, blur: computed.backdropFilter };
    });
  const result = { overlay, dim: alphaOf(style.background), blur: style.blur };
  report.backdrops.push(result);
  return result;
}

/** Where the focus is: inside the open dialog or not. */
const focusInDialog = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest("[role=dialog], [role=alertdialog]") !== null);

const dialogs = (page: Page) => page.locator("[role=dialog], [role=alertdialog]");

/** Waits for every dialog and every exit copy to leave the page. */
async function waitClosed(page: Page): Promise<void> {
  await dialogs(page).first().waitFor({ state: "detached", timeout: 5000 });
  await page.locator("[data-overlay-closing], [data-closing]").first().waitFor({ state: "detached", timeout: 5000 });
}

async function shot(page: Page, name: string): Promise<void> {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path });
  report.screenshots.push(path);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const server = await createServer({
  root: ROOT,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  plugins: [harnessPage(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: { entries: [ENTRY.slice(1)], include: ["@norbert_bodziony/bloub"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${address.port}`;
let browser: Browser | null = null;

async function run(
  page: Page,
  device: "desktop" | "phone",
  scheme: "dark" | "light",
  touch?: ReturnType<typeof finger>,
) {
  const tag = `${device}-${scheme}`;
  const step = async (name: string, check: () => Promise<void>) => {
    try {
      await check();
      report.steps.push({ name: `${tag}: ${name}`, passed: true });
    } catch (error) {
      report.steps.push({ name: `${tag}: ${name}`, passed: false, detail: String(error).slice(0, 800) });
      await shot(page, `${tag}-failed-${report.steps.length}`).catch(() => undefined);
      // The next step starts from a page with nothing open.
      for (let index = 0; index < 3 && (await dialogs(page).count()) > 0; index += 1) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
    }
  };

  /** The backdrop of the confirmation of this run: every other overlay of the run must match it. */
  let first: Backdrop | undefined;
  await page.goto(`${origin}/overlays?scheme=${scheme}`, { waitUntil: "commit" });
  await page.getByRole("button", { name: "Open confirm" }).waitFor({ timeout: UI_WAIT_MS });
  await page.waitForTimeout(500);

  // 1. The confirmation.
  await step("a confirmation dims and blurs the page, holds the focus and locks the scroll", async () => {
    await page.getByRole("button", { name: "Open confirm" }).click();
    await page.locator("[role=alertdialog]").waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    const seen = await backdrop(page, "confirm");
    first = seen;
    assert.ok(seen.dim >= MIN_DIM, `The page under the confirmation is not dimmed: alpha ${seen.dim}.`);
    assert.match(seen.blur, /blur\(/u, `The page under the confirmation is not blurred: ${seen.blur}.`);
    assert.ok(await focusInDialog(page), "The focus is not in the confirmation.");
    for (let index = 0; index < 6; index += 1) await page.keyboard.press("Tab");
    assert.ok(await focusInDialog(page), "Tab left the confirmation.");
    if (device === "desktop") {
      await page.mouse.move(700, 700);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.scrollY), 0, "The page scrolled under the confirmation.");
    }
    await shot(page, `confirm-${tag}`);
  });
  await step("Escape closes the confirmation and the page takes presses again", async () => {
    await page.keyboard.press("Escape");
    await waitClosed(page);
    const pointer = await page.evaluate(() => getComputedStyle(document.body).pointerEvents);
    assert.notEqual(pointer, "none", "The page still takes no press after the confirmation closed.");
  });

  // 2. The form dialog: a sheet on the phone.
  await step("a form dialog dims and blurs the page the same way", async () => {
    await page.getByRole("button", { name: "Open form" }).click();
    await page.locator("[role=dialog]").waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    const seen = await backdrop(page, "form");
    assert.ok(
      first && Math.abs(first.dim - seen.dim) < 0.01,
      `The form's dim ${seen.dim} differs from the confirmation's.`,
    );
    assert.equal(seen.blur, first.blur, "The form's blur differs from the confirmation's.");
    assert.ok(await focusInDialog(page), "The focus is not in the form.");
    await shot(page, `form-${tag}`);
  });
  if (device === "phone" && touch) {
    await step("a drag down closes the sheet", async () => {
      const handle = await page.locator(".ui-sheet-handle").first().boundingBox();
      assert.ok(handle, "The sheet has no handle.");
      await touch.dragDown(page, { x: handle.x + handle.width / 2, y: handle.y + 4 }, 420);
      await waitClosed(page);
    });
  } else {
    await step("a click beside the dialog closes it", async () => {
      await page.mouse.click(40, 40);
      await waitClosed(page);
    });
  }

  // 3. The action sheet.
  await step("an action sheet dims and blurs the page the same way, and Escape closes it", async () => {
    await page.getByRole("button", { name: "Open sheet" }).click();
    await page.locator(".ui-sheet").waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    const seen = await backdrop(page, "sheet");
    assert.ok(
      first && Math.abs(first.dim - seen.dim) < 0.01,
      `The sheet's dim ${seen.dim} differs from the confirmation's.`,
    );
    await shot(page, `sheet-${tag}`);
    await page.keyboard.press("Escape");
    await waitClosed(page);
  });

  // 4. The image viewer.
  const openViewer = async () => {
    await page.locator(".image-gallery-tile").first().click();
    await page.locator(".image-lightbox-image:not(.image-lightbox-image-pending)").first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(700);
  };
  await step("the image viewer dims and blurs the page the same way", async () => {
    await openViewer();
    const seen = await backdrop(page, "lightbox");
    assert.ok(
      first && Math.abs(first.dim - seen.dim) < 0.01,
      `The viewer's dim ${seen.dim} differs from the confirmation's.`,
    );
    assert.equal(seen.blur, first.blur, "The viewer's blur differs from the confirmation's.");
    await shot(page, `lightbox-${tag}`);
  });
  await step("the arrow keys and the strip step through the images of the message", async () => {
    // A computer has arrow keys; a phone taps the strip under the image.
    if (device === "desktop") await page.keyboard.press("ArrowRight");
    else await page.locator(".image-lightbox-thumb").nth(1).click();
    await page.locator(".image-lightbox-position").getByText("2 of 3").waitFor({ timeout: 5000 });
    if (device === "desktop") await page.keyboard.press("ArrowLeft");
    else await page.locator(".image-lightbox-thumb").nth(0).click();
    await page.locator(".image-lightbox-position").getByText("1 of 3").waitFor({ timeout: 5000 });
  });
  await step("Copy puts the image on the clipboard as PNG", async () => {
    await page.getByRole("button", { name: "Copy image" }).click();
    await page.getByRole("button", { name: "Image copied" }).waitFor({ timeout: 10_000 });
    if (device === "desktop") {
      const types = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        return items.flatMap((item) => [...item.types]);
      });
      assert.ok(types.includes("image/png"), `The clipboard holds ${types.join(", ") || "nothing"}.`);
    }
  });
  await step("Annotate hands the image and its URL to the editor hook", async () => {
    await page.getByRole("button", { name: "Annotate" }).click();
    await page.waitForFunction(() => document.body.dataset.annotated === "dashboard", undefined, { timeout: 5000 });
    const url = await page.evaluate(() => document.body.dataset.annotatedUrl ?? "");
    assert.match(url, /^data:image\/svg\+xml/u, `The hook got the URL ${url}.`);
  });
  await step("Escape closes the viewer and gives the focus back to the thumbnail", async () => {
    await page.keyboard.press("Escape");
    await waitClosed(page);
    await page.waitForTimeout(300);
    const focused = await page.evaluate(() => document.activeElement?.className ?? "");
    assert.match(focused, /image-gallery-tile/u, `The focus went to "${focused}".`);
  });
  if (device === "phone" && touch) {
    await step("a swipe down closes the viewer", async () => {
      await openViewer();
      const stage = await page.locator(".image-lightbox-stage").boundingBox();
      assert.ok(stage, "The viewer has no stage.");
      await touch.dragDown(page, { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 }, 240);
      await waitClosed(page);
    });
  }

  if (flag("before")) {
    await page.addStyleTag({ content: BEFORE_CSS });
    await page.getByRole("button", { name: "Open confirm" }).click();
    await page.locator("[role=alertdialog]").waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    await shot(page, `before-confirm-${tag}`);
    await page.keyboard.press("Escape");
    await waitClosed(page);
    await openViewer();
    await shot(page, `before-lightbox-${tag}`);
    await page.keyboard.press("Escape");
    await waitClosed(page);
  }
}

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !flag("headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  for (const scheme of ["dark", "light"] as const) {
    const desktop: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: scheme,
    });
    await desktop.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await desktop.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
    await run(page, "desktop", scheme);
    await desktop.close();

    const phone: BrowserContext = await browser.newContext({
      ...iphone,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      colorScheme: scheme,
    });
    await phone.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const phonePage = await phone.newPage();
    phonePage.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
    await run(phonePage, "phone", scheme, finger(await phone.newCDPSession(phonePage)));
    await phone.close();
  }
  report.passed = report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}

logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps. Report: ${resolve(OUT, "report.json")}`,
);
process.exit(report.passed ? 0 : 1);
