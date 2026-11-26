// Checks the one Settings page of the web client on a computer and on a phone: the single entry
// point (the account's and the server's sections in one list), the sections a member does not get
// and an owner does, the old `page=server-settings` addresses, a toggle that saves, and the cloud
// backup plan with one row per setting. It serves `src/renderer/stories/web-settings-harness.tsx`
// on a mock host whose admin routes answer; no account service, host or provider is needed.
//
// `bun scripts/web-settings-e2e.ts [--browser-executable=<path>] [--headed] [--shots=<label>]`
// `--shots=<label>` also saves a screenshot of every settings page at 1440 and 390, light and dark,
// under .openbot-build/ui-settings/<label>/. Writes .openbot-build/web-settings-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

declare global {
  interface Window {
    /** The admin routes the harness answered, in order (`src/renderer/stories/web-settings-harness.tsx`). */
    settingsHarnessCalls?: string[];
  }
}

const logger = createOpenBotLogger("web-settings-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-settings-e2e");
const UI_WAIT_MS = 60_000;
const ENTRY = "/src/renderer/stories/web-settings-harness.tsx";
const t = translateFor("es");
const COMMIT = { waitUntil: "commit" } as const;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const HARNESS = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Atelier web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${ENTRY}"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-web-settings-harness",
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

const report: { steps: Step[]; pageErrors: string[]; screenshots: string[]; passed: boolean } = {
  steps: [],
  pageErrors: [],
  screenshots: [],
  passed: false,
};

