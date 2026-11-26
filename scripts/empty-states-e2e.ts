// Checks the first run and the empty states of the web client: on an iPhone a host that does not
// answer on the first load shows the error with Retry, and More, instead of an empty Today with a
// first-run guide; a host with no agent has a New agent step in the guide, which opens the form; a new space
// offers a channel of its own rather than #general of General, and stays in that space; a template
// import shows its validation score when the host has it, without leaving the tab, and clears the
// name of the new space. It serves the web
// client on mock hosts (`src/renderer/stories/web-client-empty-harness.tsx` and `views-harness.tsx`,
// picked by a cookie) at every address under `/app`, and drives it in Chromium.
//
// `bun scripts/empty-states-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/empty-states-e2e/report.json and a screenshot for each screen.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("empty-states-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/empty-states-e2e");
const UI_WAIT_MS = 60_000;
// The dev server compiles a harness on its first request. Beside the whole deploy suite that takes
// more than a minute, so the first wait on each page allows longer.
const FIRST_LOAD_MS = 180_000;
const english = translateFor("en");
const COMMIT = { waitUntil: "commit" } as const;
const HARNESSES = ["web-client-empty-harness", "views-harness"] as const;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const page = (harness: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/${harness}.tsx"></script>
  </body>
</html>`;

/** Serves the harness that the `harness` cookie names at `/app` and every address under it. */
function webClientPages(): Plugin {
  return {
    name: "openbot-empty-states-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        if (!/^\/app(?:[/?]|$)/u.test(url)) return next();
        const named = /(?:^|;\s*)harness=([\w-]+)/u.exec(request.headers.cookie ?? "")?.[1];
        const harness = HARNESSES.find((entry) => entry === named) ?? HARNESSES[0];
        const html = await server.transformIndexHtml(url, page(harness));
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      });
    },
  };
}

interface Step {
  name: string;
  url: string;
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

const path = (current: Page) => {
  const url = new URL(current.url());
  return `${url.pathname}${url.search}`;
};

async function step(current: Page, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ name, url: path(current), passed: true });
  } catch (error) {
    const shown = await current
      .evaluate(() => (document.querySelector(".web-app")?.textContent ?? "").replace(/\s+/gu, " ").slice(0, 400))
      .catch((reason: unknown) => String(reason));
    report.steps.push({
      name,
      url: path(current),
      passed: false,
      detail: `${String(error).slice(0, 500)}\nPage: ${shown}`,
    });
    const file = resolve(OUT, `${report.steps.length}-failed.png`);
    await current.screenshot({ path: file }).catch(() => undefined);
    report.screenshots.push(file);
    throw error;
  }
}

async function shot(current: Page, label: string): Promise<void> {
  const file = resolve(OUT, `${label}.png`);
  await current.screenshot({ path: file });
  report.screenshots.push(file);
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
    entries: HARNESSES.map((harness) => `src/renderer/stories/${harness}.tsx`),
    include: ["@norbert_bodziony/bloub"],
  },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${address.port}`;
let browser: Browser | null = null;

function track(current: Page): void {
  current.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  current.on("console", (message) => {
    // The harness has no favicon or fonts route; the dev server's own socket is no part of the client.
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource") &&
      !message.text().startsWith("[vite]")
    )
      report.consoleErrors.push(message.text().slice(0, 1_000));
  });
}

async function open(context: BrowserContext, harness: (typeof HARNESSES)[number]): Promise<Page> {
  await context.addCookies([{ name: "harness", value: harness, url: origin }]);
  const opened = await context.newPage();
  track(opened);
  return opened;
}

