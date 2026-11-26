// Checks the owner's chat with an agent in the web client, on a computer and on a phone: the agent's
// own activity stays out of the owner's way, and the owner's conversation does not.
// (a) A Motion event wake and a teammate's message wake add nothing unread (host count, tab title)
//     and show no browser notification.
// (b) The owner's message and its answer count as unread and notify.
// (c) A message that the agent wrote to the owner on purpose (`message_owner`) counts and notifies.
// (d) In the chat, the two wakes are one collapsed "Agent activity" row ("2 updates · Motion,
//     Chief"), which opens to their messages; the owner's exchange and the message to the owner show
//     as messages; the rest of the turn with the message to the owner is one activity row before it.
//     The message to the owner shows the image that the agent passed on with it (`message_owner`
//     with `paths`), on a computer and on a phone.
// (e) A money ticket's strip at the top of the DM stays, with Approve and Decline, when the owner
//     asks the agent something (its Reply, or the chat's box); it says "You asked something" while the
//     host says so; Approve takes it away.
// Unread counts come from the client's own recount over the same rule as the host
// (`@openbot/contracts/owner-conversation`); `scripts/owner-dm-only-e2e.ts` checks the host.
// It serves the web client on the mock host of `src/renderer/stories/web-client-owner-dm-harness.tsx`.
//
// `bun scripts/owner-dm-only-web-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/owner-dm-only-web-e2e/report.json and a screenshot of each viewport.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

declare global {
  interface Window {
    harnessOwnerDm?: {
      next(): string | null;
      ticket(state: "waiting" | "asked" | "gone"): void;
      calls: { kind: "message" | "answer"; text: string }[];
    };
    /** The browser notifications that the page showed, by title and body. */
    shownNotifications?: { title: string; body: string }[];
  }
}

const logger = createOpenBotLogger("owner-dm-only-web-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/owner-dm-only-web-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");
const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;

const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-owner-dm-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-owner-dm-harness",
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
  viewport: ViewportName;
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

