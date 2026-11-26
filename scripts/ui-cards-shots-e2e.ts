// The cards that ask the owner for something, on a computer and on a phone, in the dark and the light
// theme: the decision card of today and the one the host made before the lasting ids, the money
// approval, the password card, the Motion ticket pinned above a chat, Today's "Waits for you" and
// the top bar's "Needs you" list. The web client runs on a mock host (`decision-card-harness.tsx`,
// `web-client-needsyou-harness.tsx`); the same shared components draw on the desktop.
//
// It checks what the owner must not see: no emoji, arrow or # rows and no ticket key or raw address
// outside the technical details, which stay closed; the ticket card says what the ticket asks; the
// list names a decision as a decision. Then it writes a screenshot of each screen.
//
// `bun scripts/ui-cards-shots-e2e.ts [--browser-executable=<path>] [--out=<dir>]`
// Writes <out>/report.json (default .openbot-build/ui-cards) and the screenshots beside it.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin, type ViteDevServer } from "vite";

const ROOT = resolve(import.meta.dirname, "..");
const english = translateFor("en");
const spanish = translateFor("es");
const UI_WAIT_MS = 90_000;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}
const OUT = resolve(ROOT, option("out") ?? ".openbot-build/ui-cards");

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}
const checks: Check[] = [];
const screenshots: string[] = [];
function check(name: string, passed: boolean, detail?: unknown): void {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail: String(detail).slice(0, 400) }) });
  process.stdout.write(`${passed ? "ok  " : "FAIL"} ${name}\n`);
}

function harnessHtml(entry: string, lang: string): string {
  return `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Atelier web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/${entry}"></script>
  </body>
</html>`;
}

/** Serves one harness at `/app` and every address under it, as the site does. */
async function serve(entry: string, lang: string): Promise<{ server: ViteDevServer; origin: string }> {
  const pages: Plugin = {
    name: `openbot-ui-cards-${entry}`,
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "/";
        if (!/^\/app(?:[/?]|$)/u.test(url)) return next();
        const html = await server.transformIndexHtml(url, harnessHtml(entry, lang));
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      });
    },
  };
  const server = await createServer({
    root: ROOT,
    configFile: false,
    appType: "custom",
    logLevel: "error",
    plugins: [pages, tailwindcss({ optimize: false }), solidPlugin()],
    resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
    optimizeDeps: { entries: [`src/renderer/stories/${entry}`], include: ["@norbert_bodziony/bloub"] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object", "The harness server has no port.");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

/** The first load: Vite may still optimise the dependencies, so a blank page loads once more. */
async function load(page: Page, url: string, ready: Locator): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(url, { waitUntil: "commit" });
    if (
      await ready.waitFor({ timeout: UI_WAIT_MS / 3 }).then(
        () => true,
        () => false,
      )
    )
      return;
  }
  await ready.waitFor({ timeout: UI_WAIT_MS });
}

async function shot(page: Page, label: string): Promise<void> {
  // The text draws once the fonts are in; a card arrives with a short rise.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
  const file = resolve(OUT, `${label}.png`);
  await page.screenshot({ path: file });
  screenshots.push(file);
}

/** The visible text of an element, without what a closed details holds. */
const visibleText = (scope: Locator) => scope.innerText().then((text) => text.replace(/\s+/gu, " "));

async function newContext(browser: Browser, viewport: ViewportName, theme: Theme): Promise<BrowserContext> {
  const context = await browser.newContext({ ...VIEWPORTS[viewport], colorScheme: theme });
  // Nothing leaves the machine: a link that opens is recorded, not followed.
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/u, (route) => route.abort());
  return context;
}

const tap = (locator: Locator, viewport: ViewportName) => (viewport === "phone" ? locator.tap() : locator.click());

/** The decision cards in Chief's chat: the one of today and the legacy one, open and answered. */
async function decisionCards(browser: Browser, origin: string, viewport: ViewportName, theme: Theme): Promise<void> {
  const context = await newContext(browser, viewport, theme);
  const page = await context.newPage();
  const cards = page.locator("article.ui-block-decision");
  await load(page, `${origin}/app/general/dm/chief?appearance=${theme}`, cards.first());
  const legacy = cards.first();
  const current = cards.last();
  await legacy.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await legacy.locator("button.ui-decision-option").first().waitFor({ state: "visible" });
  const legacyText = await visibleText(legacy);
  check(
    `${viewport} ${theme}: legacy decision card has no emoji, arrow, # or raw key outside the details`,
    !/[💰⏱→]/u.test(legacyText) &&
      !/(^|\s)#(\s|:)/u.test(legacyText) &&
      !legacyText.includes("EVE-40") &&
      !legacyText.includes("adsmanager"),
    legacyText,
  );
  check(
    `${viewport} ${theme}: legacy decision card shows the amount and a labelled link`,
    legacyText.includes("125 USD") && legacyText.includes(spanish("uiBlock.decision.openCampaign", { place: "Meta" })),
    legacyText,
  );
  await shot(page, `decision-legacy-${viewport}-${theme}`);
  await current.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await shot(page, `decision-${viewport}-${theme}-top`);
  const options = current.locator("button.ui-decision-option");
  await options.first().waitFor({ state: "visible" });
  const recommended = await options.first().innerText();
  check(
    `${viewport} ${theme}: the recommended option is marked`,
    recommended.includes(spanish("uiBlock.decision.recommended")),
    recommended,
  );
  await current.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await shot(page, `decision-${viewport}-${theme}-bottom`);
  await tap(options.first(), viewport);
  await current.locator(".ui-block-outcome[data-status='answered']").waitFor({ state: "visible" });
  await current.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await shot(page, `decision-answered-${viewport}-${theme}`);
  await context.close();
}