const guide = (current: Page) =>
  current
    .getByRole("heading", { name: english("workspace.today.guide.title") })
    .or(current.getByText(english("workspace.today.guide.title"), { exact: true }));

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  const phoneOptions = { ...iphone, hasTouch: true, isMobile: true };

  // 1. A host that does not answer the first time: the error and Retry, not an empty Today.
  const down = await browser.newContext(phoneOptions);
  const downPage = await open(down, "web-client-empty-harness");
  await step(downPage, "a phone shows why the host did not load, with Retry", async () => {
    await downPage.goto(`${origin}/app?connect=fail`, COMMIT);
    // The client asks again by itself, so the notice moves between the error and Connecting.
    await downPage
      .getByText(english("server.connection.connecting", { name: "Preview computer" }))
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: FIRST_LOAD_MS });
    await downPage
      .getByRole("button", { name: english("server.connection.retry") })
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    // The steps would read as undone: no agent and no channel came from the host.
    assert.equal(await guide(downPage).count(), 0, "The first-run guide shows.");
    // The notice is a bar: More, with the other servers and the account, stays in reach.
    await downPage
      .getByRole("button", { name: english("workspace.phone.more") })
      .filter({ visible: true })
      .first()
      .tap({ timeout: UI_WAIT_MS });
    await downPage
      .getByText(english("workspace.phone.views"))
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
  });
  await shot(downPage, "01-phone-host-down");
  await down.close();

  // 2. A host with no agent: the guide starts with New agent, which opens the form.
  const empty = await browser.newContext(phoneOptions);
  const emptyPage = await open(empty, "web-client-empty-harness");
  await step(emptyPage, "the guide of a host with no agent starts with New agent", async () => {
    await emptyPage.goto(`${origin}/app?agents=none`, COMMIT);
    await guide(emptyPage).filter({ visible: true }).first().waitFor({ timeout: FIRST_LOAD_MS });
    await emptyPage.getByText(english("workspace.fleet.noAgentsHint")).filter({ visible: true }).first().tap();
    await emptyPage
      .getByRole("button", { name: english("agent.setup.create") })
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
  });
  await shot(emptyPage, "02-phone-no-agent");
  await empty.close();

  // 3. A new space: its channel step makes a channel of that space and does not leave it.
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const deskPage = await open(desk, "web-client-empty-harness");
  await step(deskPage, "the guide of a new space makes a channel there", async () => {
    await deskPage.goto(`${origin}/app/fresh/today?space=new`, COMMIT);
    await guide(deskPage).filter({ visible: true }).first().waitFor({ timeout: FIRST_LOAD_MS });
    assert.equal(await deskPage.getByText(english("workspace.today.guide.channel"), { exact: true }).count(), 0);
    await deskPage
      .getByRole("button", { name: new RegExp(`^${english("workspace.app.welcome.createChannel")}`, "u") })
      .first()
      .click();
    await deskPage.getByRole("dialog").getByText(english("workspace.create.title")).first().waitFor({
      timeout: UI_WAIT_MS,
    });
    assert.match(path(deskPage), /^\/app\/fresh\//u);
  });
  await shot(deskPage, "03-desk-new-space");
  await desk.close();

  // 4. A template import shows its validation when the host has scored it, on the open tab.
  const views = await browser.newContext(phoneOptions);
  const viewsPage = await open(views, "views-harness");
  await step(viewsPage, "an import clears the name and shows its validation score on the tab", async () => {
    await viewsPage.goto(`${origin}/app/general/portfolio`, COMMIT);
    await viewsPage
      .getByRole("button", { name: english("portfolio.tab.templates"), exact: true })
      .tap({ timeout: FIRST_LOAD_MS });
    const name = viewsPage.getByPlaceholder(english("portfolio.templates.namePlaceholder"));
    await name.fill("Bakery");
    await viewsPage
      .getByRole("button", { name: english("portfolio.templates.create") })
      .first()
      .tap();
    await viewsPage.getByText(english("portfolio.templates.validating")).waitFor({ timeout: UI_WAIT_MS });
    // The name was of that space: the next template does not take it too.
    assert.equal(await name.inputValue(), "");
    await viewsPage.getByText(english("portfolio.templates.score", { score: 72 }), { exact: false }).waitFor({
      timeout: 40_000,
    });
  });
  await shot(viewsPage, "04-phone-template-validated");
  await views.close();

  report.passed =
    report.steps.every((item) => item.passed) && report.pageErrors.length === 0 && report.consoleErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps. Report: ${resolve(OUT, "report.json")}`,
);
process.exit(report.passed ? 0 : 1);
