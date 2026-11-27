// Checks the channel and space settings on the settings design system, in the web client on a
// computer (1440 px) and on an iPhone (390 px): the channel details (About, Members, Settings) and the
// older channel settings panel show their groups, a switch saves at once, a text field saves only
// through the one save bar, deleting a channel asks first, and the Edit space and Add members dialogs
// label their fields (a sheet on a phone). It serves `src/renderer/stories/web-settings-harness.tsx`,
// whose mock host answers the workspace routes; `?workspace=off` shows the older channel view. No
// account service, host or provider is needed.
//
// `bun scripts/channels-settings-e2e.ts [--browser-executable=<path>] [--headed] [--device=desktop|phone] [--shots=<label>] [--shots-only]`
// `--shots=<label>` also saves every surface at 1440 and 390, light and dark, under
// .openbot-build/ui-audit/channels/<label>/. Writes .openbot-build/channels-settings-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, devices, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("channels-settings-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/channels-settings-e2e");
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
    name: "openbot-channels-settings-harness",
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

const report: {
  steps: Step[];
  dialogs: { device: Device; flow: string; width: number; height: number; smallestTarget: number }[];
  pageErrors: string[];
  screenshots: string[];
  passed: boolean;
} = { steps: [], dialogs: [], pageErrors: [], screenshots: [], passed: false };

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
const details = (page: Page) => page.locator("section.ws-details");
const legacyPanel = (page: Page) => page.locator("#channel-side-panel");
const saveBar = (scope: Locator) => scope.getByRole("region", { name: t("channel.saveBar.label") });

/** Loads an address of the client. A page of the dev server can stay blank; a fresh load shows. */
async function load(page: Page, url: string, ready: () => Locator): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url, COMMIT);
      await ready().waitFor({ timeout: 30_000 });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await page.goto("about:blank");
    }
  }
}

/** Opens #general and its details panel on the given tab. */
async function openDetails(
  page: Page,
  origin: string,
  device: Device,
  theme: Theme,
  tab: "about" | "members" | "settings",
): Promise<void> {
  const button = () => page.getByRole("button", { name: t("workspace.header.details"), exact: true }).first();
  await load(page, `${origin}/app/general/c/general?theme=${theme}`, button);
  await tap(device, button());
  await details(page).waitFor({ timeout: UI_WAIT_MS });
  const label =
    tab === "about"
      ? t("workspace.details.about")
      : tab === "settings"
        ? t("workspace.details.settings")
        : new RegExp(`^${t("workspace.details.membersTab", { count: 0 }).replace(/\d+/u, "\\d+")}$`, "u");
  await tap(device, details(page).getByRole("tab", { name: label }));
  await page.waitForTimeout(300);
}

/** Opens #general in the older channel view, without the workspace, and its settings panel. */
async function openLegacySettings(page: Page, origin: string, device: Device, theme: Theme): Promise<void> {
  const toggle = () => page.getByRole("button", { name: t("conversation.sidePanel.open"), exact: true }).first();
  await load(page, `${origin}/app/general/c/general?theme=${theme}&workspace=off`, toggle);
  await tap(device, toggle());
  await tap(device, page.getByRole("button", { name: t("channel.settings.title"), exact: true }).first());
  await legacyPanel(page).waitFor({ timeout: UI_WAIT_MS });
}

/** Opens the Edit space dialog of Trading: the rail's menu on a computer, the space switcher on a phone. */
async function openEditSpace(page: Page, origin: string, device: Device, theme: Theme): Promise<Locator> {
  if (device === "desktop") {
    const rail = () =>
      page.getByRole("navigation", { name: t("workspace.spaces.label") }).getByRole("button", {
        name: "Trading",
        exact: true,
      });
    await load(page, `${origin}/app/general?theme=${theme}`, rail);
    await rail().click({ button: "right" });
    await page.getByRole("menuitem", { name: t("workspace.spaces.edit"), exact: true }).click();
  } else {
    const chat = () =>
      page
        .getByRole("navigation", { name: t("workspace.phone.tabs") })
        .getByRole("button", { name: new RegExp(`^${t("workspace.phone.chat")}`, "u") });
    const switcher = () => page.getByRole("button", { name: t("workspace.phone.switch") }).first();
    await load(page, `${origin}/app/general?theme=${theme}`, chat);
    await chat().tap();
    await switcher().tap();
    await page.getByText("Trading", { exact: true }).last().tap();
    await page.waitForURL(/market-trading/u);
    await chat().tap();
    await switcher().tap();
    await page.getByText(t("workspace.spaces.edit"), { exact: true }).last().tap();
  }
  const dialog = page.getByRole("dialog", { name: t("workspace.spaces.editTitle"), exact: true });
  await dialog.waitFor({ timeout: UI_WAIT_MS });
  await settle(dialog);
  return dialog;
}

