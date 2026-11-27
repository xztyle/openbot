// Checks an agent's settings panel on the settings design system, in the web client on a computer
// (1440 px) and on an iPhone (390 px): every group shows under its title, a switch saves at once,
// a text field saves only through the one save bar, and forgetting what the agent learned asks first.
// It serves `src/renderer/stories/web-settings-harness.tsx`, whose mock host answers the agent
// efficiency and learning routes; no account service, host or provider is needed.
//
// `bun scripts/agent-settings-page-e2e.ts [--browser-executable=<path>] [--headed] [--shots=<label>] [--shots-only]`
// `--shots=<label>` also saves the whole panel, screen by screen, at 1440 and 390, light and dark, under
// .openbot-build/ui-agent-settings/<label>/. Writes .openbot-build/agent-settings-page-e2e/report.json.
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

const logger = createOpenBotLogger("agent-settings-page-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/agent-settings-page-e2e");
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
    name: "openbot-agent-settings-page-harness",
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

const panel = (page: Page) => page.locator("#settings-side-panel");
const nameField = (page: Page) => panel(page).getByRole("textbox", { name: t("agentSettings.nameLabel"), exact: true });
const tap = (device: Device, target: ReturnType<Page["locator"]>) =>
  device === "phone" ? target.tap() : target.click();

/**
 * Opens Chief's settings from the gear of its Fleet card. A page of the dev server can stay blank
 * with its modules pending; a fresh load of the same address then shows.
 */
async function openChiefSettings(page: Page, origin: string, device: Device, theme: "dark" | "light"): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (device === "desktop") {
        await page.goto(`${origin}/app/general/fleet?theme=${theme}`, COMMIT);
      } else {
        await page.goto(`${origin}/app/general?theme=${theme}`, COMMIT);
        const agents = page
          .getByRole("navigation", { name: t("workspace.phone.tabs") })
          .getByRole("button", { name: new RegExp(`^${t("workspace.phone.agents")}`, "u") });
        await agents.waitFor({ timeout: 30_000 });
        await agents.tap();
      }
      const gear = page.getByRole("button", { name: t("workspace.fleet.settings", { name: "Chief" }), exact: true });
      await gear.waitFor({ timeout: 30_000 });
      await tap(device, gear);
      await nameField(page).waitFor({ timeout: 30_000 });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await page.goto("about:blank");
    }
  }
}

