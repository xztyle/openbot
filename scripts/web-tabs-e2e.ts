// Checks that the web client can have one host open in several tabs at once, as Slack can. Each tab
// asks the account service for a remote session with its own tab ID (`clientInstanceId`), so each
// tab gets its own session and its own peer on the host (`scripts/signal-tab-sessions-e2e.ts` checks
// that Signal keeps both connections and relays each tab's traffic). This run serves the web client
// harness (`src/renderer/stories/web-client-harness.tsx`) at `/app`, opens two tabs of one browser
// on it, and checks in Chromium:
// - both tabs show the workspace at the same time, with no "open in another tab" block;
// - the real directory client in each tab asks for a session with a different tab ID, and gets a
//   different session;
// - a reload keeps the tab's ID, so it reuses its session;
// - a tab that copies another tab's storage, as "Duplicate tab" does, takes a new ID while that tab
//   is open, and a closed tab's ID is free again.
// The account service is emulated with request routes: one active session per host and tab ID.
//
// `bun scripts/web-tabs-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/web-tabs-e2e/report.json and a screenshot of both tabs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("web-tabs-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-tabs-e2e");
const UI_WAIT_MS = 60_000;
const HOST_ID = "host-tabs-e2e";
const TAB_KEY = "openbot.web.tab-instance";
const PROBE_MODULE = "/src/renderer/src/preview/web-tabs-e2e-probe.ts";

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
    <script type="module" src="/src/renderer/stories/web-client-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-web-tabs-harness",
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
  name: string;
  passed: boolean;
  detail?: string;
}
const report: { steps: Step[]; pageErrors: string[]; sessionRequests: unknown[]; passed: boolean } = {
  steps: [],
  pageErrors: [],
  sessionRequests: [],
  passed: false,
};

async function step(name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ name, passed: true });
    logger.info(`PASS ${name}`);
  } catch (error) {
    report.steps.push({ name, passed: false, detail: String(error).slice(0, 800) });
    logger.error(`FAIL ${name}: ${String(error).slice(0, 800)}`);
    throw error;
  }
}

/** The account service: one active session for each host and tab ID, as `startSession` keeps them. */
async function emulateAccountService(context: BrowserContext): Promise<void> {
  const sessions = new Map<string, string>();
  await context.route(/\/v2\/remote\/sessions\//u, async (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON();
    report.sessionRequests.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/v2/remote/sessions/")) {
      assert.ok(isDynamicRecord(body) && isString(body.hostId), "The session request names no host.");
      const tab = isString(body.clientInstanceId) ? body.clientInstanceId : "device";
      const key = `${body.hostId}\0${tab}`;
      const sessionId = sessions.get(key) ?? randomUUID();
      sessions.set(key, sessionId);
      return route.fulfill({
        status: 201,
        json: { sessionId, hostId: body.hostId, expiresAt: Date.now() + 3_600_000 },
      });
    }
    return route.fulfill({
      json: { ticket: "ticket-e2e", expiresAt: Date.now() + 180_000, signalUrl: "wss://signal.example.test/v1/signal" },
    });
  });
}

async function openTab(context: BrowserContext, origin: string): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await page.goto(`${origin}/app/general`, { waitUntil: "commit" });
  await page
    .getByRole("button", { name: /general/u })
    .first()
    .waitFor({ timeout: UI_WAIT_MS });
  return page;
}

/** Starts a session in the page with the real directory client and the tab's real ID. */
function startSession(page: Page): Promise<{ sessionId: string; tabId: string }> {
  return page.evaluate(
    async ([modulePath, hostId]) => {
      const probe: { startSession(hostId: string): Promise<{ sessionId: string; tabId: string }> } = await import(
        modulePath
      );
      return probe.startSession(hostId);
    },
    [PROBE_MODULE, HOST_ID] as const,
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
    entries: ["src/renderer/stories/web-client-harness.tsx", "src/renderer/src/preview/web-tabs-e2e-probe.ts"],
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await emulateAccountService(context);

  let first: Page | null = null;
  let second: Page | null = null;
  await step("two tabs show the workspace at the same time", async () => {
    first = await openTab(context, origin);
    second = await openTab(context, origin);
    for (const page of [first, second]) {
      await page.bringToFront();
      assert.equal(await page.getByText(/open in another tab/iu).count(), 0, "A tab shows the other-tab block.");
      assert.equal(
        await page
          .getByRole("button", { name: /general/u })
          .first()
          .isVisible(),
        true,
      );
    }
    await first.screenshot({ path: resolve(OUT, "01-first-tab.png") });
    await second.screenshot({ path: resolve(OUT, "02-second-tab.png") });
  });
  assert.ok(first && second);
  const firstTab: Page = first;
  const secondTab: Page = second;

  let firstSession = { sessionId: "", tabId: "" };
  await step("each tab asks for a session with its own tab ID and gets its own session", async () => {
    firstSession = await startSession(firstTab);
    const secondSession = await startSession(secondTab);
    assert.notEqual(firstSession.tabId, secondSession.tabId, "Both tabs have one ID.");
    assert.notEqual(firstSession.sessionId, secondSession.sessionId, "Both tabs got one session.");
    const ids = report.sessionRequests.flatMap((request) =>
      isDynamicRecord(request) && isDynamicRecord(request.body) && isString(request.body.clientInstanceId)
        ? [request.body.clientInstanceId]
        : [],
    );
    assert.deepEqual(ids, [firstSession.tabId, secondSession.tabId], "The requests did not carry the tab IDs.");
  });

  await step("a reload keeps the tab's ID and session", async () => {
    await firstTab.reload({ waitUntil: "commit" });
    await firstTab
      .getByRole("button", { name: /general/u })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    const again = await startSession(firstTab);
    assert.deepEqual(again, firstSession);
  });

  await step("a duplicated tab takes a new ID while its original is open", async () => {
    const copy = await context.newPage();
    await copy.addInitScript(
      ([key, value]) => {
        if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
      },
      [TAB_KEY, firstSession.tabId] as const,
    );
    await copy.goto(`${origin}/app/general`, { waitUntil: "commit" });
    const copied = await startSession(copy);
    assert.notEqual(copied.tabId, firstSession.tabId, "The copy took the open tab's ID.");
    assert.notEqual(copied.sessionId, firstSession.sessionId, "The copy took the open tab's session.");
    await copy.close();
  });

  await step("a closed tab's ID is free again", async () => {
    await firstTab.close();
    const reopened = await context.newPage();
    await reopened.addInitScript(
      ([key, value]) => {
        if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
      },
      [TAB_KEY, firstSession.tabId] as const,
    );
    await reopened.goto(`${origin}/app/general`, { waitUntil: "commit" });
    assert.deepEqual(await startSession(reopened), firstSession);
  });

  assert.deepEqual(report.pageErrors, [], "The page threw.");
  report.passed = true;
} catch (error) {
  if (!report.steps.some((item) => !item.passed))
    report.steps.push({ name: "the run", passed: false, detail: String(error).slice(0, 800) });
} finally {
  await browser?.close();
  await server.close();
}

writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
logger.info(`Wrote .openbot-build/web-tabs-e2e/report.json: ${report.passed ? "passed" : "failed"}.`);
process.exit(report.passed ? 0 : 1);
