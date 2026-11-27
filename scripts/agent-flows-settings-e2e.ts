// Checks the agent flows on the settings design system, in the web client on a computer (1440 px) and
// on an iPhone (390 px): the New agent dialog, an agent's routines (the list and the editor of one
// routine), its event checks, its backup models and the Schedule page. The routine editor keeps its own
// Save: a change shows Save and is stored only when Save is pressed, and Delete asks first. A backup
// models switch saves at once. It serves `src/renderer/stories/web-settings-harness.tsx` with
// `?routines=1`, whose mock host answers the routine, event check and backup model routes; no account
// service, host or provider is needed.
//
// `bun scripts/agent-flows-settings-e2e.ts [--browser-executable=<path>] [--headed] [--shots=<label>] [--shots-only]`
// `--shots=<label>` also saves each surface at 1440 and 390, light and dark, under
// .openbot-build/ui-audit/agent-flows/<label>/. Writes .openbot-build/agent-flows-settings-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, devices, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

declare global {
  interface Window {
    /** The admin routes the harness answered, in order (`src/renderer/stories/web-settings-harness.tsx`). */
    settingsHarnessCalls?: string[];
  }
}

const logger = createOpenBotLogger("agent-flows-settings-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/agent-flows-settings-e2e");
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
    name: "openbot-agent-flows-harness",
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

const panel = (page: Page) => page.locator("#settings-side-panel");
const nameField = (page: Page) => panel(page).getByRole("textbox", { name: t("agentSettings.nameLabel"), exact: true });
const tap = (device: Device, target: Locator) => (device === "phone" ? target.tap() : target.click());
const calls = (page: Page) => page.evaluate(() => window.settingsHarnessCalls ?? []);
const callCount = async (page: Page, path: string) => (await calls(page)).filter((item) => item === path).length;

/** The app at an address, loaded again when the dev server leaves a page blank with its modules pending. */
async function load(page: Page, url: string, ready: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url, COMMIT);
      await ready();
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await page.goto("about:blank");
    }
  }
}