async function step(page: Page, name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    report.steps.push({ name, passed: true });
    logger.info(`ok: ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report.steps.push({ name, passed: false, detail });
    logger.error(`failed: ${name}: ${detail}`);
    const file = resolve(OUT, `failed-${report.steps.length}.png`);
    await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
    report.screenshots.push(file);
  }
}

async function waitForAddress(page: Page, expected: string): Promise<void> {
  await page.waitForFunction((value) => `${location.pathname}${location.search}` === value, expected, {
    timeout: UI_WAIT_MS,
  });
}

/** The heading of the Settings page, which every settings address shows. */
const settingsHeading = (page: Page) => page.getByRole("heading", { name: t("app.settingsPage.title"), level: 1 });

async function openSettings(page: Page, origin: string, search: string): Promise<void> {
  await show(page, `${origin}/app/general${search}`, (target) => settingsHeading(target).waitFor({ timeout: 20_000 }));
}

/**
 * Loads an address and waits until the page shows. A page of the dev server can stay blank with its
 * modules pending after many loads in one tab; a fresh load of the same address then shows.
 */
async function show(page: Page, url: string, ready: (page: Page) => Promise<void>): Promise<void> {
  // A page left while its modules load aborts them, and the next page can then stay blank.
  if (page.url() !== "about:blank")
    await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
  for (let attempt = 1; ; attempt += 1) {
    await page.goto(url, COMMIT);
    try {
      await ready(page);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await page.goto("about:blank");
    }
  }
}

async function screenshot(page: Page, dir: string, name: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false, animations: "disabled" });
  report.screenshots.push(file);
}

/** Every settings page, by the `section` of its address, with how to reach it before the one page. */
const PAGES: readonly { name: string; search: string; scrollTo?: string }[] = [
  { name: "list", search: "?page=settings" },
  { name: "profile", search: "?page=settings&section=profile" },
  { name: "appearance", search: "?page=settings&section=appearance" },
  { name: "notifications", search: "?page=settings&section=notifications" },
  { name: "server-general", search: "?page=settings&section=general" },
  { name: "server-members", search: "?page=settings&section=members" },
  { name: "server-workspace", search: "?page=settings&section=workspace" },
  { name: "server-updates", search: "?page=settings&section=updates" },
  { name: "server-backups", search: "?page=settings&section=backups" },
  { name: "server-backups-plan", search: "?page=settings&section=backups", scrollTo: t("backups.cloud.plan") },
];

/** The same pages, at the addresses of before the one Settings page. */
const LEGACY_PAGES = PAGES.map((page) => ({
  ...page,
  search: page.name.startsWith("server-") ? page.search.replace("page=settings", "page=server-settings") : page.search,
}));

async function sweep(context: BrowserContext, origin: string, dir: string, legacy: boolean): Promise<void> {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  for (const theme of ["dark", "light"] as const) {
    for (const entry of legacy ? LEGACY_PAGES : PAGES) {
      await show(page, `${origin}/app/general${entry.search}&theme=${theme}`, (target) =>
        target.locator(".settings-page").first().waitFor({ timeout: 20_000 }),
      );
      // The section's data has arrived when its body stops changing height.
      await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
      await page.waitForTimeout(600);
      if (entry.scrollTo) {
        const target = page.getByText(entry.scrollTo, { exact: true }).first();
        await target.waitFor({ timeout: UI_WAIT_MS });
        await target.evaluate((element) => element.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(200);
      }
      await screenshot(page, dir, `${entry.name}-${theme}`);
    }
  }
  await page.close();
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
  optimizeDeps: { entries: [`src/renderer/stories${ENTRY.slice("/src/renderer/stories".length)}`] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const listening = server.httpServer?.address();
assert.ok(listening && typeof listening === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${listening.port}`;
let browser: Browser | null = null;

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "es" });
  const phone = await browser.newContext({
    ...devices["iPhone 13"],
    viewport: { width: 390, height: 844 },
    locale: "es",
  });

  const shots = option("shots");
  if (shots) {
    const legacy = process.argv.includes("--legacy");
    const dir = resolve(ROOT, ".openbot-build/ui-settings", shots);
    await sweep(desktop, origin, resolve(dir, "1440"), legacy);
    await sweep(phone, origin, resolve(dir, "390"), legacy);
  }

  if (!process.argv.includes("--shots-only")) {
    const page = await desktop.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));

    // 1. One entry point: the Settings page lists the account's sections and the server's sections.
    await step(page, "one settings page lists personal and server sections", async () => {
      await openSettings(page, origin, "?page=settings");
      const list = page.getByRole("navigation", { name: t("settings.sections.label") });
      await list.getByRole("button", { name: t("settings.tab.profile.title"), exact: true }).waitFor({
        timeout: UI_WAIT_MS,
      });
      await list.getByRole("button", { name: t("backups.sectionTitle"), exact: true }).waitFor({ timeout: UI_WAIT_MS });
      await list.getByRole("button", { name: t("server.settings.membersTitle"), exact: true }).waitFor({
        timeout: UI_WAIT_MS,
      });
    });

    // 2. An old server settings address opens the same page, on the section it named.
    await step(page, "an old server-settings address redirects", async () => {
      await page.goto(`${origin}/app/general?page=server-settings&section=backups`, COMMIT);
      await settingsHeading(page).waitFor({ timeout: UI_WAIT_MS });
      await waitForAddress(page, "/app/general/today?page=settings&section=backups");
      await page.getByRole("heading", { name: t("backups.sectionTitle"), level: 2 }).waitFor({ timeout: UI_WAIT_MS });
    });

    // 3. The cloud backup plan: a section heading, then one row for each setting.
    await step(page, "the backup plan shows one row per setting", async () => {
      const plan = page.getByRole("region", { name: t("backups.cloud.plan"), exact: true });
      await plan.waitFor({ timeout: UI_WAIT_MS });
      await plan.getByRole("switch", { name: t("backups.cloud.plan.enabled") }).waitFor({ timeout: UI_WAIT_MS });
      const what = page.getByRole("region", { name: t("backups.cloud.plan.what"), exact: true });
      await what.getByRole("switch", { name: t("backups.cloud.group.database") }).waitFor({ timeout: UI_WAIT_MS });
      const rows = await what.getByRole("switch").count();
      assert.equal(rows, 6, `The "what is copied" group has ${rows} switches, not 6.`);
    });

    // 4. A toggle saves: the plan's save sends the changed plan to the host.
    await step(page, "a changed toggle saves to the host", async () => {
      const what = page.getByRole("region", { name: t("backups.cloud.plan.what"), exact: true });
      const motion = what.getByRole("switch", { name: t("backups.cloud.group.motion") });
      const before = await motion.getAttribute("aria-checked");
      await motion.click();
      await page
        .getByRole("region", { name: t("backups.cloud.plan.keep"), exact: true })
        .getByRole("button", { name: t("common.save"), exact: true })
        .click();
      await page.waitForFunction(
        () => window.settingsHarnessCalls?.some((path) => path.endsWith("/cloud-backups/plan")),
        undefined,
        { timeout: UI_WAIT_MS },
      );
      await page.getByText(t("backups.cloud.plan.saved")).first().waitFor({ timeout: UI_WAIT_MS });
      assert.notEqual(await motion.getAttribute("aria-checked"), before, "The switch did not change.");
    });

    // 5. A member sees their own sections, not the server's admin sections.
    await step(page, "a member does not see the server's admin sections", async () => {
      await page.goto(`${origin}/app/general?page=settings&role=member`, COMMIT);
      await settingsHeading(page).waitFor({ timeout: UI_WAIT_MS });
      const list = page.getByRole("navigation", { name: t("settings.sections.label") });
      await list.getByRole("button", { name: t("settings.tab.profile.title"), exact: true }).waitFor({
        timeout: UI_WAIT_MS,
      });
      await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
      assert.equal(await list.getByRole("button", { name: t("backups.sectionTitle"), exact: true }).count(), 0);
      assert.equal(
        await list.getByRole("button", { name: t("server.settings.workspaceTitle"), exact: true }).count(),
        0,
      );
    });
    await page.close();

    // 6. The phone: the list of sections, then a section with Back to the list.
    const phonePage = await phone.newPage();
    phonePage.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
    await step(phonePage, "the phone lists every section and opens one", async () => {
      await openSettings(phonePage, origin, "?page=settings");
      const list = phonePage.getByRole("navigation", { name: t("settings.sections.label") });
      const backups = list.getByRole("button", { name: t("backups.sectionTitle"), exact: true });
      await backups.waitFor({ timeout: UI_WAIT_MS });
      const box = await backups.boundingBox();
      assert.ok(box && box.height >= 44, `A phone row is ${box?.height ?? 0} px tall, under 44.`);
      await backups.tap();
      await phonePage
        .getByRole("heading", { name: t("backups.sectionTitle"), level: 2 })
        .waitFor({ timeout: UI_WAIT_MS });
      await waitForAddress(phonePage, "/app/general/today?page=settings&section=backups");
      await phonePage
        .getByRole("region", { name: t("backups.cloud.plan"), exact: true })
        .waitFor({ timeout: UI_WAIT_MS });
      await phonePage
        .getByRole("button", { name: t("common.back") })
        .first()
        .tap();
      await backups.waitFor({ timeout: UI_WAIT_MS });
    });
    await phonePage.close();
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
