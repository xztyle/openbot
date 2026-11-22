// Checks Today, the owner's one decision queue: on an iPhone the Today tab counts every request of
// every space in amber and lists them blocking first, then by money; Approve and an inline answer on
// a card send the answer and the count goes down. A money approval shows the amount of its effect
// line; an insight alert of the host shows as soon as the host connects; the queue keeps its count
// while the connection comes back; Dismiss takes an alert off every count. On a computer the sidebar's Today row and the top
// bar's "Needs you" count the same queue, and Ctrl+K approves a decision by name. It serves the web
// client on a mock host (`src/renderer/stories/web-client-today-harness.tsx`) at every address under
// `/app`, and drives it in Chromium. No account service, host or provider is needed.
//
// `bun scripts/today-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/today-e2e/report.json and a screenshot for each screen.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("today-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/today-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");
const COMMIT = { waitUntil: "commit" } as const;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

// `viewport-fit=cover` as the site's /app page, so the bars keep clear of the safe areas themselves.
const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-today-harness.tsx"></script>
  </body>
</html>`;

/** Serves the harness page at `/app` and every address under it, as the site's `/app/$` route does. */
function webClientPages(): Plugin {
  return {
    name: "openbot-today-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        const guardrails = /^\/guardrails(?:[/?]|$)/u.test(url);
        if (!guardrails && !/^\/app(?:[/?]|$)/u.test(url)) return next();
        const page = guardrails ? HARNESS.replace("web-client-today-harness", "today-guardrails-harness") : HARNESS;
        const html = await server.transformIndexHtml(url, page);
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

const path = (page: Page) => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
};

const waiting = (page: Page, count: number) =>
  page.getByRole("heading", { name: english("workspace.today.waiting", { count }) }).first();
const tabBar = (page: Page) => page.getByRole("navigation", { name: english("workspace.phone.tabs") });

async function step(page: Page, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ name, url: path(page), passed: true });
  } catch (error) {
    const shown = await page
      .evaluate(() => (document.querySelector(".web-app")?.textContent ?? "").replace(/\s+/gu, " ").slice(0, 400))
      .catch((reason: unknown) => String(reason));
    report.steps.push({
      name,
      url: path(page),
      passed: false,
      detail: `${String(error).slice(0, 500)}\nPage: ${shown}`,
    });
    const shot = resolve(OUT, `${report.steps.length}-failed.png`);
    await page.screenshot({ path: shot }).catch(() => undefined);
    report.screenshots.push(shot);
    throw error;
  }
}

async function shot(page: Page, label: string): Promise<void> {
  const file = resolve(OUT, `${label}.png`);
  await page.screenshot({ path: file });
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
    entries: ["src/renderer/stories/web-client-today-harness.tsx", "src/renderer/stories/today-guardrails-harness.tsx"],
    include: ["@norbert_bodziony/bloub"],
  },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${address.port}`;
let browser: Browser | null = null;

