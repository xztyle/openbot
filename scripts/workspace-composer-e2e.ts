// Checks the workspace message box on the web client against a mock host
// (`src/renderer/stories/web-client-inbox-harness.tsx`), on an iPhone and on a computer: a message
// that waits in the outbox keeps its files through Edit, two tabs that send while offline both
// deliver, an edit in place hides a pasted password as the message box does, and an agent DM that
// cannot send yet leaves its draft alone. Send waits for a file that is still uploading, and many
// waiting messages leave the header and the box on a phone's screen. Deleting a message whose
// edit is open on a phone ends the edit.
//
// `bun scripts/workspace-composer-e2e.ts [--browser-executable=<path>] [--headed] [--out=<dir>]`
// Writes report.json to .openbot-build/workspace-composer-e2e, or to --out.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("workspace-composer-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const UI_WAIT_MS = 60_000;
const CHANNEL_PATH = "/app/general/c/general";
const DM_PATH = "/app/general/dm/chief";

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const OUT = resolve(option("out") ?? resolve(ROOT, ".openbot-build/workspace-composer-e2e"));

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
    name: "openbot-workspace-composer-harness",
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

declare global {
  interface Window {
    /** The harness's connection, from `web-client-inbox-harness.tsx`. */
    harnessConnection?: {
      drop(holdMs: number): void;
      phase(phase: "idle" | "starting" | "ready" | "restarting" | "blocked" | "stopped"): void;
      sent: { operationId: string; text: string }[];
    };
    /** How long the harness takes for each upload. */
    harnessUploadMs?: number;
  }
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
  } catch (error) {
    report.steps.push({ device, name, passed: false, detail: String(error).slice(0, 800) });
  }
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(250);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

const composer = (page: Page) => page.locator(".ws-composer, .composer").filter({ visible: true }).last();
const editor = (page: Page) => composer(page).locator(".composer-editor-surface").first();
const outbox = (page: Page) => page.locator(".ws-outbox-message").filter({ visible: true });
const sentCount = (page: Page, text: string) =>
  page.evaluate((body) => window.harnessConnection?.sent.filter((item) => item.text === body).length ?? 0, text);

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

async function newDevice(browser: Browser, phone: boolean): Promise<BrowserContext> {
  const context = await browser.newContext(
    phone
      ? {
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 2,
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        }
      : { viewport: { width: 1440, height: 900 } },
  );
  return context;
}

async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  return page;
}

async function press(page: Page, phone: boolean, name: string) {
  const button = composer(page).getByRole("button", { name, exact: true });
  if (phone) await button.tap();
  else await button.click();
}

/** A message with a file waits for the connection; Edit takes back its text and its file. */
async function checkOutboxEditKeepsFiles(page: Page, device: string, phone: boolean) {
  await load(page, `${CHANNEL_ORIGIN()}${CHANNEL_PATH}`);
  if (phone) await editor(page).tap();
  else await editor(page).click();
  const chooser = page.waitForEvent("filechooser", { timeout: 5_000 });
  await press(page, phone, "Attach files");
  await (await chooser).setFiles({ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("the plan\n") });
  await composer(page).locator(".ws-composer-file").first().waitFor({ timeout: 10_000 });
  await editor(page).focus();
  await page.keyboard.type("con archivo");
  await page.evaluate(() => window.harnessConnection?.drop(60_000));
  await page.waitForTimeout(100);
  await press(page, phone, "Send");
  await outbox(page).first().waitFor({ timeout: 3_000 });
  await step(device, "a sent message with a file leaves the box empty, its file too", async () => {
    assert.equal((await editor(page).innerText()).trim(), "");
    assert.equal(await composer(page).locator(".ws-composer-file").count(), 0);
  });
  const edit = outbox(page).first().getByRole("button", { name: "Edit" });
  if (phone) await edit.tap();
  else await edit.click();
  await settle(page);
  await step(device, "Edit on a waiting message puts its text and its file back in the box", async () => {
    assert.equal(await outbox(page).count(), 0, "The message still waits.");
    assert.equal((await editor(page).innerText()).trim(), "con archivo");
    const files = composer(page).locator(".ws-composer-file");
    assert.equal(await files.count(), 1, "The file of the message is gone.");
    assert.match(await files.first().innerText(), /plan\.txt/u);
  });
}

