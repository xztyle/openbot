// Checks the org chart's agent panel, the Fleet cards and the Motion ticket chips on the settings
// design system, in the web client on a computer (1440 px) and on an iPhone (390 px):
// - the org chart panel shows its groups under their titles (Now, Reports to, Direct reports,
//   Actions), with Open chat and Change manager as named buttons;
// - Change manager opens a picker dialog, and a pick saves at once with no save bar: the panel then
//   shows the new manager, and the toast offers Undo;
// - a Fleet card names its actions (Message, Settings), and on a phone each action and the Motion
//   ticket chip is at least 44 px tall.
// It serves `src/renderer/stories/web-settings-harness.tsx` (the web client on a mock host); no
// account service, host or provider is needed.
//
// `bun scripts/org-fleet-settings-e2e.ts [--browser-executable=<path>] [--headed] [--shots=<label>] [--shots-only]`
// `--shots=<label>` also saves the org chart with its panel, the manager picker, the Fleet and the
// Motion events settings, at 1440 and 390, light and dark, under .openbot-build/ui-audit/org-fleet/<label>/.
// Writes .openbot-build/org-fleet-settings-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, devices, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("org-fleet-settings-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/org-fleet-settings-e2e");
const UI_WAIT_MS = 60_000;
const ENTRY = "/src/renderer/stories/web-settings-harness.tsx";
const t = translateFor("es");
const COMMIT = { waitUntil: "commit" } as const;
/** The agent whose card the checks open: it works on a Motion ticket in the preview's fleet. */
const AGENT = "Chief";

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
    name: "openbot-org-fleet-settings-harness",
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

type Device = "desktop" | "phone";
type Theme = "dark" | "light";

interface Step {
  name: string;
  device: Device;
  passed: boolean;
  detail?: string;
}

const report: { steps: Step[]; pageErrors: string[]; screenshots: string[]; passed: boolean } = {
  steps: [],
  pageErrors: [],
  screenshots: [],
  passed: false,
};

