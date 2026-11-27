// Checks the keys and passwords screen of the web client on a computer and on a phone: the overview
// and the list, the search, a change of who may use a key, going back to an earlier version, the
// history line a reveal writes, a rotation date that makes a key need the owner, and an agent's
// request filled from the screen. It serves `src/renderer/stories/web-settings-harness.tsx` (the web
// client on a mock host); the host's own rules are checked by `scripts/secret-vault-e2e.ts`.
//
// `bun scripts/web-secrets-e2e.ts [--browser-executable=<path>] [--headed]`
// Saves screenshots at 1440 and 390, light and dark, under .openbot-build/web-secrets-e2e/ and writes
// .openbot-build/web-secrets-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("web-secrets-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-secrets-e2e");
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
    name: "openbot-web-secrets-harness",
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

const report: {
  steps: { name: string; passed: boolean; detail?: string }[];
  pageErrors: string[];
  screenshots: string[];
  passed: boolean;
} = { steps: [], pageErrors: [], screenshots: [], passed: false };

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

async function shot(page: Page, name: string): Promise<void> {
  const file = resolve(OUT, `${name}.png`);
  await page.waitForTimeout(250);
  await page.screenshot({ path: file, fullPage: false, animations: "disabled" });
  report.screenshots.push(file);
}

const screen = (page: Page) => page.getByRole("region", { name: t("secrets.title"), exact: true });
const row = (page: Page, name: string) => screen(page).getByRole("button", { name: t("secrets.row.open", { name }) });
const detail = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

/** Loads the screen; a dev-server page that stays blank loads again. */
async function open(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    await page.goto(url, COMMIT);
    try {
      await row(page, "Anuncios de Meta").waitFor({ timeout: 25_000 });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await page.goto("about:blank");
    }
  }
}

async function press(locator: ReturnType<Page["locator"]>, touch: boolean) {
  if (touch) await locator.tap();
  else await locator.click();
}