/** Opens Chief's settings from the gear of its Fleet card. */
async function openChiefSettings(page: Page, origin: string, device: Device, theme: Theme): Promise<void> {
  await load(
    page,
    `${origin}/app/general${device === "desktop" ? "/fleet" : ""}?routines=1&theme=${theme}`,
    async () => {
      if (device === "phone") {
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
    },
  );
}

/** A row of the settings panel that opens a page, by the start of its name. */
async function openPanelLink(page: Page, device: Device, label: string): Promise<void> {
  const link = panel(page)
    .getByRole("button", { name: new RegExp(`^${label}`, "u") })
    .first();
  await link.waitFor({ timeout: UI_WAIT_MS });
  await link.scrollIntoViewIfNeeded();
  await tap(device, link);
}

const routinesPane = (page: Page) => panel(page).locator(".agent-routines-settings").first();

async function openRoutines(page: Page, device: Device): Promise<void> {
  await openPanelLink(page, device, t("agentSettings.links.routines"));
  await routinesPane(page).getByText("Resumen de la mañana").first().waitFor({ timeout: UI_WAIT_MS });
}

async function openRoutine(page: Page, device: Device, name: string): Promise<void> {
  await tap(
    device,
    routinesPane(page)
      .getByRole("button", { name: new RegExp(`^${name}`, "u") })
      .first(),
  );
  await routinesPane(page)
    .getByRole("textbox", { name: new RegExp(`^${t("routine.settings.name")}`, "u") })
    .waitFor({ timeout: UI_WAIT_MS });
}

async function openChecks(page: Page, device: Device): Promise<void> {
  await openPanelLink(page, device, t("agentSettings.links.eventChecks"));
  await routinesPane(page).getByText("Pedidos nuevos").first().waitFor({ timeout: UI_WAIT_MS });
}

async function openBackupModels(page: Page, device: Device): Promise<void> {
  await openPanelLink(page, device, t("agentSettings.backupModels.title"));
  await panel(page)
    .getByRole("heading", { name: t("agentSettings.backupModels.title"), exact: true })
    .waitFor({ timeout: UI_WAIT_MS });
}

const newAgentDialog = (page: Page) =>
  page.getByRole("dialog", { name: t("agent.setup.titleAdditional"), exact: true });

async function openNewAgent(page: Page, origin: string, device: Device, theme: Theme): Promise<void> {
  await load(page, `${origin}/app/general?routines=1&theme=${theme}`, async () => {
    if (device === "phone") {
      const chat = page
        .getByRole("navigation", { name: t("workspace.phone.tabs") })
        .getByRole("button", { name: new RegExp(`^${t("workspace.phone.chat")}`, "u") });
      await chat.waitFor({ timeout: 30_000 });
      await chat.tap();
    }
    const add = page.getByRole("button", { name: t("workspace.sidebar.addAgent"), exact: true }).first();
    await add.waitFor({ timeout: 30_000 });
    await tap(device, add);
    await newAgentDialog(page).waitFor({ timeout: 30_000 });
  });
}

async function openSchedule(page: Page, origin: string, theme: Theme): Promise<void> {
  await load(page, `${origin}/app/general?page=schedule&routines=1&theme=${theme}`, async () => {
    await page.locator("text=Resumen de la mañana >> visible=true").first().waitFor({ timeout: 30_000 });
  });
}

/** The visible screen, then each further screen of the scrolling element, up to `limit`. */
async function shots(page: Page, dir: string, name: string, scroller: Locator | null, limit = 4): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
  await page.waitForTimeout(500);
  for (let index = 1; index <= limit; index += 1) {
    const file = resolve(dir, `${name}-${index}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    report.screenshots.push(file);
    if (!scroller || (await scroller.count()) === 0) return;
    const more = await scroller.first().evaluate((element) => {
      const before = element.scrollTop;
      element.scrollTop = before + element.clientHeight * 0.85;
      return element.scrollTop > before;
    });
    if (!more) return;
    await page.waitForTimeout(150);
  }
}

async function screenshots(page: Page, origin: string, device: Device, label: string): Promise<void> {
  const dir = resolve(ROOT, ".openbot-build/ui-audit/agent-flows", label, device === "desktop" ? "1440" : "390");
  const body = () => routinesPane(page).locator(".agent-routines-body");
  for (const theme of ["dark", "light"] as const) {
    await step(page, device, `screenshots: new agent, ${theme}`, async () => {
      await openNewAgent(page, origin, device, theme);
      await shots(page, dir, `new-agent-${theme}`, newAgentDialog(page).locator(".ui-form-dialog-body"));
    });
    await step(page, device, `screenshots: routines, ${theme}`, async () => {
      await openChiefSettings(page, origin, device, theme);
      await openRoutines(page, device);
      await shots(page, dir, `routines-list-${theme}`, null);
      await openRoutine(page, device, "Resumen de la mañana");
      await shots(page, dir, `routine-editor-${theme}`, body());
    });
    await step(page, device, `screenshots: event checks, ${theme}`, async () => {
      await openChiefSettings(page, origin, device, theme);
      await openChecks(page, device);
      await shots(page, dir, `checks-list-${theme}`, null);
      await tap(
        device,
        routinesPane(page)
          .getByRole("button", { name: /^Pedidos nuevos/u })
          .first(),
      );
      await routinesPane(page)
        .getByRole("heading", { name: t("agentSettings.eventCheck.check"), exact: true })
        .waitFor({ timeout: UI_WAIT_MS });
      await shots(page, dir, `check-editor-${theme}`, body(), 6);
    });
    await step(page, device, `screenshots: backup models, ${theme}`, async () => {
      await openChiefSettings(page, origin, device, theme);
      await openBackupModels(page, device);
      await shots(page, dir, `backup-models-${theme}`, panel(page).locator(".settings-panel-content"));
    });
    await step(page, device, `screenshots: schedule, ${theme}`, async () => {
      await openSchedule(page, origin, theme);
      await shots(page, dir, `schedule-${theme}`, null);
    });
  }
}

async function checks(page: Page, origin: string, device: Device): Promise<void> {
  await step(page, device, "the New agent dialog names every field and creates nothing on Cancel", async () => {
    await openNewAgent(page, origin, device, "dark");
    const dialog = newAgentDialog(page);
    const name = dialog.getByRole("textbox", { name: t("agent.setup.name") });
    await name.waitFor({ timeout: UI_WAIT_MS });
    await name.fill("Nadia");
    await tap(device, dialog.getByRole("button", { name: t("common.cancel"), exact: true }));
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await page.getByText("Nadia", { exact: true }).count(), 0, "Cancel made an agent.");
  });

  await step(page, device, "the routines list shows each routine, and Pause saves at once", async () => {
    await openChiefSettings(page, origin, device, "dark");
    await openRoutines(page, device);
    await routinesPane(page).getByText("Revisión semanal").first().waitFor();
    const saves = await callCount(page, "/v1/admin/events/routines/save");
    const pause = routinesPane(page).getByRole("button", {
      name: t("routine.settings.pauseNamed", { name: "Resumen de la mañana" }),
      exact: true,
    });
    await tap(device, pause);
    await routinesPane(page)
      .getByRole("button", { name: t("routine.settings.resumeNamed", { name: "Resumen de la mañana" }), exact: true })
      .waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await callCount(page, "/v1/admin/events/routines/save"), saves + 1);
    // Put it back for the next steps.
    await tap(
      device,
      routinesPane(page).getByRole("button", {
        name: t("routine.settings.resumeNamed", { name: "Resumen de la mañana" }),
        exact: true,
      }),
    );
    await pause.waitFor({ timeout: UI_WAIT_MS });
  });

  await step(page, device, "the routine editor saves only on Save", async () => {
    await openRoutine(page, device, "Resumen de la mañana");
    const name = routinesPane(page).getByRole("textbox", { name: new RegExp(`^${t("routine.settings.name")}`, "u") });
    const saves = await callCount(page, "/v1/admin/events/routines/save");
    await name.fill(`Resumen ${device}`);
    await name.blur();
    const save = routinesPane(page).getByRole("button", { name: t("common.save"), exact: true });
    await save.waitFor({ timeout: UI_WAIT_MS });
    // The active switch is a field of the routine: it waits for Save too.
    const active = routinesPane(page).getByRole("switch").first();
    await active.waitFor({ state: "attached" });
    await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
    assert.equal(await callCount(page, "/v1/admin/events/routines/save"), saves, "A change saved before Save.");
    await tap(device, save);
    await save.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await callCount(page, "/v1/admin/events/routines/save"), saves + 1);
    assert.equal(await name.inputValue(), `Resumen ${device}`);
  });

  await step(page, device, "deleting a routine asks first", async () => {
    const deletes = () => callCount(page, "/v1/admin/events/routines/delete");
    const before = await deletes();
    const remove = routinesPane(page).getByRole("button", { name: t("common.delete"), exact: true });
    await remove.scrollIntoViewIfNeeded();
    await tap(device, remove);
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: UI_WAIT_MS });
    await tap(device, dialog.getByRole("button", { name: t("common.cancel"), exact: true }));
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await deletes(), before, "Cancel deleted the routine.");
  });

  await step(page, device, "the event checks list opens a check with its fields named", async () => {
    await openChiefSettings(page, origin, device, "dark");
    await openChecks(page, device);
    await tap(
      device,
      routinesPane(page)
        .getByRole("button", { name: /^Pedidos nuevos/u })
        .first(),
    );
    const name = routinesPane(page).getByRole("textbox", {
      name: new RegExp(`^${t("agentSettings.eventCheck.name")}`, "u"),
    });
    await name.waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await name.inputValue(), "Pedidos nuevos");
  });

  await step(page, device, "a backup models switch saves at once", async () => {
    await openChiefSettings(page, origin, device, "dark");
    await openBackupModels(page, device);
    const route = "/v1/admin/agents/backup-models/update";
    const before = await callCount(page, route);
    const automatic = panel(page).getByRole("switch").first();
    await automatic.waitFor({ state: "attached", timeout: UI_WAIT_MS });
    const was = await automatic.isChecked();
    const id = await automatic.getAttribute("id");
    const target = id ? panel(page).locator(`label[for="${id}"]`) : automatic;
    await target.scrollIntoViewIfNeeded();
    await tap(device, target);
    await page.waitForFunction(
      ([path, count]) => (window.settingsHarnessCalls ?? []).filter((item) => item === path).length > Number(count),
      [route, String(before)],
      { timeout: UI_WAIT_MS },
    );
    assert.equal(await automatic.isChecked(), !was);
  });

  await step(page, device, "the Schedule page shows Chief's routine", async () => {
    await openSchedule(page, origin, "dark");
    await page.locator("text=Resumen de la mañana >> visible=true").first().waitFor({ timeout: UI_WAIT_MS });
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  // A cache of its own: the deploy suite runs several scripts at once.
  cacheDir: "node_modules/.vite-e2e/agent-flows-settings-e2e",
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
    // The routines of the fixture keep Madrid time: another zone would ask to move them.
    desktop: await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "es",
      timezoneId: "Europe/Madrid",
    }),
    phone: await browser.newContext({
      ...iphone,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      locale: "es",
      timezoneId: "Europe/Madrid",
    }),
  } as const;

  const label = option("shots");
  if (label) {
    for (const device of ["desktop", "phone"] as const) {
      const page = await newPage(contexts[device]);
      await screenshots(page, origin, device, label);
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