/** The panel, one screen at a time, from the top to the end of its content. */
async function panelShots(page: Page, dir: string, name: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const content = panel(page).locator(".settings-panel-content").first();
  await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
  await page.waitForTimeout(500);
  for (let index = 1; index <= 8; index += 1) {
    const file = resolve(dir, `${name}-${index}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    report.screenshots.push(file);
    const more = await content.evaluate((element) => {
      const before = element.scrollTop;
      element.scrollTop = before + element.clientHeight * 0.85;
      return element.scrollTop > before;
    });
    if (!more) return;
    await page.waitForTimeout(150);
  }
}

/** The groups of the panel, by their titles, in order. */
const GROUPS = [
  t("agentSettings.group.identity"),
  t("agentSettings.group.where"),
  t("agentSettings.group.model"),
  t("agentSettings.group.access"),
  t("agentSettings.group.state"),
  t("agentSettings.group.performance"),
  t("agentSettings.group.memory"),
  t("efficiency.history.title"),
];

async function checks(page: Page, origin: string, device: Device): Promise<void> {
  await step(page, device, "every group of the panel shows under its title", async () => {
    await openChiefSettings(page, origin, device, "dark");
    for (const title of GROUPS) {
      const heading = panel(page).getByRole("heading", { name: title, exact: true });
      await heading.waitFor({ timeout: UI_WAIT_MS });
    }
    // Every field has a label: the role and the focus are named by their rows.
    await panel(page)
      .getByRole("textbox", { name: t("efficiency.role.label"), exact: true })
      .waitFor();
    await panel(page)
      .getByRole("button", { name: t("efficiency.review.run"), exact: true })
      .waitFor();
  });

  await step(page, device, "a switch saves at once, with no save bar", async () => {
    const label = t("agentSettings.notifications.title");
    const notifications = panel(page).getByRole("switch", { name: label });
    await notifications.waitFor({ state: "attached", timeout: UI_WAIT_MS });
    const before = await notifications.isChecked();
    // The switch's input is visually hidden; a finger presses the row's label, which names it.
    const rowLabel = panel(page).locator('label[for="agent-settings-notifications-title"]');
    await rowLabel.scrollIntoViewIfNeeded();
    await tap(device, rowLabel);
    await page.waitForFunction(
      (expected) =>
        document.getElementById("agent-settings-notifications-title")?.getAttribute("aria-checked") === expected,
      String(!before),
      { timeout: UI_WAIT_MS },
    );
    assert.equal(
      await panel(page)
        .getByRole("region", { name: t("agentSettings.saveBar.label") })
        .count(),
      0,
      "A switch shows no save bar.",
    );
    // A failed save puts the switch back; a saved one stays.
    await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
    assert.equal(await notifications.isChecked(), !before);
  });

  await step(page, device, "a text field saves through the save bar only", async () => {
    const title = panel(page).getByRole("textbox", { name: t("agentSettings.agentTitleLabel"), exact: true });
    const next = `Jefe ${device}`;
    await title.fill(next);
    await title.blur();
    const bar = panel(page).getByRole("region", { name: t("agentSettings.saveBar.label") });
    await bar.waitFor({ timeout: UI_WAIT_MS });
    // A blur does not save: the bar stays until Save.
    await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
    assert.equal(await bar.count(), 1, "The bar left before Save.");
    await tap(device, bar.getByRole("button", { name: t("common.save"), exact: true }));
    // The bar leaves only when the host stored the change.
    await bar.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await title.inputValue(), next);
    if (device === "desktop")
      // The conversation header reads the agent from the host: it shows the new title.
      await page.locator(".conversation-header, header").getByText(next, { exact: true }).first().waitFor({
        timeout: UI_WAIT_MS,
      });
  });

  await step(page, device, "Reset puts a text field back and hides the bar", async () => {
    const title = panel(page).getByRole("textbox", { name: t("agentSettings.agentTitleLabel"), exact: true });
    const saved = await title.inputValue();
    await title.fill("Otro título");
    const bar = panel(page).getByRole("region", { name: t("agentSettings.saveBar.label") });
    await bar.waitFor({ timeout: UI_WAIT_MS });
    await tap(device, bar.getByRole("button", { name: t("server.settings.reset"), exact: true }));
    await bar.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await title.inputValue(), saved);
  });

  await step(page, device, "forgetting what the agent learned asks first", async () => {
    const forget = panel(page).getByRole("button", { name: t("agentSettings.memory.forgetButton"), exact: true });
    await forget.scrollIntoViewIfNeeded();
    await tap(device, forget);
    const dialog = page.getByRole("alertdialog", { name: t("agentSettings.memory.forgetTitle") });
    await dialog.waitFor({ timeout: UI_WAIT_MS });
    await dialog.getByText("La panadería abre a las 8 los domingos.").waitFor();
    const calls = () => page.evaluate(() => window.settingsHarnessCalls ?? []);
    const forgetCalls = async () =>
      (await calls()).filter((path) => path === "/v1/workspace/learning/forget-conversation").length;
    // Only the preview so far: nothing is forgotten until the confirm.
    assert.equal(await forgetCalls(), 1);
    await tap(device, dialog.getByRole("button", { name: t("common.cancel"), exact: true }));
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await forgetCalls(), 1);
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  // A cache of its own: the deploy suite runs several scripts at once.
  cacheDir: "node_modules/.vite-e2e/agent-settings-page-e2e",
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
      const page = await newPage(contexts[device]);
      for (const theme of ["dark", "light"] as const) {
        await step(page, device, `screenshots ${theme}`, async () => {
          await openChiefSettings(page, origin, device, theme);
          await panelShots(
            page,
            resolve(ROOT, ".openbot-build/ui-agent-settings", shots, device === "desktop" ? "1440" : "390"),
            `agent-settings-${theme}`,
          );
          // The pages behind the Access and Advanced rows.
          for (const [row, name] of [
            [t("agentSettings.permissions.title"), "access"],
            [t("agentSettings.advanced.title"), "advanced"],
          ] as const) {
            await openChiefSettings(page, origin, device, theme);
            const link = panel(page)
              .getByRole("button", { name: new RegExp(`^${row}`, "u") })
              .first();
            await link.scrollIntoViewIfNeeded();
            await tap(device, link);
            await panel(page)
              .getByRole("button", { name: t("agentSettings.backToSettings") })
              .waitFor({ timeout: UI_WAIT_MS });
            await panelShots(
              page,
              resolve(ROOT, ".openbot-build/ui-agent-settings", shots, device === "desktop" ? "1440" : "390"),
              `agent-settings-${name}-${theme}`,
            );
          }
        });
      }
      await page.close();
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