/** The flows on one device. */
async function flows(context: BrowserContext, origin: string, label: "1440" | "390", touch: boolean) {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(`${label}: ${error.stack ?? error.message}`));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => undefined);

  await step(page, `${label}: the overview and the list show the keys, grouped by who uses them`, async () => {
    await open(page, `${origin}/app/general/secrets`);
    await screen(page)
      .getByRole("heading", { name: t("secrets.title") })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    for (const name of ["Anuncios de Meta", "Hotmart", "Correo de ventas", "Canva, código de acceso"])
      await row(page, name).waitFor({ timeout: UI_WAIT_MS });
    await screen(page).getByText(t("secrets.stat.attention")).waitFor({ timeout: UI_WAIT_MS });
    await screen(page).getByText(t("secrets.requests.title")).waitFor({ timeout: UI_WAIT_MS });
    if (touch) {
      const box = await row(page, "Hotmart").boundingBox();
      assert.ok(box && box.height >= 44, `A phone row is ${box?.height ?? 0} px tall, under 44.`);
    }
    await shot(page, `${label}-list-dark`);
  });

  await step(page, `${label}: the search finds a key by its name and hides the others`, async () => {
    const search = screen(page).getByRole("searchbox", { name: t("secrets.search") });
    await search.fill("hotmart");
    await row(page, "Hotmart").waitFor({ timeout: UI_WAIT_MS });
    await page.waitForFunction(() => document.querySelectorAll(".sv-row").length === 1, undefined, {
      timeout: UI_WAIT_MS,
    });
    assert.equal(await row(page, "Anuncios de Meta").count(), 0, "The search kept a key that does not match.");
    await search.fill("");
    await row(page, "Anuncios de Meta").waitFor({ timeout: UI_WAIT_MS });
  });

  await step(page, `${label}: folders and tags narrow the list, and a key moves to a folder`, async () => {
    const folders = screen(page).getByRole("navigation", { name: t("secrets.folder.browse") });
    await press(folders.getByRole("button", { name: /universidad-online/u }), touch);
    await screen(page)
      .getByText(t("secrets.folder.accessTitle", { folder: "universidad-online" }))
      .waitFor({ timeout: UI_WAIT_MS });
    await row(page, "Campus Moodle").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await row(page, "Correo de ventas").count(), 0, "A key outside the folder shows.");
    await press(folders.getByRole("button", { name: t("secrets.folder.all") }), touch);
    await press(screen(page).getByRole("button", { name: /#anuncios/u }), touch);
    await page.waitForFunction(() => document.querySelectorAll(".sv-row").length === 1, undefined, {
      timeout: UI_WAIT_MS,
    });
    await press(screen(page).getByRole("button", { name: /#anuncios/u }), touch);
    await press(row(page, "Correo de ventas"), touch);
    const panel = detail(page, "Correo de ventas");
    await press(panel.getByRole("button", { name: t("secrets.folder.move"), exact: true }), touch);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").first().fill("universidad-online/ventas");
    await press(dialog.getByRole("button", { name: t("secrets.folder.move"), exact: true }), touch);
    await panel.getByText("universidad-online › ventas").waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${label}-folders-dark`);
    if (touch) await press(page.locator(".sv-detail").getByRole("button", { name: t("secrets.detail.back") }), touch);
    else await press(page.locator(".sv-detail").getByRole("button", { name: t("secrets.detail.close") }), touch);
    await row(page, "Anuncios de Meta").waitFor({ timeout: UI_WAIT_MS });
  });

  await step(page, `${label}: the owner limits a shared key to one agent`, async () => {
    await press(row(page, "Anuncios de Meta"), touch);
    const panel = detail(page, "Anuncios de Meta");
    await panel.getByRole("heading", { name: "Anuncios de Meta" }).waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${label}-detail-dark`);
    const everyone = panel.getByRole("switch", { name: t("secrets.access.everyone") });
    assert.equal(await everyone.getAttribute("aria-checked"), "true");
    await press(panel.locator(".ui-switch-control").first(), touch);
    await page.waitForFunction(
      () => document.querySelector('.sv-detail [role="switch"]')?.getAttribute("aria-checked") === "false",
      undefined,
      { timeout: UI_WAIT_MS },
    );
    await press(panel.getByRole("button", { name: t("secrets.access.addAgent") }), touch);
    const option = page.getByRole("option").nth(1);
    const agentName = (await option.innerText()).trim();
    await press(option, touch);
    await panel
      .getByRole("button", { name: t("secrets.access.remove", { name: agentName }) })
      .waitFor({ timeout: UI_WAIT_MS });
    await panel
      .getByText(t("secrets.history.accessChanged", { who: "Alejandro" }))
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
  });

  await step(page, `${label}: going back to version 2 makes it the current value`, async () => {
    const panel = detail(page, "Anuncios de Meta");
    const before = await panel.locator(".sv-version-row").count();
    await press(panel.getByRole("button", { name: t("secrets.versions.restore") }).first(), touch);
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText(t("secrets.versions.restoreTitle", { version: 2 })).waitFor({ timeout: UI_WAIT_MS });
    await press(dialog.getByRole("button", { name: t("secrets.versions.restoreConfirm") }), touch);
    await page
      .getByText(t("secrets.versions.restored", { version: 2 }))
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    await page.waitForFunction(
      (count) => document.querySelectorAll(".sv-detail .sv-version-row").length === count + 1,
      before,
      { timeout: UI_WAIT_MS },
    );
    await panel
      .getByText(t("secrets.history.rolledBack", { who: "Alejandro" }))
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
  });

  await step(page, `${label}: a reveal asks first, hides itself, and writes a history line`, async () => {
    const panel = detail(page, "Anuncios de Meta");
    await press(panel.getByRole("button", { name: t("secrets.value.show"), exact: true }).first(), touch);
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText(t("secrets.reveal.title", { name: "Anuncios de Meta" })).waitFor({ timeout: UI_WAIT_MS });
    await press(dialog.getByRole("button", { name: t("secrets.reveal.confirm") }), touch);
    const value = panel.locator(".sv-revealed");
    await value.waitFor({ timeout: UI_WAIT_MS });
    assert.ok((await value.innerText()).startsWith("EAAG-preview-meta"), "The value did not show.");
    await panel
      .getByText(t("secrets.history.revealed", { who: "Alejandro" }))
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${label}-revealed-dark`);
    await value.waitFor({ state: "detached", timeout: 15_000 });
  });

  await step(page, `${label}: a rotation date that passed makes the key need the owner`, async () => {
    const panel = detail(page, "Anuncios de Meta");
    const date = panel.locator("#sv-rotate-by");
    const yesterday = new Date(Date.now() - 86_400_000);
    const value = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    await date.fill(value);
    await date.dispatchEvent("change");
    await panel.locator('.sv-status[data-health="rotate-due"]').first().waitFor({ timeout: UI_WAIT_MS });
    await panel
      .getByText(t("secrets.history.settingsChanged", { who: "Alejandro" }))
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
  });

  await step(page, `${label}: an agent's request is filled from the screen and becomes a key`, async () => {
    if (touch) await press(page.locator(".sv-detail").getByRole("button", { name: t("secrets.detail.back") }), touch);
    else await press(page.locator(".sv-detail").getByRole("button", { name: t("secrets.detail.close") }), touch);
    await screen(page).locator('.sv-row[data-health="rotate-due"]').first().waitFor({ timeout: UI_WAIT_MS });
    await press(screen(page).getByRole("button", { name: t("secrets.requests.fillAction") }), touch);
    await screen(page)
      .getByLabel(t("secrets.requests.fillLabel", { name: "STRIPE_SECRET_KEY" }))
      .fill("sk_live_preview_value");
    await press(screen(page).getByRole("button", { name: t("secrets.requests.save") }), touch);
    await row(page, "STRIPE_SECRET_KEY").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await screen(page).getByText(t("secrets.requests.title")).count(), 0, "The request stayed.");
  });

  await step(page, `${label}: chat apps, webhooks and mailboxes read as settings rows`, async () => {
    await open(page, `${origin}/app/general/secrets`);
    const mailbox = screen(page).getByText("ventas@aprendivo.com");
    await mailbox.waitFor({ timeout: UI_WAIT_MS });
    await screen(page).getByText("Ventas de Stripe").waitFor({ timeout: UI_WAIT_MS });
    await screen(page).getByText("Claude en mi celular").waitFor({ timeout: UI_WAIT_MS });
    // The Worker address stays behind the technical details.
    assert.equal(await screen(page).getByText("https://atelier-mail.delynith.workers.dev").isVisible(), false);
    await screen(page).getByText(t("workspace.connections.chatTitle")).scrollIntoViewIfNeeded();
    await shot(page, `${label}-connections-dark`);
    await mailbox.scrollIntoViewIfNeeded();
    await shot(page, `${label}-mailboxes-dark`);
  });
  await page.close();

  // The same screen in the light theme, for the record.
  const light = await context.newPage();
  light.on("pageerror", (error) => report.pageErrors.push(`${label} light: ${error.stack ?? error.message}`));
  await step(light, `${label}: the light theme draws the list and a key`, async () => {
    await open(light, `${origin}/app/general/secrets?theme=light`);
    await shot(light, `${label}-list-light`);
    await press(row(light, "Campus Moodle"), touch);
    await detail(light, "Campus Moodle")
      .getByRole("heading", { name: "Campus Moodle" })
      .waitFor({ timeout: UI_WAIT_MS });
    await shot(light, `${label}-detail-light`);
  });
  await light.close();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  cacheDir: "node_modules/.vite-e2e/web-secrets-e2e",
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
  await flows(desktop, origin, "1440", false);
  const phone = await browser.newContext({
    ...devices["iPhone 13"],
    viewport: { width: 390, height: 844 },
    locale: "es",
  });
  await flows(phone, origin, "390", true);
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