/** Sales Outbound's chat: the money approval, the Motion ticket card and the code card; the list and Today. */
async function needsYou(browser: Browser, origin: string, viewport: ViewportName, theme: Theme): Promise<void> {
  const context = await newContext(browser, viewport, theme);
  const page = await context.newPage();
  const ready = () =>
    page.waitForFunction(() => document.documentElement.dataset.needsYouReady !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
  const emit = (detail: string) =>
    page.evaluate((value) => window.dispatchEvent(new CustomEvent("needs-you-harness", { detail: value })), detail);
  const todayTab = page.getByRole("navigation", { name: english("workspace.phone.tabs") }).getByRole("button", {
    name: new RegExp(`^${english("workspace.view.today")}`, "u"),
  });

  if (viewport === "desktop") {
    await load(
      page,
      `${origin}/app/general/dm/sales?appearance=${theme}`,
      page.locator("[data-ws-conversation]").first(),
    );
    await ready();
    await emit("everything");
    const approval = page.getByRole("region", { name: english("prompt.approval.label") }).first();
    await approval.waitFor({ timeout: UI_WAIT_MS });
    const technical = approval.locator("details.approval-technical");
    check(
      `${viewport} ${theme}: the approval's technical details start closed`,
      (await technical.getAttribute("open")) === null,
    );
    const strip = page.locator(".ws-agent-dm-wait").first();
    await strip.waitFor({ timeout: UI_WAIT_MS });
    const stripText = await visibleText(strip);
    check(
      `${viewport} ${theme}: the ticket card says what the ticket asks, without its key`,
      stripText.includes(english("workspace.needsYou.banner.waitsInMotion")) &&
        stripText.includes("Christmas decorations") &&
        !stripText.includes("MAN-5"),
      stripText,
    );
    await shot(page, `approval-and-ticket-${viewport}-${theme}`);
    await page.getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 4 }) }).click();
    const popover = page.locator(".ws-needs-you-popover");
    await popover.waitFor({ timeout: UI_WAIT_MS });
    const popoverText = await visibleText(popover);
    check(
      `${viewport} ${theme}: the list names the decision as a decision`,
      popoverText.includes(english("workspace.needsYou.action.decision")) &&
        !popoverText.includes(english("workspace.needsYou.action.form")),
      popoverText,
    );
    await shot(page, `needs-you-list-${viewport}-${theme}`);
    await page.keyboard.press("Escape");
    await page
      .getByRole("link", { name: new RegExp(`^${english("workspace.view.today")}`, "u") })
      .first()
      .click()
      .catch(() => page.getByText(english("workspace.view.today"), { exact: true }).first().click());
    await page.locator(".ws-today-decision").first().waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `today-${viewport}-${theme}`);
  } else {
    await load(page, `${origin}/app/general?appearance=${theme}`, todayTab);
    await ready();
    await emit("everything");
    await page.locator(".ws-today-decision").first().waitFor({ timeout: UI_WAIT_MS });
    const today = await visibleText(page.locator(".ws-today-decisions").first());
    check(
      `${viewport} ${theme}: Today names the decision as a decision`,
      today.includes(english("workspace.needsYou.action.decision")) &&
        !today.includes(english("workspace.needsYou.action.form")),
      today,
    );
    await shot(page, `today-${viewport}-${theme}`);
    await page.goto(`${origin}/app/general/dm/sales?appearance=${theme}`, { waitUntil: "commit" });
    await ready();
    await emit("everything");
    const strip = page.locator(".ws-agent-dm-wait").first();
    await strip.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `ticket-and-cards-${viewport}-${theme}`);
    const secret = page.locator(".browser-secret-card").first();
    if (await secret.count()) {
      await secret.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await shot(page, `secret-card-${viewport}-${theme}`);
    }
  }
  await context.close();
}

mkdirSync(OUT, { recursive: true });
const executablePath = option("browser-executable");
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
let failure: string | null = null;
try {
  const decisions = await serve("decision-card-harness.tsx", "es");
  try {
    for (const viewport of ["desktop", "phone"] as const)
      for (const theme of THEMES) await decisionCards(browser, decisions.origin, viewport, theme);
  } finally {
    await decisions.server.close();
  }
  const needs = await serve("web-client-needsyou-harness.tsx", "en");
  try {
    for (const viewport of ["desktop", "phone"] as const)
      for (const theme of THEMES) await needsYou(browser, needs.origin, viewport, theme);
  } finally {
    await needs.server.close();
  }
} catch (error) {
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stdout.write(`${failure}\n`);
} finally {
  await browser.close();
}
const passed = failure === null && checks.every((entry) => entry.passed);
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ passed, failure, checks, screenshots }, null, 2)}\n`);
process.stdout.write(`${passed ? "passed" : "failed"}: ${screenshots.length} screenshots in ${OUT}\n`);
process.exit(passed ? 0 : 1);