/** A photo on its way up holds Send, so the message does not leave without it. */
async function checkSendWaitsForUpload(page: Page, device: string, phone: boolean) {
  await load(page, `${CHANNEL_ORIGIN()}${CHANNEL_PATH}`);
  if (phone) await editor(page).tap();
  else await editor(page).click();
  await page.keyboard.type("mira la foto");
  await page.evaluate(() => {
    window.harnessUploadMs = 2_500;
  });
  const chooser = page.waitForEvent("filechooser", { timeout: 5_000 });
  await press(page, phone, "Attach files");
  await (await chooser).setFiles({ name: "foto.png", mimeType: "image/png", buffer: Buffer.from("png") });
  await page.waitForTimeout(300);
  await step(device, "while a file uploads, the box says so and Send waits", async () => {
    await composer(page)
      .getByRole("status")
      .filter({ hasText: /Uploading 1 of 1/u })
      .waitFor({ timeout: 2_000 });
    assert.equal(await composer(page).getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
    // Typing goes on meanwhile.
    if (phone) await editor(page).tap();
    else await editor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" ya");
    assert.equal((await editor(page).innerText()).trim(), "mira la foto ya");
  });
  await composer(page).locator(".ws-composer-file").first().waitFor({ timeout: 10_000 });
  await step(device, "once the file is up, Send sends the text with the file", async () => {
    await press(page, phone, "Send");
    await page.locator(".ws-message").filter({ hasText: "mira la foto ya" }).first().waitFor({ timeout: 10_000 });
    assert.equal(await composer(page).locator(".ws-composer-file").count(), 0, "The file stayed in the box.");
  });
  await page.evaluate(() => {
    window.harnessUploadMs = 0;
  });
}

/**
 * Many messages that wait for the connection scroll in their own list on a phone: the header, with
 * its back button, and the box stay on screen, and the newest message shows.
 */
async function checkManyWaitingFit(page: Page, device: string) {
  await load(page, `${CHANNEL_ORIGIN()}${CHANNEL_PATH}`);
  await page.evaluate(() => window.harnessConnection?.drop(120_000));
  await page.waitForTimeout(200);
  await editor(page).tap();
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.type(
      `Mensaje ${index} que es bastante largo para ocupar varias lineas en la pantalla del telefono`,
    );
    await press(page, true, "Send");
    await page.waitForTimeout(100);
  }
  await settle(page);
  await step(device, "eight waiting messages keep the header and the box on screen", async () => {
    const height = await page.evaluate(() => window.innerHeight);
    const header = await page.locator(".ws-channel-header").first().boundingBox();
    const box = await composer(page).boundingBox();
    assert.ok(header && header.y >= 0, `The header is at ${header?.y}px.`);
    assert.ok(box && box.y + box.height <= height + 1, `The box ends at ${box ? box.y + box.height : "?"}px.`);
    const newest = outbox(page).filter({ hasText: "Mensaje 7 " });
    assert.ok(await newest.isVisible(), "The newest waiting message is not shown.");
    const rect = await newest.boundingBox();
    const list = await page.locator(".ws-outbox").first().boundingBox();
    assert.ok(rect && list && rect.y + rect.height <= list.y + list.height + 1, "The newest message is scrolled away.");
  });
}