async function step(page: Page, device: Device, name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    report.steps.push({ name, device, passed: true });
    logger.info(`ok: ${device}: ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report.steps.push({ name, device, passed: false, detail: detail.slice(0, 800) });
    logger.error(`failed: ${device}: ${name}: ${detail}`);
    const file = resolve(OUT, `failed-${report.steps.length}-${device}.png`);
    await page.screenshot({ path: file }).catch(() => undefined);
    report.screenshots.push(file);
  }
}

const tap = (device: Device, target: Locator) => (device === "phone" ? target.tap() : target.click());
const panel = (page: Page) =>
  page.getByRole("complementary").filter({ has: page.getByRole("heading", { name: AGENT }) });

/**
 * Opens an address of the web client. A page of the dev server can stay blank with its modules
 * pending; a fresh load of the same address then shows.
 */
async function open(page: Page, origin: string, path: string, theme: Theme, ready: () => Locator): Promise<void> {
  const join = path.includes("?") ? "&" : "?";
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(`${origin}${path}${join}theme=${theme}`, COMMIT);
      await ready().first().waitFor({ timeout: 30_000 });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await page.goto("about:blank");
    }
  }
}

/** The org chart with the agent's panel open. */
async function openOrgPanel(page: Page, origin: string, device: Device, theme: Theme): Promise<void> {
  const card = () =>
    page
      .getByRole("region", { name: t("workspace.view.org"), exact: true })
      .getByRole("button", { name: new RegExp(`^${AGENT}, `, "u") });
  if (device === "desktop") {
    // A computer opens the space on its last conversation; the sidebar's Org chart row opens the view.
    const name = { name: t("workspace.view.org"), exact: true };
    const row = () => page.getByRole("button", name).or(page.getByRole("link", name));
    await open(page, origin, "/app/general", theme, row);
    await row().first().click();
    await card().first().waitFor({ timeout: UI_WAIT_MS });
  } else {
    await open(page, origin, "/app/general/org", theme, card);
  }
  await tap(device, card().first());
  await panel(page)
    .getByRole("button", { name: t("workspace.org.openChat"), exact: true })
    .waitFor({ timeout: UI_WAIT_MS });
}

async function openFleet(page: Page, origin: string, theme: Theme): Promise<void> {
  await open(page, origin, "/app/general/fleet", theme, () =>
    page.getByRole("button", { name: t("workspace.fleet.settings", { name: AGENT }), exact: true }),
  );
}

async function shot(page: Page, dir: string, name: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
  await page.waitForTimeout(600);
  const file = resolve(dir, `${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  report.screenshots.push(file);
}

/** The panel, screen by screen, when it scrolls. */
async function panelShots(page: Page, dir: string, name: string): Promise<void> {
  await shot(page, dir, `${name}-1`);
  const scroller = panel(page).locator(".settings-panel-content, .ws-org-panel-scroll").first();
  for (let index = 2; index <= 4; index += 1) {
    const more = await scroller
      .evaluate((element) => {
        const before = element.scrollTop;
        element.scrollTop = before + element.clientHeight * 0.85;
        return element.scrollTop > before;
      })
      .catch(() => false);
    if (!more) return;
    await shot(page, dir, `${name}-${index}`);
  }
}

async function screenshots(page: Page, origin: string, device: Device, theme: Theme, label: string): Promise<void> {
  const dir = resolve(ROOT, ".openbot-build/ui-audit/org-fleet", label, device === "desktop" ? "1440" : "390");
  await openOrgPanel(page, origin, device, theme);
  await panelShots(page, dir, `org-panel-${theme}`);
  const change = panel(page).getByRole("button", { name: t("workspace.org.changeManager"), exact: true });
  await change.scrollIntoViewIfNeeded();
  await tap(device, change);
  await page.waitForTimeout(400);
  await shot(page, dir, `org-manager-picker-${theme}`);
  await page.keyboard.press("Escape");
  await openFleet(page, origin, theme);
  await shot(page, dir, `fleet-${theme}`);
  await page.getByRole("button", { name: t("workspace.layout.list"), exact: true }).click();
  await shot(page, dir, `fleet-list-${theme}`);
  await open(page, origin, "/app/general?page=settings&section=workspace", theme, () =>
    page.getByRole("heading", { name: t("server.settings.motionSection"), exact: true }),
  );
  await page
    .getByRole("heading", { name: t("server.settings.motionSection"), exact: true })
    .first()
    .scrollIntoViewIfNeeded();
  await shot(page, dir, `motion-events-${theme}`);
}

/** The group titles of the org chart panel, in order. */
const GROUPS = [t("workspace.org.panel.now"), t("workspace.org.panel.manager"), t("workspace.org.panel.reports")];

async function checks(page: Page, origin: string, device: Device): Promise<void> {
  await step(page, device, "the org chart panel shows its groups under their titles", async () => {
    await openOrgPanel(page, origin, device, "dark");
    for (const title of GROUPS) {
      await panel(page).getByRole("heading", { name: title }).first().waitFor({ timeout: UI_WAIT_MS });
    }
    await panel(page)
      .getByRole("button", { name: t("workspace.org.changeManager"), exact: true })
      .waitFor();
    if (device === "phone") {
      for (const name of [t("workspace.org.openChat"), t("workspace.org.changeManager")]) {
        const box = await panel(page).getByRole("button", { name, exact: true }).boundingBox();
        assert.ok(box && box.height >= 44, `${name} is ${box?.height ?? 0} px tall on a phone.`);
      }
    }
  });

  await step(page, device, "a new manager from the picker saves at once, with Undo", async () => {
    const change = panel(page).getByRole("button", { name: t("workspace.org.changeManager"), exact: true });
    await change.scrollIntoViewIfNeeded();
    await tap(device, change);
    const picker = page.getByRole("dialog", { name: t("workspace.org.changeManager") });
    await picker.waitFor({ timeout: UI_WAIT_MS });
    await picker.getByRole("textbox", { name: t("workspace.org.managerSearch") }).waitFor();
    // The first agent that is not Chief nor one of its reports.
    const choice = picker
      .getByRole("listitem")
      .filter({ hasNotText: t("workspace.org.topLevel") })
      .getByRole("button")
      .first();
    const managerName = (await choice.locator(".ws-picker-name").textContent())?.trim() ?? "";
    assert.ok(managerName, "The picker lists no agent that may manage Chief.");
    await tap(device, choice);
    await picker.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    // No save bar: the pick is stored, and the panel shows the new manager under Reports to.
    const managerGroup = panel(page).getByRole("region", { name: t("workspace.org.panel.manager") });
    await managerGroup.getByText(managerName, { exact: true }).waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await page.getByRole("button", { name: t("common.save"), exact: true }).count(), 0);
    await page
      .getByRole("button", { name: t("common.undo"), exact: true })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
  });

  await step(page, device, "a Fleet card names its actions, with touch-size targets on a phone", async () => {
    await openFleet(page, origin, "dark");
    const card = page.getByRole("listitem").filter({ hasText: AGENT }).first();
    const message = card.getByRole("button", { name: t("workspace.fleet.message"), exact: true });
    const settings = card.getByRole("button", { name: t("workspace.fleet.settings", { name: AGENT }), exact: true });
    await message.waitFor();
    await settings.waitFor();
    // The settings action reads its name, not only a gear.
    assert.equal((await settings.textContent())?.trim(), t("workspace.fleet.settingsShort"));
    const ticket = card.getByRole("link", { name: /MOT-12/u });
    await ticket.waitFor();
    if (device === "phone") {
      for (const target of [message, settings, ticket]) {
        const box = await target.boundingBox();
        assert.ok(box && box.height >= 44, `A Fleet card target is ${box?.height ?? 0} px tall on a phone.`);
      }
    }
    await tap(device, settings);
    await page
      .getByRole("textbox", { name: t("agentSettings.nameLabel"), exact: true })
      .waitFor({ timeout: UI_WAIT_MS });
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  // A cache of its own: the deploy suite runs several scripts at once.
  cacheDir: "node_modules/.vite-e2e/org-fleet-settings-e2e",
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: [`src/renderer/stories${ENTRY.slice("/src/renderer/stories".length)}`],
    include: ["@norbert_bodziony/bloub"],
  },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const listening = server.httpServer?.address();
assert.ok(listening && typeof listening === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${listening.port}`;
let browser: Browser | null = null;

async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  return page;
}

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  const contexts = {
    desktop: await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "es" }),
    phone: await browser.newContext({
      ...iphone,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      locale: "es",
    }),
  } as const;

  const shots = option("shots");
  if (shots) {
    for (const device of ["desktop", "phone"] as const) {
      for (const theme of ["dark", "light"] as const) {
        const page = await newPage(contexts[device]);
        await step(page, device, `screenshots ${theme}`, () => screenshots(page, origin, device, theme, shots));
        await page.close();
      }
    }
  }

  if (!process.argv.includes("--shots-only")) {
    for (const device of ["desktop", "phone"] as const) {
      const page = await newPage(contexts[device]);
      await checks(page, origin, device);
      await page.close();
    }
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
