// Checks the previews of a message's files in the web client, on a computer and on a phone (touch):
// - a video shows its first frame with a play button, plays in the message, and the viewer has the
//   player with a speed button;
// - an audio file shows a waveform player;
// - a PDF, a deck, a document and a spreadsheet show a picture of their first page; the viewer shows
//   the pages (page steps, zoom and search), the deck as slides with a rail, the sheet with its tabs;
// - a ZIP opens as a folder tree, and a file in it opens in the same viewer;
// - a CSV opens as a table and Markdown renders, with no script from the file;
// - the viewer steps to the next file with the arrow key (computer) or a swipe (phone) and closes on
//   Escape or a swipe down;
// - the message text names no file: the files show only as previews.
// It serves `src/renderer/stories/file-previews-harness.tsx` on a Vite server; no host is needed.
// The renditions are the ones `scripts/file-renditions-e2e.ts --out` made with the real tools.
//
// `bun scripts/file-previews-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/file-previews-e2e/report.json and a screenshot of each viewer.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type CDPSession, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("file-previews-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/file-previews-e2e");
const ENTRY = "/src/renderer/stories/file-previews-harness.tsx";
const WAIT = 20_000;

const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

const HTML = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Atelier</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${ENTRY}"></script>
  </body>
</html>`;

function harnessPage(): Plugin {
  return {
    name: "openbot-file-previews-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        // The fixture files, through Vite's own file server, which answers range requests.
        if (url.startsWith("/__fixtures/")) {
          request.url = `/@fs${ROOT}/scripts/fixtures/${url.slice("/__fixtures/".length)}`;
          return next();
        }
        if (!/^\/files(?:[/?]|$)/u.test(url)) return next();
        const html = await server.transformIndexHtml(url, HTML);
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      });
    },
  };
}

const report: { steps: { name: string; passed: boolean; detail?: string }[]; pageErrors: string[]; passed: boolean } = {
  steps: [],
  pageErrors: [],
  passed: false,
};

/** A finger on the screen, through the same path as a real touch screen's events. */
function finger(cdp: CDPSession) {
  const send = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number; id: number }[]) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  return async (page: Page, from: { x: number; y: number }, dx: number, dy: number) => {
    await send("touchStart", [{ ...from, id: 1 }]);
    for (let index = 1; index <= 10; index += 1) {
      await send("touchMove", [{ x: from.x + (dx * index) / 10, y: from.y + (dy * index) / 10, id: 1 }]);
      await page.waitForTimeout(16);
    }
    await send("touchEnd", []);
  };
}

mkdirSync(OUT, { recursive: true });
rmSync(resolve(OUT, "report.json"), { force: true });

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

async function run(page: Page, device: "desktop" | "phone", swipe?: ReturnType<typeof finger>) {
  const step = async (name: string, check: () => Promise<void>) => {
    try {
      await check();
      report.steps.push({ name: `${device}: ${name}`, passed: true });
    } catch (error) {
      report.steps.push({ name: `${device}: ${name}`, passed: false, detail: String(error).slice(0, 800) });
      await page
        .screenshot({ path: resolve(OUT, `${device}-failed-${report.steps.length}.png`) })
        .catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  };
  const dialog = page.getByRole("dialog");
  const card = (name: string) =>
    page.locator(".message-attachment", { has: page.locator("strong", { hasText: name }) });
  const imageLoaded = (name: string) =>
    card(name)
      .locator("img.attachment-rendition")
      .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0);
  const openCard = async (name: string) => {
    await card(name).locator(".attachment-preview-button, [data-attachment-id]").first().click();
    await dialog.waitFor({ timeout: WAIT });
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: WAIT });
  };
  const shot = (name: string) => page.screenshot({ path: resolve(OUT, `${device}-${name}.png`) });

  await page.goto(`${origin}/files`);
  await page.locator(".message-attachment").first().waitFor({ timeout: 60_000 });

  await step("the message text names no file", async () => {
    const text = await page.locator(".message-markdown, .message-text").first().innerText();
    for (const name of ["clip.mp4", "sample.pdf", "deck.pptx", "proyecto.zip", "notas.md", "@"])
      assert.ok(!text.includes(name), `the text shows ${name}: ${text}`);
    assert.equal(await page.locator(".message-attachment").count(), 11, "not every file has a preview");
    await page.waitForFunction(() => document.querySelectorAll("img.attachment-rendition").length >= 5, undefined, {
      timeout: WAIT,
    });
    await page.screenshot({ path: resolve(OUT, `${device}-timeline.png`), fullPage: true });
  });

  await step("video: first frame, plays in the message, viewer with speed", async () => {
    await page.waitForFunction(
      () => {
        const image = document.querySelector<HTMLImageElement>('[data-view="video"] img.attachment-rendition');
        return Boolean(image?.complete && image.naturalWidth > 0);
      },
      undefined,
      { timeout: WAIT },
    );
    await card("clip.mp4")
      .getByRole("button", { name: /Reproducir/u })
      .click();
    const video = card("clip.mp4").locator("video");
    await video.waitFor({ timeout: WAIT });
    await page.waitForFunction(
      () => (document.querySelector<HTMLVideoElement>('[data-view="video"] video')?.readyState ?? 0) >= 1,
      undefined,
      { timeout: WAIT },
    );
    await card("clip.mp4")
      .getByRole("button", { name: /Ampliar/u })
      .click();
    await dialog.waitFor({ timeout: WAIT });
    await dialog.locator("video").waitFor({ timeout: WAIT });
    await dialog.getByRole("button", { name: /Velocidad 1×/u }).click();
    await dialog.getByRole("button", { name: /Velocidad 1,25×|Velocidad 1.25×/u }).waitFor({ timeout: WAIT });
    assert.match(await dialog.locator(".file-preview-meta").innerText(), /Lucía/u);
    await shot("video");
    await close();
  });

  await step("audio: a waveform player", async () => {
    await page.waitForFunction(
      () => document.querySelectorAll('[data-view="audio"] .attachment-waveform-bar').length === 48,
    );
    await card("voice.mp3")
      .getByRole("button", { name: /Reproducir voice.mp3/u })
      .waitFor({ timeout: WAIT });
  });

  await step("pdf: first page, pages with steps, zoom and search", async () => {
    await page.waitForFunction(
      () => {
        const image = document.querySelector<HTMLImageElement>('[data-view="pdf"] img.attachment-rendition');
        return Boolean(image?.complete && image.naturalWidth > 0);
      },
      undefined,
      { timeout: WAIT },
    );
    await openCard("sample.pdf");
    await dialog.locator(".pdf-page canvas").first().waitFor({ timeout: WAIT });
    await dialog.getByText("1 / 2").waitFor({ timeout: WAIT });
    await dialog.getByRole("button", { name: "Acercar" }).click();
    await dialog.getByRole("button", { name: "Página siguiente" }).click();
    await dialog.getByText("2 / 2").waitFor({ timeout: WAIT });
    await dialog.getByRole("searchbox", { name: "Buscar en el documento" }).fill("presupuesto");
    await page.keyboard.press("Enter");
    await dialog.getByText("1 de 1").waitFor({ timeout: WAIT });
    await shot("pdf");
    await close();
  });

  await step("pptx: first slide, a deck with a rail and slide steps", async () => {
    assert.ok(await imageLoaded("deck.pptx"), "the deck has no first slide");
    await openCard("deck.pptx");
    await dialog.locator(".pdf-viewer-rail .pdf-viewer-thumb").nth(2).waitFor({ timeout: WAIT });
    assert.equal(await dialog.locator(".pdf-viewer-thumb").count(), 3);
    await dialog.getByText("1 / 3").waitFor({ timeout: WAIT });
    await dialog.getByRole("button", { name: "Diapositiva siguiente" }).click();
    await dialog.getByText("2 / 3").waitFor({ timeout: WAIT });
    if (device === "desktop") {
      await dialog.locator(".pdf-viewer-pages").focus();
      await page.keyboard.press("ArrowRight");
      await dialog.getByText("3 / 3").waitFor({ timeout: WAIT });
    }
    await shot("pptx");
    await close();
  });

  await step("docx: first page, pages", async () => {
    assert.ok(await imageLoaded("report.docx"), "the document has no first page");
    await openCard("report.docx");
    await dialog.locator(".pdf-viewer[data-layout='pages'] .pdf-page canvas").first().waitFor({ timeout: WAIT });
    await shot("docx");
    await close();
  });

  await step("xlsx and xls: first page, a sheet grid with tabs", async () => {
    assert.ok(await imageLoaded("budget.xlsx"), "the sheet has no picture");
    await openCard("budget.xlsx");
    await dialog.getByRole("button", { name: "Gastos" }).click();
    await dialog.getByText("Oficina").waitFor({ timeout: WAIT });
    await shot("xlsx");
    await close();
    await openCard("presupuesto.xls");
    await dialog.getByRole("button", { name: "Ventas" }).waitFor({ timeout: WAIT });
    await close();
  });

  await step("zip: a tree, a file in it opens in the viewer, back and download all", async () => {
    await openCard("proyecto.zip");
    await dialog.getByText("4 archivos").waitFor({ timeout: WAIT });
    await dialog.getByRole("button", { name: /src/u }).click();
    await dialog.getByRole("button", { name: /app\.ts/u }).click();
    await dialog.getByText("Hola").waitFor({ timeout: WAIT });
    await dialog.getByRole("button", { name: "Atrás" }).click();
    await dialog.getByRole("button", { name: /^docs/u }).click();
    await dialog.getByRole("button", { name: /contrato\.pdf/u }).click();
    await dialog.locator(".pdf-page canvas").first().waitFor({ timeout: WAIT });
    await shot("zip-entry");
    await dialog.getByRole("button", { name: "Atrás" }).click();
    await dialog.getByRole("button", { name: "Descargar todo" }).click();
    await page.waitForFunction(() =>
      document.querySelector(".harness-downloads")?.textContent?.includes("proyecto.zip"),
    );
    await close();
    await openCard("codigo.tar.gz");
    await dialog.getByRole("button", { name: /main\.py/u }).waitFor({ timeout: WAIT });
    await close();
  });

  await step("csv: a table", async () => {
    await openCard("ventas.csv");
    await dialog.getByRole("columnheader", { name: "Mes" }).waitFor({ timeout: WAIT });
    await dialog.getByRole("cell", { name: "1,050" }).waitFor({ timeout: WAIT });
    await close();
  });

  await step("markdown: rendered, no script from the file", async () => {
    await openCard("notas.md");
    await dialog.getByRole("heading", { name: "Notas de la reunión" }).waitFor({ timeout: WAIT });
    assert.equal(await dialog.locator("script").count(), 0, "a script from the file is in the page");
    await shot("markdown");
    await close();
  });

  await step("the viewer steps through the message's files and closes", async () => {
    await openCard("sample.pdf");
    await dialog.getByText("3 de 11").waitFor({ timeout: WAIT });
    if (swipe) {
      const box = await dialog.locator(".file-preview-header").boundingBox();
      assert.ok(box);
      await swipe(page, { x: box.x + box.width * 0.8, y: box.y + box.height / 2 }, -200, 0);
      await dialog.getByText("4 de 11").waitFor({ timeout: WAIT });
      await swipe(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 0, 220);
      await dialog.waitFor({ state: "detached", timeout: WAIT });
    } else {
      await dialog.locator(".file-preview-header").click();
      await page.keyboard.press("ArrowRight");
      await dialog.getByText("4 de 11").waitFor({ timeout: WAIT });
      await close();
    }
  });
}

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({ headless: !flag("headed"), ...(executablePath ? { executablePath } : {}) });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const page = await desktop.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await run(page, "desktop");
  await desktop.close();

  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  const phone = await browser.newContext({
    ...iphone,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme: "dark",
  });
  const phonePage = await phone.newPage();
  phonePage.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await run(phonePage, "phone", finger(await phone.newCDPSession(phonePage)));
  await phone.close();
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
