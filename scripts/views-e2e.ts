// Checks the secondary views of the web client on an iPhone, on a mock host that serves them to its
// owner (`src/renderer/stories/views-harness.tsx`): typing in a test-suite scenario and in a trust
// budget keeps the field and its focus, a failed template import keeps the pasted text, big values
// read grouped and an empty value report shows no empty heading, a space-wide lesson shows only in
// its own space, and a money entry in a zone whose day is not the UTC day is dated and listed on the
// reader's own day, not the UTC one. No account service, host or provider is needed.
//
// `bun scripts/views-e2e.ts [--browser-executable=<path>] [--headed]`
// Each step runs on its own page, so one failure does not hide the others.
// Writes .openbot-build/views-e2e/report.json and a screenshot of each failed step.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("views-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/views-e2e");
const UI_WAIT_MS = 60_000;
/**
 * A zone whose day is not the UTC day now: UTC-11 before noon UTC (its evening is the UTC morning
 * of the next day), UTC+14 after it (already tomorrow there).
 */
const OTHER_DAY_ZONE = new Date().getUTCHours() < 12 ? "Pacific/Pago_Pago" : "Pacific/Kiritimati";

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
    <script type="module" src="/src/renderer/stories/views-harness.tsx"></script>
  </body>
</html>`;

/** Serves the harness page at `/app` and every address under it, as the site's `/app/$` route does. */
function webClientPages(): Plugin {
  return {
    name: "openbot-views-harness",
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

const report: { steps: Step[]; pageErrors: string[]; passed: boolean } = { steps: [], pageErrors: [], passed: false };

async function step(page: Page, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ name, passed: true });
  } catch (error) {
    report.steps.push({ name, passed: false, detail: String(error).slice(0, 800) });
    await page.screenshot({ path: resolve(OUT, `${report.steps.length}-failed.png`) }).catch(() => undefined);
    logger.error("Step failed.", { step: name, error: String(error).slice(0, 300) });
  }
}

/** The text of the view that shows. A phone keeps Today mounted under it, hidden. */
const shown = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".ws-view")]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => element.innerText)
      .join("\n"),
  );

const calls = (page: Page) => page.evaluate(() => document.body.dataset.viewsCalls ?? "");

const TITLES: Record<string, string> = {
  portfolio: "Portfolio",
  reviews: "Reviews",
  trust: "Trust & audit",
  insights: "Insights",
};

async function open(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await page.goto(`${origin}/app/general/${path}`, { waitUntil: "commit" });
  const title = TITLES[path.split("?")[0] ?? ""] ?? "";
  await page.getByRole("heading", { name: title, exact: true }).first().waitFor({ timeout: UI_WAIT_MS });
  return page;
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
  optimizeDeps: { entries: ["src/renderer/stories/views-harness.tsx"], include: ["@norbert_bodziony/bloub"] },
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
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  const phone = await browser.newContext({ ...iphone, hasTouch: true, isMobile: true, timezoneId: OTHER_DAY_ZONE });

  // 1. Each keystroke replaces the scenario; the field must stay, with focus, and keep every letter.
  let page = await open(phone, "portfolio");
  await step(page, "typing in a test-suite scenario keeps the field and its focus", async () => {
    await page.getByRole("tab", { name: "Quality", exact: true }).tap();
    await page.getByRole("button", { name: "Test suite" }).first().tap();
    const name = page.getByLabel("Name", { exact: true }).first();
    await name.waitFor({ timeout: UI_WAIT_MS });
    await name.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" again", { delay: 30 });
    assert.equal(await name.inputValue(), "Late cake again");
    assert.equal(await name.evaluate((element) => element === document.activeElement), true);
  });

  // 2. The host refuses the pasted template: the text stays for another try.
  await step(page, "a failed template import keeps the pasted text", async () => {
    await page.getByRole("tab", { name: "Templates", exact: true }).tap();
    const area = page.getByPlaceholder("Paste the text of an .atelier-template.json file");
    const text = JSON.stringify({
      format: "atelier-space-template",
      version: 1,
      name: "Bakery",
      agents: [{ key: "a", name: "A", instructions: "Bake.", skills: [], routines: [] }],
    });
    await area.fill(text);
    await page.getByRole("button", { name: "Import", exact: true }).tap();
    await page.getByText("Could not create the space").first().waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await area.inputValue(), text);
  });
  await page.close();

  // 3. Big values read grouped in the reader's format; an empty report shows no empty Spaces heading.
  page = await open(phone, "portfolio?data=extreme");
  await step(page, "big portfolio values are grouped", async () => {
    await page.getByText("29.2× per $").waitFor({ timeout: UI_WAIT_MS });
    assert.match(await shown(page), /value 1,334,568 · cost 45,679 · revenue 1,234,568/u);
  });
  await page.close();
  page = await open(phone, "portfolio?data=empty");
  await step(page, "an empty value report has no empty Spaces heading", async () => {
    await page.getByText("No agent of this space has a cost or a value yet.").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await page.getByRole("heading", { name: "Spaces", exact: true }).count(), 0);
  });
  await page.close();

  // 4. A lesson for the whole Piks space waits in Piks only; Apply moves the other one to the done list.
  page = await open(phone, "reviews");
  await step(page, "a space-wide lesson shows only in its own space", async () => {
    await page.getByRole("tab", { name: "Learning", exact: true }).tap();
    await page.getByText("1 change waits for you").waitFor({ timeout: UI_WAIT_MS });
    assert.doesNotMatch(await shown(page), /A lesson for the whole Piks space/u);
    await page.getByRole("button", { name: "Apply", exact: true }).tap();
    await page.getByText("Applied lately").waitFor({ timeout: UI_WAIT_MS });
    assert.match(await calls(page), /decide:lesson:accept/u);
  });
  await page.close();
  page = await open(phone, "reviews?data=extreme");
  await step(page, "big review counts are grouped", async () => {
    await page.getByText(/turns on Automatic/u).waitFor({ timeout: UI_WAIT_MS });
    assert.match(await shown(page), /100,000 of 123,456 turns on Automatic/u);
    assert.match(await shown(page), /12,345 turns/u);
  });
  await page.close();

  // 5. Each keystroke replaces the budget; "0.5" types in whole and saves as a number.
  page = await open(phone, "trust");
  await step(page, "typing a budget keeps the field, its focus and the decimal point", async () => {
    const perDay = page.getByLabel("Per day", { exact: true });
    await perDay.waitFor({ timeout: UI_WAIT_MS });
    await perDay.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("0.5", { delay: 30 });
    assert.equal(await perDay.inputValue(), "0.5");
    assert.equal(await perDay.evaluate((element) => element === document.activeElement), true);
    const platform = page.getByLabel("Platform", { exact: true });
    await platform.fill("");
    assert.equal(await platform.inputValue(), "");
    await platform.pressSequentially("google", { delay: 30 });
    await page.getByRole("button", { name: "Save", exact: true }).tap();
    await page.waitForFunction(() => (document.body.dataset.viewsCalls ?? "").includes("trustSave"), null, {
      timeout: UI_WAIT_MS,
    });
    const saved = (await calls(page)).split("\n").find((line) => line.startsWith("trustSave:")) ?? "";
    assert.match(saved, /"platform":"google"/u);
    assert.match(saved, /"perDay":0\.5/u);
  });
  await page.close();

  // 6. The reader's day, not the UTC one, which is another day in OTHER_DAY_ZONE.
  page = await open(phone, "insights");
  await step(page, "a money entry is dated and listed on the reader's own day", async () => {
    const day = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
    await page.getByText("Money", { exact: true }).last().tap();
    await page.getByRole("button", { name: "Add entry" }).first().tap();
    const date = page.locator('input[type="date"]');
    await date.waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await date.inputValue(), day);
    await page.locator('input[type="number"]').fill("12");
    await page.getByRole("button", { name: "Save", exact: true }).last().tap();
    // Listed: an entry dated on the UTC day would fall outside the report's days.
    await page.getByRole("list", { name: "Entries added by hand" }).waitFor({ timeout: UI_WAIT_MS });
    assert.match(await calls(page), new RegExp(`"kind":"money-add".*"date":"${day}"`, "u"));
  });
  await page.close();

  assert.deepEqual(report.pageErrors, []);
  assert.ok(
    report.steps.every((entry) => entry.passed),
    "A step failed.",
  );
  report.passed = true;
  logger.info("Views e2e passed.", { steps: report.steps.length });
} catch (error) {
  logger.error("Views e2e failed.", { error: String(error) });
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