function track(page: Page): void {
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    // The harness has no favicon or fonts route; the dev server's own socket is no part of the client.
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource") &&
      !message.text().startsWith("[vite]")
    )
      report.consoleErrors.push(message.text().slice(0, 1_000));
  });
}

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  const phone = await browser.newContext({ ...iphone, hasTouch: true, isMobile: true });
  const page = await phone.newPage();
  track(page);

  // 1. The Today tab counts every space: two loop decisions of Trading and two requests of General.
  await step(page, "Today counts the requests of every space in amber", async () => {
    await page.goto(`${origin}/app/general`, COMMIT);
    await waiting(page, 4).waitFor({ timeout: UI_WAIT_MS });
    await tabBar(page)
      .getByRole("button", {
        name: `${english("workspace.view.today")}, ${english("workspace.phone.waiting", { count: 4 })}`,
      })
      .waitFor({ timeout: UI_WAIT_MS });
  });
  await shot(page, "01-phone-today");

  // 2. Blocking first, then money, then age: the $40 budget leads.
  await step(page, "the queue puts the money that blocks work first", async () => {
    const first = page.getByRole("article").first();
    assert.match((await first.getAttribute("aria-label")) ?? "", /Research needs you: Approve \$40/u);
    assert.match((await first.textContent()) ?? "", /Trading/u);
  });

  // 3. Approve on the card answers the decision; the count goes down everywhere.
  await step(page, "Approve on a card answers it and the count goes down", async () => {
    await page
      .getByRole("article")
      .first()
      .getByRole("button", { name: english("workspace.today.approve"), exact: true })
      .tap();
    await waiting(page, 3).waitFor({ timeout: UI_WAIT_MS });
    await tabBar(page)
      .getByRole("button", {
        name: `${english("workspace.view.today")}, ${english("workspace.phone.waiting", { count: 3 })}`,
      })
      .waitFor({ timeout: UI_WAIT_MS });
  });

  // 4. A loop question is answered in place.
  await step(page, "a loop question is answered on its card", async () => {
    const card = page.getByRole("article", { name: /Answer a question/u }).first();
    await card.getByRole("textbox").fill("Open with the price drop");
    await card.getByRole("button", { name: english("workspace.today.send"), exact: true }).tap();
    await waiting(page, 2).waitFor({ timeout: UI_WAIT_MS });
  });
  await shot(page, "02-phone-answered");
  await phone.close();

  // 4b. The host's insight alert, a money approval's effect line, and a connection that drops.
  const alertPhone = await browser.newContext({ ...iphone, hasTouch: true, isMobile: true });
  const alertPage = await alertPhone.newPage();
  track(alertPage);
  const todayTab = (count: number) =>
    tabBar(alertPage).getByRole("button", {
      name: `${english("workspace.view.today")}, ${english("workspace.phone.waiting", { count })}`,
    });
  await step(alertPage, "an insight alert shows as soon as the host connects", async () => {
    await alertPage.goto(`${origin}/app/general?alert`, COMMIT);
    // The alert poll runs every ten minutes: the first read waits for the connection, not for it.
    await waiting(alertPage, 5).waitFor({ timeout: UI_WAIT_MS });
    await todayTab(5).waitFor({ timeout: UI_WAIT_MS });
    await alertPage.getByText("Spent $60 on ads with no sale in 3 days").first().waitFor({ timeout: UI_WAIT_MS });
  });
  await step(alertPage, "a money approval shows the amount of its effect line, after the bigger one", async () => {
    const cards = alertPage.getByRole("article");
    await cards.nth(1).getByText("Hotmart · pay 19 USD", { exact: false }).waitFor({ timeout: UI_WAIT_MS });
    assert.match((await cards.nth(1).getAttribute("aria-label")) ?? "", /^Chief/u);
    assert.match((await cards.nth(1).textContent()) ?? "", /\$19\.00/u);
  });
  await shot(alertPage, "02b-phone-alert-and-payment");
  await step(alertPage, "the queue keeps its count while the connection comes back", async () => {
    await alertPage.evaluate(() => window.dispatchEvent(new CustomEvent("today-connection", { detail: "connecting" })));
    await alertPage.waitForFunction(() =>
      document.querySelector(".web-app")?.textContent?.includes("Waiting on you (5)"),
    );
    assert.equal(await waiting(alertPage, 5).count(), 1);
    assert.equal(await todayTab(5).count(), 1);
    await alertPage.evaluate(() => window.dispatchEvent(new CustomEvent("today-connection", { detail: "online" })));
    await waiting(alertPage, 5).waitFor({ timeout: UI_WAIT_MS });
  });
  await step(alertPage, "Dismiss takes an alert off Today and the tab", async () => {
    await alertPage
      .getByRole("article", { name: /Spent \$60/u })
      .getByRole("button", { name: english("workspace.today.dismiss"), exact: true })
      .tap();
    await waiting(alertPage, 4).waitFor({ timeout: UI_WAIT_MS });
    await todayTab(4).waitFor({ timeout: UI_WAIT_MS });
  });
  await alertPhone.close();

  // 5. A computer: the sidebar's Today row and the top bar count the same queue.
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const deskPage = await desk.newPage();
  track(deskPage);
  await step(deskPage, "the sidebar's Today row and the top bar agree", async () => {
    await deskPage.goto(`${origin}/app/general`, COMMIT);
    await waiting(deskPage, 4).waitFor({ timeout: UI_WAIT_MS });
    await deskPage
      .getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 4 }) })
      .waitFor({ timeout: UI_WAIT_MS });
    const row = deskPage.getByRole("button", { name: new RegExp(`^${english("workspace.view.today")}`, "u") }).first();
    assert.match((await row.textContent()) ?? "", /4/u);
  });
  await shot(deskPage, "03-desk-today");

  // 6. Ctrl+K: "approve" lists what waits; Enter approves the one named.
  await step(deskPage, "Ctrl+K approves a decision by name", async () => {
    await deskPage.keyboard.press("Control+k");
    await deskPage.keyboard.type("approve spring");
    await deskPage
      .getByRole("option", { name: /Approve: Run the spring ad test/u })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    await shot(deskPage, "04-desk-command-bar");
    await deskPage.keyboard.press("Enter");
    await waiting(deskPage, 3).waitFor({ timeout: UI_WAIT_MS });
    await deskPage
      .getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 3 }) })
      .waitFor({ timeout: UI_WAIT_MS });
  });
  await desk.close();

  // 7. The guardrails and the learning queue: a pause resumes from Today and from Money; a proposal
  // applies; Money shows when the subscription runs out, today's spenders and the failover.
  const guard = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const guardPage = await guard.newPage();
  track(guardPage);
  /** What the harness recorded, in order: the raw JSON list of the calls. */
  const pressed = (): Promise<string> => guardPage.evaluate(() => document.body.dataset.todayCalls ?? "[]");
  await step(guardPage, "Money shows the meter, today's spenders and the failover", async () => {
    await guardPage.goto(`${origin}/guardrails`, COMMIT);
    await guardPage.getByText(english("trust.guardrails.meter")).first().waitFor({ timeout: UI_WAIT_MS });
    await guardPage
      .getByText(/runs out about/u)
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    await guardPage.getByText(english("workspace.money.topToday")).waitFor({ timeout: UI_WAIT_MS });
    await guardPage.getByText(/claude\/claude-sonnet-5-5 → codex\/gpt-6-luna/u).waitFor({ timeout: UI_WAIT_MS });
    // A pause and a failover whose times do not parse still show, without the time.
    await guardPage.getByText("$601 of $600 today").first().waitFor({ timeout: UI_WAIT_MS });
    await guardPage.getByText(/claude\/claude-opus-5-5 → codex\/gpt-6/u).waitFor({ timeout: UI_WAIT_MS });
  });
  await shot(guardPage, "05-guardrails");
  await step(guardPage, "a learning proposal applies from its card", async () => {
    await guardPage
      .getByRole("article", { name: /Review a playbook change/u })
      .getByRole("button", { name: english("workspace.today.apply"), exact: true })
      .click();
    await guardPage.waitForFunction(() => (document.body.dataset.todayCalls ?? "").includes("learning:approve"));
  });
  await step(guardPage, "Resume on Money ends the pause everywhere", async () => {
    await guardPage
      .getByRole("region", { name: english("workspace.view.money") })
      .getByRole("listitem")
      .filter({ hasText: "200 of 200 turns today" })
      .getByRole("button", { name: english("trust.guardrails.resume") })
      .click();
    await guardPage.waitForFunction(() => (document.body.dataset.todayCalls ?? "").includes("resume:agent:ana-1"));
    assert.equal(await guardPage.getByRole("article", { name: /Paused by a guardrail/u }).count(), 0);
    assert.equal(await pressed(), JSON.stringify(["learning:approve", "resume:agent:ana-1"]));
  });
  await guard.close();

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