/** Holds a finger on an element, as a long press on a phone. */
async function longPress(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const rect = await target.boundingBox();
  assert.ok(rect, "Nothing to press.");
  const point = { x: rect.x + 30, y: rect.y + rect.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await settle(page);
}

/** On a phone, a message deleted while its edit is open in the box ends the edit. */
async function checkDeleteEndsEdit(page: Page, device: string) {
  await load(page, `${CHANNEL_ORIGIN()}${CHANNEL_PATH}`);
  await editor(page).tap();
  await page.keyboard.type("mensaje para borrar");
  await press(page, true, "Send");
  const sent = page.locator(".ws-message").filter({ hasText: "mensaje para borrar" }).first();
  await sent.waitFor({ timeout: 10_000 });
  const text = sent.getByText("mensaje para borrar").first();
  await longPress(page, text);
  await page.getByText("Edit message", { exact: true }).first().tap();
  await settle(page);
  await page.locator(".ws-composer-editing").waitFor({ timeout: 5_000 });
  await longPress(page, text);
  await page.getByText("Delete message", { exact: true }).first().tap();
  await settle(page);
  await page.getByRole("button", { name: "Delete message" }).last().tap();
  await settle(page);
  await step(device, "deleting the message whose edit is open ends the edit, and the box takes its draft", async () => {
    await page.locator(".ws-composer-editing").waitFor({ state: "detached", timeout: 3_000 });
    assert.equal((await editor(page).innerText()).trim(), "");
  });
}

/** Two tabs of the reader, both offline, each send one: both messages go, once each. */
async function checkTwoTabsOffline(context: BrowserContext, device: string) {
  const first = await newPage(context);
  const second = await newPage(context);
  await load(first, `${CHANNEL_ORIGIN()}${CHANNEL_PATH}`);
  await load(second, `${CHANNEL_ORIGIN()}${CHANNEL_PATH}`);
  // The first tab gets its connection back after a while; the second stays away.
  await first.evaluate(() => window.harnessConnection?.drop(6_000));
  await second.evaluate(() => window.harnessConnection?.drop(120_000));
  await first.waitForTimeout(100);
  for (const [page, text] of [
    [first, "desde la primera pestaña"],
    [second, "desde la segunda pestaña"],
  ] as const) {
    await page.bringToFront();
    await editor(page).click();
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    await outbox(page).first().waitFor({ timeout: 3_000 });
  }
  await step(device, "two tabs offline: the first tab's message goes once its connection is back", async () => {
    await first.bringToFront();
    await first.waitForFunction(
      (body) => (window.harnessConnection?.sent.filter((item) => item.text === body).length ?? 0) > 0,
      "desde la primera pestaña",
      { timeout: 20_000 },
    );
    await first.waitForTimeout(500);
    assert.equal(await sentCount(first, "desde la primera pestaña"), 1);
  });
  await step(device, "two tabs offline: the second tab's message still waits, stored", async () => {
    const stored = await second.evaluate(() =>
      Object.keys(window.localStorage)
        .filter((key) => key.startsWith("openbot.workspace.outbox.v1:"))
        .map((key) => window.localStorage.getItem(key) ?? "")
        .join("\n"),
    );
    assert.match(stored, /desde la segunda pestaña/u);
    assert.doesNotMatch(stored, /desde la primera pestaña/u);
  });
  await first.close();
  await second.close();
}

/** An edit in place on a computer hides a pasted password, as the message box does. */
async function checkEditInPlaceHidesSecret(page: Page, device: string) {
  await load(page, `${CHANNEL_ORIGIN()}${CHANNEL_PATH}`);
  await editor(page).click();
  await page.keyboard.type("nota para editar");
  await page.keyboard.press("Enter");
  const sent = page.locator(".ws-message").filter({ hasText: "nota para editar" });
  await sent.first().waitFor({ timeout: 10_000 });
  await page.keyboard.press("ArrowUp");
  const inPlace = page.locator(".ws-message-edit .composer-editor-surface").first();
  await inPlace.waitFor({ timeout: 5_000 });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("la clave: Pan-de-oro77");
  await page.keyboard.press("Enter");
  await step(device, "an edit in place hides a password before it reaches the host", async () => {
    const edited = page.locator(".ws-message").filter({ hasText: "la clave:" }).first();
    await edited.waitFor({ timeout: 10_000 });
    const text = await edited.innerText();
    assert.doesNotMatch(text, /Pan-de-oro77/u, "The password went to the host.");
    assert.match(text, /\[hidden: password\]/u);
  });
}

/**
 * Return in an agent DM while the connection is away. A DM that cannot send yet keeps the draft as
 * written, with no notice that a message hid a password. A DM that holds the send until the
 * connection is back sends it with a marker in place of the password, and says so.
 */
async function checkDmUnsentKeepsDraft(page: Page, device: string) {
  await load(page, `${CHANNEL_ORIGIN()}${DM_PATH}`);
  await page.evaluate(() => window.harnessConnection?.drop(60_000));
  await page.waitForTimeout(300);
  await editor(page).click();
  await page.keyboard.type("la clave: Pan-de-oro77");
  await page.keyboard.press("Enter");
  await settle(page);
  await step(
    device,
    "an agent DM offline: a password is never sent, and the notice matches what happened",
    async () => {
      const draft = (await editor(page).innerText()).trim();
      const notice = await page.getByText(/hid a password/u).count();
      if (draft === "la clave: Pan-de-oro77") {
        assert.equal(notice, 0, "A notice says a message hid the password, but nothing was sent.");
        return;
      }
      assert.equal(draft, "", `The draft holds ${JSON.stringify(draft)}.`);
      assert.ok(notice > 0, "The password was taken out without a notice.");
      const shown = await page.evaluate(() => document.body.innerText);
      assert.doesNotMatch(shown, /Pan-de-oro77/u, "The password shows in the waiting message.");
    },
  );
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
const CHANNEL_ORIGIN = () => origin;
let browser: Browser | null = null;

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  {
    const context = await newDevice(browser, true);
    await checkOutboxEditKeepsFiles(await newPage(context), "iphone", true);
    await context.close();
  }
  {
    const context = await newDevice(browser, false);
    await checkOutboxEditKeepsFiles(await newPage(context), "desktop", false);
    await context.close();
  }
  {
    const context = await newDevice(browser, true);
    await checkSendWaitsForUpload(await newPage(context), "iphone", true);
    await context.close();
  }
  {
    const context = await newDevice(browser, true);
    await checkManyWaitingFit(await newPage(context), "iphone");
    await context.close();
  }
  {
    const context = await newDevice(browser, true);
    await checkDeleteEndsEdit(await newPage(context), "iphone");
    await context.close();
  }
  {
    const context = await newDevice(browser, false);
    await checkTwoTabsOffline(context, "desktop");
    await context.close();
  }
  {
    const context = await newDevice(browser, false);
    await checkEditInPlaceHidesSecret(await newPage(context), "desktop");
    await context.close();
  }
  {
    const context = await newDevice(browser, false);
    await checkDmUnsentKeepsDraft(await newPage(context), "desktop");
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
    `${item.passed ? "ok  " : "FAIL"} ${item.device}: ${item.name}${item.detail ? `\n     ${item.detail}` : ""}`,
  );
for (const error of report.pageErrors) logger.error(`page error: ${error.slice(0, 400)}`);
logger.info(`${report.passed ? "Passed" : "Failed"}. Report: ${resolve(OUT, "report.json")}`);
process.exit(report.passed ? 0 : 1);