/** Opens a page with a recording Notification, as a browser that the owner allowed to notify. */
async function open(browser: Browser, viewport: ViewportName, path: string): Promise<Page> {
  const context = await browser.newContext(VIEWPORTS[viewport]);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(`${viewport}: ${error.message}`));
  await page.addInitScript(() => {
    window.shownNotifications = [];
    class RecordedNotification extends EventTarget {
      static permission = "granted";
      static requestPermission = async () => "granted";
      constructor(title: string, options?: { body?: string }) {
        super();
        window.shownNotifications?.push({ title, body: options?.body ?? "" });
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: RecordedNotification });
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${origin}${path}`, { waitUntil: "commit" });
    const ready = await page
      .waitForFunction(() => window.harnessHost && window.harnessOwnerDm, null, { timeout: UI_WAIT_MS / 2 })
      .then(
        () => true,
        () => false,
      );
    if (ready) break;
  }
  return page;
}

/** The host's unread count of the chat with Research. */
const unread = (page: Page) =>
  page.evaluate(async () => (await window.harnessHost?.api.agent.listConversationReads())?.research?.unreadCount ?? -1);
const notifications = (page: Page) => page.evaluate(() => window.shownNotifications?.length ?? 0);

async function settle(page: Page, read: () => Promise<number>, expected: number, what: string) {
  const deadline = Date.now() + 10_000;
  let last = await read();
  while (Date.now() < deadline && last !== expected) {
    await page.waitForTimeout(200);
    last = await read();
  }
  assert.equal(last, expected, what);
}

/** Adds the harness's next turn as the host does, and waits for the client to take it. */
async function nextTurn(page: Page): Promise<void> {
  await page.evaluate(() => window.harnessOwnerDm?.next());
  await page.waitForTimeout(1_500);
}

async function badges(browser: Browser, viewport: ViewportName): Promise<void> {
  // The owner is in another chat, and away from the window, as a notification needs.
  const page = await open(browser, viewport, "/app/general/dm/chief");
  await page.evaluate(() => {
    document.hasFocus = () => false;
    window.dispatchEvent(new Event("blur"));
  });
  await step(page, viewport, "a Motion wake and a teammate's wake add nothing unread and do not notify", async () => {
    await nextTurn(page);
    await nextTurn(page);
    await settle(page, () => unread(page), 0, "the agent's own activity counts as unread");
    assert.equal(await notifications(page), 0, "the agent's own activity notified");
    assert.ok(!(await page.title()).startsWith("("), `the tab title counts: ${await page.title()}`);
  });
  await step(page, viewport, "the owner's message and its answer count and notify", async () => {
    await nextTurn(page);
    await settle(page, () => unread(page), 1, "the answer to the owner is not unread");
    await settle(page, () => notifications(page), 1, "the answer to the owner did not notify");
  });
  await step(page, viewport, "a message to the owner on purpose counts and notifies", async () => {
    await nextTurn(page);
    await settle(page, () => unread(page), 2, "the message to the owner is not unread, or the turn's answer is");
    await settle(page, () => notifications(page), 2, "the message to the owner did not notify");
  });
  await page.context().close();
}

async function display(browser: Browser, viewport: ViewportName): Promise<void> {
  const page = await open(browser, viewport, "/app/general/dm/research?seed=full");
  const activity = page.getByRole("group", { name: english("chat.agentActivity.title") });
  await step(page, viewport, "the two wakes are one collapsed Agent activity row", async () => {
    await page.getByText("Va bien, mañana te paso los números.").first().waitFor({ timeout: UI_WAIT_MS });
    const first = activity.first();
    await first.waitFor({ timeout: UI_WAIT_MS });
    const text = (await first.innerText()).replace(/\s+/gu, " ");
    assert.ok(text.includes("2 updates · Motion, Chief"), `the row says: ${text}`);
    assert.equal(await page.getByText("MAS-28 vuelve a revisión").count(), 0, "a wake's answer shows as a message");
    assert.equal(await page.getByText("No pude dejar la nota en MAS-30.").count(), 0, "a wake's answer shows");
  });
  await step(page, viewport, "the owner's exchange and the message to the owner show as messages", async () => {
    await page.getByText("¿Cómo va la campaña?").first().waitFor({ timeout: UI_WAIT_MS });
    await page.getByText("Necesito tu OK para lanzar Peluquería.").first().waitFor({ timeout: UI_WAIT_MS });
    // The image that the agent passed on with its message to the owner shows with it.
    const image = page.locator('img[src^="blob:"]').first();
    await image.waitFor({ timeout: UI_WAIT_MS });
    assert.ok(
      await image.evaluate(
        (element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
      ),
      "the image of the message to the owner did not load",
    );
    assert.equal(await activity.count(), 2, "the turn with the message to the owner is not one activity row");
    assert.equal(await page.getByText("Listo.", { exact: true }).count(), 0, "that turn's answer shows");
    await page.screenshot({ path: resolve(OUT, `${viewport}-chat.png`) });
    report.screenshots.push(resolve(OUT, `${viewport}-chat.png`));
  });
  await step(page, viewport, "the activity row opens to the wakes' messages", async () => {
    await activity.first().getByRole("button").first().click();
    await page.getByText("MAS-28 vuelve a revisión").first().waitFor({ timeout: UI_WAIT_MS });
    await page.getByText("No pude dejar la nota en MAS-30.").first().waitFor({ timeout: UI_WAIT_MS });
    await page.screenshot({ path: resolve(OUT, `${viewport}-chat-open.png`) });
    report.screenshots.push(resolve(OUT, `${viewport}-chat-open.png`));
  });
  await page.context().close();
}

/**
 * The money ticket's strip at the top of the DM stays pinned with its buttons when the owner asks the
 * agent something (its Reply, or the chat's box): a question decides nothing. It says "You asked
 * something" while the host says so, and goes back to waiting for the decision when the agent answers.
 * Only Approve takes it away.
 */
async function strip(browser: Browser, viewport: ViewportName): Promise<void> {
  const page = await open(browser, viewport, "/app/general/dm/research");
  const banner = page.getByRole("status").filter({ hasText: "¿Apruebas gastar 70 dólares" });
  const approve = banner.getByRole("button", { name: english("workspace.needsYou.ticket.approve"), exact: true });
  const askedText = banner.getByText(english("workspace.needsYou.ticket.asked"));
  const calls = () => page.evaluate(() => window.harnessOwnerDm?.calls ?? []);
  await step(page, viewport, "a money ticket shows its strip with Approve and Decline", async () => {
    await page.getByText("Hola, aquí estoy.").first().waitFor({ timeout: UI_WAIT_MS });
    await page.evaluate(() => window.harnessOwnerDm?.ticket("waiting"));
    await approve.waitFor({ timeout: UI_WAIT_MS });
    await banner
      .getByRole("button", { name: english("workspace.needsYou.ticket.decline"), exact: true })
      .waitFor({ timeout: UI_WAIT_MS });
  });
  await step(page, viewport, "a question with Reply keeps the strip and its buttons, and says you asked", async () => {
    await banner.getByRole("button", { name: english("workspace.needsYou.ticket.reply"), exact: true }).click();
    await banner.getByRole("textbox").fill("¿Por qué solo México?");
    await banner.getByRole("button", { name: english("workspace.needsYou.ticket.send"), exact: true }).click();
    await askedText.waitFor({ timeout: UI_WAIT_MS });
    await approve.waitFor({ timeout: UI_WAIT_MS });
    const made = await calls();
    assert.ok(
      made.some((call) => call.kind === "message" && call.text.includes("¿Por qué solo México?")),
      `the question did not reach the agent: ${JSON.stringify(made)}`,
    );
    assert.ok(!made.some((call) => call.kind === "answer"), "the question answered the ticket");
    await page.screenshot({ path: resolve(OUT, `${viewport}-strip-asked.png`) });
    report.screenshots.push(resolve(OUT, `${viewport}-strip-asked.png`));
  });
  await step(page, viewport, "writing in the chat keeps the strip", async () => {
    const box = page.getByRole("textbox", { name: english("composer.placeholder.message", { name: "Research" }) });
    await box.fill("Otra pregunta sobre la campaña");
    await box.press("Enter");
    await page.waitForTimeout(1_000);
    await approve.waitFor({ timeout: UI_WAIT_MS });
    assert.ok(!(await calls()).some((call) => call.kind === "answer"), "a chat message answered the ticket");
  });
  await step(page, viewport, "the host's asked state shows, and the agent's answer clears it", async () => {
    await page.evaluate(() => window.harnessOwnerDm?.ticket("asked"));
    await askedText.waitFor({ timeout: UI_WAIT_MS });
    await page.evaluate(() => window.harnessOwnerDm?.ticket("waiting"));
    await askedText.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await approve.waitFor({ timeout: UI_WAIT_MS });
  });
  await step(page, viewport, "Approve answers the ticket and takes the strip away", async () => {
    await approve.click();
    await banner.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.ok(
      (await calls()).some((call) => call.kind === "answer"),
      "Approve did not answer the ticket",
    );
  });
  await page.context().close();
}

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
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
    entries: ["src/renderer/stories/web-client-owner-dm-harness.tsx"],
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
  for (const viewport of ["desktop", "phone"] as const) {
    await badges(browser, viewport);
    await display(browser, viewport);
    await strip(browser, viewport);
  }
  report.passed =
    report.steps.length > 0 && report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps. Report: ${resolve(OUT, "report.json")}`,
);
process.exit(report.passed ? 0 : 1);