/** The Add members dialog of #general, from the Members tab. */
async function openInvite(page: Page, origin: string, device: Device, theme: Theme): Promise<Locator> {
  await openDetails(page, origin, device, theme, "members");
  await tap(device, details(page).getByRole("button", { name: t("workspace.details.addPeople"), exact: true }));
  const dialog = page.getByRole("dialog", { name: t("workspace.app.invite.title", { name: "general" }), exact: true });
  await dialog.waitFor({ timeout: UI_WAIT_MS });
  await settle(dialog);
  return dialog;
}

async function settle(dialog: Locator): Promise<void> {
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
}

/** A phone shows a form dialog as a sheet, and every button in it is at least 44 px tall. */
async function checkSheet(page: Page, device: Device, flow: string, dialog: Locator): Promise<void> {
  const box = await dialog.boundingBox();
  assert.ok(box, `${flow}: the dialog has no box`);
  const size = page.viewportSize();
  assert.ok(size);
  const smallestTarget = await dialog.evaluate((element) =>
    Math.min(
      ...[...element.querySelectorAll<HTMLElement>("button, input, textarea, [role=combobox]")]
        .filter((item) => item.offsetParent !== null && !item.closest(".sr-only"))
        .map((item) => {
          const rect = item.getBoundingClientRect();
          // A switch counts its label row; the search counts the frame of its field.
          const row = item.closest("label, .ui-settings-row, .ws-picker-field");
          return Math.max(rect.height, row ? row.getBoundingClientRect().height : 0);
        }),
    ),
  );
  report.dialogs.push({
    device,
    flow,
    width: Math.round(box.width),
    height: Math.round(box.height),
    smallestTarget: Math.round(smallestTarget),
  });
  if (device !== "phone") return;
  assert.ok(
    box.width >= size.width - 1 && box.y + box.height >= size.height - 1 && box.height >= size.height * 0.9,
    `${flow}: a phone shows a full-height sheet`,
  );
  assert.ok(smallestTarget >= 43.5, `${flow}: a target is ${smallestTarget} px tall`);
}

/** The scroller under `scope`, one screen at a time, from the top. */
async function scrollShots(page: Page, scroller: Locator, dir: string, name: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
  await page.waitForTimeout(400);
  for (let index = 1; index <= 6; index += 1) {
    const file = resolve(dir, `${name}-${index}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    report.screenshots.push(file);
    const more = await scroller
      .evaluate((element) => {
        const before = element.scrollTop;
        element.scrollTop = before + element.clientHeight * 0.85;
        return element.scrollTop > before;
      })
      .catch(() => false);
    if (!more) return;
    await page.waitForTimeout(150);
  }
}

async function oneShot(page: Page, dir: string, name: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  const file = resolve(dir, `${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  report.screenshots.push(file);
}

async function shots(page: Page, origin: string, device: Device, label: string): Promise<void> {
  const dir = resolve(ROOT, ".openbot-build/ui-audit/channels", label, device === "desktop" ? "1440" : "390");
  for (const theme of ["dark", "light"] as const) {
    for (const tab of ["about", "members", "settings"] as const)
      await step(page, device, `screenshots ${theme} details ${tab}`, async () => {
        await openDetails(page, origin, device, theme, tab);
        const scroller = details(page).locator(`[role="tabpanel"]`).first();
        await scrollShots(page, scroller, dir, `details-${tab}-${theme}`);
      });
    await step(page, device, `screenshots ${theme} channel settings panel`, async () => {
      await openLegacySettings(page, origin, device, theme);
      await scrollShots(
        page,
        legacyPanel(page).locator(".settings-panel-content").first(),
        dir,
        `channel-settings-panel-${theme}`,
      );
    });
    await step(page, device, `screenshots ${theme} edit space`, async () => {
      await openEditSpace(page, origin, device, theme);
      await oneShot(page, dir, `edit-space-${theme}`);
    });
    await step(page, device, `screenshots ${theme} add members`, async () => {
      await openInvite(page, origin, device, theme);
      await oneShot(page, dir, `add-members-${theme}`);
    });
  }
}

async function checks(page: Page, origin: string, device: Device): Promise<void> {
  await step(page, device, "the channel details show their groups and labelled fields", async () => {
    await openDetails(page, origin, device, "dark", "about");
    await details(page)
      .getByRole("heading", { name: t("workspace.details.aboutSection"), exact: true })
      .waitFor();
    await details(page)
      .getByRole("textbox", { name: t("workspace.details.topic"), exact: true })
      .waitFor();
    await details(page)
      .getByRole("textbox", { name: t("workspace.details.description"), exact: true })
      .waitFor();
    await tap(device, details(page).getByRole("tab", { name: t("workspace.details.settings"), exact: true }));
    for (const title of [t("workspace.details.accessSection"), t("workspace.details.dangerSection")])
      await details(page).getByRole("heading", { name: title, exact: true }).waitFor({ timeout: UI_WAIT_MS });
  });

  await step(page, device, "a switch in the channel details saves at once, with no save bar", async () => {
    const privateSwitch = details(page).getByRole("switch", { name: t("workspace.details.private") });
    await privateSwitch.waitFor({ state: "attached", timeout: UI_WAIT_MS });
    const before = await privateSwitch.isChecked();
    const row = details(page).locator(`label[for="${await privateSwitch.getAttribute("id")}"]`);
    await row.scrollIntoViewIfNeeded();
    await tap(device, row);
    await page.waitForFunction(
      ({ label, expected }) =>
        document
          .querySelector(`section.ws-details [role="switch"][aria-label="${label}"]`)
          ?.getAttribute("aria-checked") === expected,
      { label: t("workspace.details.private"), expected: String(!before) },
      { timeout: UI_WAIT_MS },
    );
    assert.equal(await saveBar(details(page)).count(), 0, "A switch shows no save bar.");
    // Put it back, so the next run starts from the same channel.
    await tap(device, row);
  });

  await step(page, device, "the topic saves through the save bar only", async () => {
    await tap(device, details(page).getByRole("tab", { name: t("workspace.details.about"), exact: true }));
    const topic = details(page).getByRole("textbox", { name: t("workspace.details.topic"), exact: true });
    const next = `Ventas de la semana ${device}`;
    await topic.fill(next);
    await topic.blur();
    const bar = saveBar(details(page));
    await bar.waitFor({ timeout: UI_WAIT_MS });
    await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
    assert.equal(await bar.count(), 1, "The bar left before Save.");
    await tap(device, bar.getByRole("button", { name: t("common.save"), exact: true }));
    await bar.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await topic.inputValue(), next);
    // The channel header reads the channel from the host: it shows the new topic.
    if (device === "desktop") await page.getByText(next, { exact: true }).first().waitFor({ timeout: UI_WAIT_MS });
  });

  await step(page, device, "Reset puts the description back and hides the bar", async () => {
    const description = details(page).getByRole("textbox", { name: t("workspace.details.description"), exact: true });
    const saved = await description.inputValue();
    await description.fill("Otra descripción");
    const bar = saveBar(details(page));
    await bar.waitFor({ timeout: UI_WAIT_MS });
    await tap(device, bar.getByRole("button", { name: t("server.settings.reset"), exact: true }));
    await bar.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await description.inputValue(), saved);
  });

  await step(page, device, "deleting the channel asks first", async () => {
    await tap(device, details(page).getByRole("tab", { name: t("workspace.details.settings"), exact: true }));
    const remove = details(page).getByRole("button", { name: t("workspace.details.archiveButton"), exact: true });
    await remove.scrollIntoViewIfNeeded();
    await tap(device, remove);
    const confirm = page.getByRole("alertdialog", { name: t("sidebar.delete.title", { name: "general" }) });
    await confirm.waitFor({ timeout: UI_WAIT_MS });
    await tap(device, confirm.getByRole("button", { name: t("common.cancel"), exact: true }));
    await confirm.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await details(page).waitFor();
  });

  await step(page, device, "the channel settings panel saves its text through the save bar", async () => {
    await openLegacySettings(page, origin, device, "dark");
    for (const title of [t("channel.settings.identitySection"), t("channel.members.title")])
      await legacyPanel(page).getByRole("heading", { name: title, exact: true }).waitFor({ timeout: UI_WAIT_MS });
    const title = legacyPanel(page).getByRole("textbox", { name: t("channel.form.titleLabel"), exact: true });
    const next = `Equipo de ventas ${device}`;
    await title.fill(next);
    await title.blur();
    const bar = saveBar(legacyPanel(page));
    await bar.waitFor({ timeout: UI_WAIT_MS });
    await page.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
    assert.equal(await bar.count(), 1, "A blur saved the title.");
    await tap(device, bar.getByRole("button", { name: t("common.save"), exact: true }));
    await bar.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await title.inputValue(), next);
  });

  await step(page, device, "Edit space labels its fields and fits a phone", async () => {
    const dialog = await openEditSpace(page, origin, device, "dark");
    await dialog.getByRole("textbox", { name: t("workspace.spaces.name") }).waitFor();
    await dialog.getByRole("group", { name: t("workspace.spaces.color") }).waitFor();
    await checkSheet(page, device, "edit-space", dialog);
    await tap(device, dialog.getByRole("button", { name: t("common.cancel"), exact: true }));
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });

  await step(page, device, "Add members labels its search and fits a phone", async () => {
    const dialog = await openInvite(page, origin, device, "dark");
    await dialog.getByRole("textbox", { name: t("workspace.app.invite.label") }).waitFor();
    await checkSheet(page, device, "add-members", dialog);
    await tap(device, dialog.getByRole("button", { name: t("common.cancel"), exact: true }));
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  // A cache of its own: the deploy suite runs several scripts at once.
  cacheDir: "node_modules/.vite-e2e/channels-settings-e2e",
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
  page.setDefaultTimeout(30_000);
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

  // `--device=phone` or `--device=desktop` runs one of them.
  const only = option("device");
  const runDevices = (["desktop", "phone"] as const).filter((device) => !only || device === only);
  const label = option("shots");
  if (label) {
    for (const device of runDevices) {
      const page = await newPage(contexts[device]);
      await shots(page, origin, device, label);
      await page.close();
    }
  }

  if (!process.argv.includes("--shots-only")) {
    for (const device of runDevices) {
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
