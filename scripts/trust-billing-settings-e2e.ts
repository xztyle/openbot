// Checks Trust, Billing and the connectors on the settings design system, in Chromium on a computer
// (1440 px) and on an iPhone (390 px), in Spanish: the groups of each page show under their titles,
// a rule of Trust saves only through its save bar and Reset puts it back, cancelling a renewal and
// disconnecting GitHub ask first, a chat app's access changes at once in its dialog, and a connect
// dialog keeps the person's key and shows why a connection failed.
//
// It serves three harnesses: `src/renderer/stories/views-harness.tsx` (the web client with the Trust
// view), `src/renderer/stories/trust-guardrails-harness.tsx` (the Guardrails tab with the meter and
// the events) and `src/renderer/stories/trust-billing-harness.tsx` (Billing, the connectors and the
// MCP connect dialogs). No account service, host or provider is needed.
//
// `bun scripts/trust-billing-settings-e2e.ts [--browser-executable=<path>] [--headed] [--shots=<label>] [--shots-only]`
// `--only=<surface,…>` and `--devices=phone` narrow the screenshots.
// `--shots=<label>` also saves every surface, screen by screen, at 1440 and 390, light and dark, under
// .openbot-build/ui-audit/trust-billing/<label>/. Writes .openbot-build/trust-billing-settings-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, devices, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("trust-billing-settings-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/trust-billing-settings-e2e");
const SHOTS = resolve(ROOT, ".openbot-build/ui-audit/trust-billing");
const UI_WAIT_MS = 60_000;
const t = translateFor("es");
const COMMIT = { waitUntil: "commit" } as const;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const page = (entry: string) => `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Atelier</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/${entry}"></script>
  </body>
</html>`;

/** `/app…` is the web client with Trust, `/guardrails` the Guardrails tab, `/audit` the rest. */
function harnessPages(): Plugin {
  const routes: [RegExp, string][] = [
    [/^\/app(?:[/?]|$)/u, "views-harness.tsx"],
    [/^\/guardrails(?:[/?]|$)/u, "trust-guardrails-harness.tsx"],
    [/^\/audit(?:[/?]|$)/u, "trust-billing-harness.tsx"],
  ];
  return {
    name: "openbot-trust-billing-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        const entry = routes.find(([pattern]) => pattern.test(url))?.[1];
        if (!entry) return next();
        const html = await server.transformIndexHtml(url, page(entry));
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

async function step(target: Page, device: Device, name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    report.steps.push({ name, device, passed: true });
    logger.info(`ok: ${device}: ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report.steps.push({ name, device, passed: false, detail: detail.slice(0, 800) });
    logger.error(`failed: ${device}: ${name}: ${detail}`);
    const file = resolve(OUT, `failed-${report.steps.length}-${device}.png`);
    await target.screenshot({ path: file }).catch(() => undefined);
    report.screenshots.push(file);
  }
}

const tap = (device: Device, target: Locator) => (device === "phone" ? target.tap() : target.click());
const calls = (target: Page, key: "harnessCalls" | "viewsCalls" | "guardrailsCalls") =>
  target.evaluate((name) => document.body.dataset[name] ?? "", key);

/**
 * Opens one address of a harness and waits for `ready`. A page of the dev server can stay blank with
 * its modules pending; a fresh load of the same address then shows.
 */
async function openAt(target: Page, address: string, ready: (target: Page) => Locator): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await target.goto(address, COMMIT);
      await ready(target).first().waitFor({ timeout: 40_000 });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await target.goto("about:blank");
    }
  }
}

/** The Trust view of the web client, on its tab. A phone opens it from its address too. */
async function openTrust(target: Page, origin: string, theme: Theme, tab: "rules" | "guardrails" | "audit") {
  await openAt(target, `${origin}/app/general/trust?lang=es&appearance=${theme}`, (current) =>
    current.getByRole("heading", { name: t("trust.title"), exact: true }),
  );
  if (tab === "rules") {
    await target
      .getByRole("heading", { name: t("trust.roles"), exact: true })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    return;
  }
  const label = tab === "guardrails" ? t("trust.tab.guardrails") : t("trust.tab.audit");
  await target.getByRole("tab", { name: label, exact: true }).click();
  await target
    .getByRole("heading", {
      name: tab === "guardrails" ? t("trust.guardrails.limits") : t("trust.tab.audit"),
      exact: true,
    })
    .first()
    .waitFor({ timeout: UI_WAIT_MS });
}

const harness = (origin: string, surface: string, theme: Theme) => `${origin}/audit?surface=${surface}&theme=${theme}`;

/** The row of a connector in the list of Server settings > Connectors: a button over its width. */
const hubRow = (target: Page, name: string) =>
  target.getByRole("button", { name: t("connector.hub.open", { name }), exact: true });

/** Server settings > Connectors, and the page of one connector. */
async function openConnector(target: Page, origin: string, theme: Theme, name: string, device: Device = "desktop") {
  await openAt(target, harness(origin, "connectors", theme), (current) => hubRow(current, name));
  await tap(device, hubRow(target, name));
}

/** What each surface shows once it is ready. */
const SURFACES: { name: string; open: (target: Page, origin: string, theme: Theme) => Promise<void> }[] = [
  { name: "trust-rules", open: (target, origin, theme) => openTrust(target, origin, theme, "rules") },
  { name: "trust-guardrails", open: (target, origin, theme) => openTrust(target, origin, theme, "guardrails") },
  { name: "trust-audit", open: (target, origin, theme) => openTrust(target, origin, theme, "audit") },
  {
    name: "trust-guardrails-full",
    open: (target, origin) =>
      openAt(target, `${origin}/guardrails?lang=es`, (current) =>
        current.getByRole("heading", { name: t("trust.guardrails.meter"), exact: true }),
      ),
  },
  {
    name: "billing",
    open: (target, origin, theme) =>
      openAt(target, harness(origin, "billing", theme), (current) =>
        current.getByText("Office server", { exact: true }),
      ),
  },
  {
    name: "billing-dialog",
    open: (target, origin, theme) =>
      openAt(target, harness(origin, "billing-dialog", theme), (current) =>
        current.getByRole("dialog").getByText("Office server", { exact: true }),
      ),
  },
  {
    name: "connectors",
    open: (target, origin, theme) =>
      openAt(target, harness(origin, "connectors", theme), (current) => hubRow(current, "GitHub")),
  },
  {
    name: "connectors-github",
    open: async (target, origin, theme) => {
      await openConnector(target, origin, theme, "GitHub");
      await target.getByText("@panaderia-luna").first().waitFor({ timeout: UI_WAIT_MS });
    },
  },
  {
    name: "connectors-github-disconnect",
    open: async (target, origin, theme) => {
      await openConnector(target, origin, theme, "GitHub");
      await target
        .getByRole("button", { name: t("connector.github.disconnect"), exact: true })
        .first()
        .click();
      await target.getByRole("heading", { name: t("connector.github.disconnectConfirmTitle") }).waitFor({
        timeout: UI_WAIT_MS,
      });
    },
  },
  {
    name: "connectors-bitwarden",
    open: async (target, origin, theme) => {
      await openConnector(target, origin, theme, "Bitwarden");
      await target
        .getByRole("heading", { name: t("connector.bitwarden.connect") })
        .first()
        .waitFor({
          timeout: UI_WAIT_MS,
        });
    },
  },
  {
    name: "github-connect",
    open: (target, origin, theme) =>
      openAt(target, harness(origin, "github-connect", theme), (current) =>
        current.getByRole("dialog").getByText(t("connector.github.pendingTitle")),
      ),
  },
  {
    name: "bitwarden-host",
    open: (target, origin, theme) =>
      openAt(target, harness(origin, "bitwarden-host", theme), (current) =>
        current.getByText(t("connector.bitwarden.clientId"), { exact: true }),
      ),
  },
  {
    name: "mcp-key",
    open: (target, origin, theme) =>
      openAt(target, harness(origin, "mcp-key", theme), (current) =>
        current.getByRole("dialog", { name: t("mcp.connect.title", { name: "Figma" }) }),
      ),
  },
  {
    name: "mcp-local",
    open: (target, origin, theme) =>
      openAt(target, harness(origin, "mcp-local", theme), (current) =>
        current.getByRole("dialog", { name: t("mcp.connect.title", { name: "Figma" }) }),
      ),
  },
  {
    name: "mcp-sign-in",
    open: (target, origin, theme) =>
      openAt(target, harness(origin, "mcp-sign-in", theme), (current) =>
        current.getByRole("dialog", { name: t("mcp.connect.title", { name: "Figma" }) }),
      ),
  },
  {
    name: "chat-apps",
    open: (target, origin, theme) =>
      openAt(target, harness(origin, "chat-apps", theme), (current) =>
        current.getByRole("dialog", { name: t("mcp.chat.title") }),
      ),
  },
];

/** The surface, one screen at a time: its tallest scrolling box, from the top to the end. */
async function surfaceShots(target: Page, dir: string, name: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await target.waitForLoadState("networkidle", { timeout: UI_WAIT_MS }).catch(() => undefined);
  await target.waitForTimeout(600);
  for (let index = 1; index <= 8; index += 1) {
    const file = resolve(dir, `${name}-${index}.png`);
    await target.screenshot({ path: file, animations: "disabled" });
    report.screenshots.push(file);
    const more = await target.evaluate(() => {
      const boxes = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
        if (element.scrollHeight <= element.clientHeight + 4 || element.clientHeight < 120) return false;
        const overflow = getComputedStyle(element).overflowY;
        return overflow === "auto" || overflow === "scroll";
      });
      // The box of an open dialog first, then the tallest one.
      const dialog = boxes.filter((element) => element.closest("[role=dialog], [role=alertdialog]"));
      const box = (dialog.length > 0 ? dialog : boxes).sort((a, b) => b.clientHeight - a.clientHeight)[0];
      if (!box) return false;
      const before = box.scrollTop;
      box.scrollTop = before + box.clientHeight * 0.85;
      return box.scrollTop > before;
    });
    if (!more) return;
    await target.waitForTimeout(200);
  }
}

/** The page is no wider than the screen: nothing sits off to the right. */
async function noSideScroll(target: Page): Promise<void> {
  const width = await target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(width <= 1, `The page is ${width} px wider than the screen.`);
}

async function checks(target: Page, origin: string, device: Device): Promise<void> {
  await step(target, device, "Trust: every group of the rules shows under its title", async () => {
    await openTrust(target, origin, "dark", "rules");
    for (const title of [
      t("trust.roles"),
      t("trust.roles.leadGroup"),
      t("trust.roles.memberGroup"),
      t("trust.approverColumn"),
      t("trust.sandbox"),
      t("trust.budgets"),
      t("trust.overrides"),
    ])
      await target.getByRole("heading", { name: title, exact: true }).first().waitFor({ timeout: UI_WAIT_MS });
    await noSideScroll(target);
  });

  await step(target, device, "Trust: a switch goes through the save bar, and Reset puts it back", async () => {
    const label = t("trust.sandbox.ads");
    const toggle = target.getByRole("switch", { name: label });
    await toggle.waitFor({ state: "attached", timeout: UI_WAIT_MS });
    const before = await toggle.isChecked();
    const row = target.locator("label", { hasText: label }).first();
    await row.scrollIntoViewIfNeeded();
    await tap(device, row);
    assert.equal(await toggle.isChecked(), !before, "The row's label did not turn the switch.");
    const bar = target.getByRole("region", { name: t("trust.unsaved") });
    await bar.waitFor({ timeout: UI_WAIT_MS });
    assert.doesNotMatch(await calls(target, "viewsCalls"), /trustSave/u, "The switch saved before Save.");
    await tap(device, bar.getByRole("button", { name: t("server.settings.reset"), exact: true }));
    await bar.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await toggle.isChecked(), before, "Reset did not put the switch back.");
    await tap(device, row);
    await bar.waitFor({ timeout: UI_WAIT_MS });
    await tap(device, bar.getByRole("button", { name: t("common.save"), exact: true }));
    await bar.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    const saved = (await calls(target, "viewsCalls")).split("\n").find((line) => line.startsWith("trustSave:")) ?? "";
    assert.match(saved, new RegExp(`"ads":${!before}`, "u"));
  });

  await step(target, device, "Trust: the guardrails show on groups and keep their save bar", async () => {
    await openTrust(target, origin, "dark", "guardrails");
    for (const title of [t("trust.guardrails.week"), t("trust.guardrails.paused"), t("trust.guardrails.limits")])
      await target.getByRole("heading", { name: title, exact: true }).first().waitFor({ timeout: UI_WAIT_MS });
    const toggle = target.getByRole("switch", { name: t("trust.guardrails.injection") });
    await toggle.waitFor({ state: "attached", timeout: UI_WAIT_MS });
    const row = target.locator("label", { hasText: t("trust.guardrails.injection") }).first();
    await row.scrollIntoViewIfNeeded();
    await tap(device, row);
    const bar = target.getByRole("region", { name: t("trust.unsaved") });
    await bar.waitFor({ timeout: UI_WAIT_MS });
    await tap(device, bar.getByRole("button", { name: t("common.save"), exact: true }));
    await bar.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.match(await calls(target, "viewsCalls"), /guardrailsSave:.*"injection":\{"enabled":false\}/u);
    await noSideScroll(target);
  });

  await step(target, device, "Trust: the audit opens an agent's chat from a real button", async () => {
    await openTrust(target, origin, "dark", "audit");
    const open = target.getByRole("button", { name: t("trust.audit.openChat"), exact: true }).first();
    await open.waitFor({ timeout: UI_WAIT_MS });
    await noSideScroll(target);
  });

  await step(target, device, "Billing: the license and the server plans show as groups", async () => {
    await openAt(target, harness(origin, "billing", "dark"), (current) =>
      current.getByText("Office server", { exact: true }),
    );
    await target.getByRole("heading", { name: t("billing.servers.title"), exact: true }).waitFor();
    // Each plan is a row with its menu, named after the server.
    await target.getByRole("button", { name: t("billing.action.menu", { server: "Lab" }) }).waitFor();
    await noSideScroll(target);
  });

  await step(target, device, "Billing: cancelling a renewal asks first, and Cancel changes nothing", async () => {
    const cancel = target.getByRole("button", { name: t("billing.lifecycle.cancelRenewal"), exact: true }).first();
    await cancel.scrollIntoViewIfNeeded();
    await tap(device, cancel);
    const dialog = target.getByRole("alertdialog");
    await dialog.waitFor({ timeout: UI_WAIT_MS });
    await tap(device, dialog.getByRole("button", { name: t("common.cancel"), exact: true }));
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.doesNotMatch(await calls(target, "harnessCalls"), /lifecycle:/u);
  });

  await step(target, device, "Billing: the web dialog is the shared form dialog and closes", async () => {
    await openAt(target, harness(origin, "billing-dialog", "dark"), (current) =>
      current.getByRole("dialog", { name: t("billing.title") }),
    );
    const dialog = target.getByRole("dialog", { name: t("billing.title") });
    await dialog.getByText("Office server", { exact: true }).waitFor({ timeout: UI_WAIT_MS });
    await noSideScroll(target);
    await tap(device, dialog.getByRole("button", { name: t("common.close"), exact: true }).first());
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });

  await step(target, device, "Connectors: disconnecting GitHub asks first", async () => {
    await openConnector(target, origin, "dark", "GitHub", device);
    await target.getByRole("heading", { name: t("connector.github.repositoriesTitle"), exact: true }).waitFor();
    await target.getByText("panaderia-luna/", { exact: false }).first().waitFor();
    await noSideScroll(target);
    const disconnect = target.getByRole("button", { name: t("connector.github.disconnect"), exact: true }).first();
    await disconnect.scrollIntoViewIfNeeded();
    await tap(device, disconnect);
    const dialog = target.getByRole("alertdialog", { name: t("connector.github.disconnectConfirmTitle") });
    await dialog.waitFor({ timeout: UI_WAIT_MS });
    await tap(device, dialog.getByRole("button", { name: t("connector.github.keepConnected"), exact: true }));
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.doesNotMatch(await calls(target, "harnessCalls"), /github:disconnect/u);
    await tap(device, disconnect);
    await dialog.waitFor({ timeout: UI_WAIT_MS });
    await tap(device, dialog.getByRole("button", { name: t("connector.github.disconnect"), exact: true }));
    await target.waitForFunction(() => (document.body.dataset.harnessCalls ?? "").includes("github:disconnect"));
  });

  await step(target, device, "Connectors: a joined server's Bitwarden form names every field", async () => {
    await openAt(target, harness(origin, "bitwarden-host", "dark"), (current) =>
      current.getByText(t("connector.bitwarden.clientId"), { exact: true }),
    );
    for (const label of [
      t("connector.bitwarden.serverUrl"),
      t("connector.bitwarden.clientId"),
      t("connector.bitwarden.clientSecret"),
      t("connector.bitwarden.masterPassword"),
    ])
      await target.getByLabel(label, { exact: true }).waitFor();
    await target.getByLabel(t("connector.bitwarden.clientId"), { exact: true }).fill("user.1234");
    await target.getByLabel(t("connector.bitwarden.clientSecret"), { exact: true }).fill("secreto");
    await target.getByLabel(t("connector.bitwarden.masterPassword"), { exact: true }).fill("contraseña");
    await tap(device, target.getByRole("button", { name: t("connector.bitwarden.connect"), exact: true }));
    await target.waitForFunction(() => (document.body.dataset.harnessCalls ?? "").includes("bitwarden:host:"));
    await noSideScroll(target);
  });

  await step(target, device, "MCP: the key dialog keeps the key and says why it failed", async () => {
    await openAt(target, harness(origin, "mcp-key", "dark"), (current) =>
      current.getByRole("dialog", { name: t("mcp.connect.title", { name: "Figma" }) }),
    );
    const dialog = target.getByRole("dialog", { name: t("mcp.connect.title", { name: "Figma" }) });
    const key = dialog.locator("input[type=password]").first();
    await key.fill("clave-mala");
    await key.press("Enter");
    await dialog.getByText("Figma no aceptó la clave.").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await key.inputValue(), "clave-mala");
    await noSideScroll(target);
    await tap(device, dialog.getByRole("button", { name: t("common.cancel"), exact: true }));
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.match(await calls(target, "harnessCalls"), /mcp:cancel/u);
  });

  await step(target, device, "MCP: the chat apps dialog changes an app's access", async () => {
    await openAt(target, harness(origin, "chat-apps", "dark"), (current) =>
      current.getByRole("dialog", { name: t("mcp.chat.title") }),
    );
    const dialog = target.getByRole("dialog", { name: t("mcp.chat.title") });
    await dialog.getByLabel("Linear", { exact: true }).selectOption("write");
    assert.match(await calls(target, "harnessCalls"), /chat:linear:write/u);
    await tap(device, dialog.getByRole("button", { name: t("common.save"), exact: true }));
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  // A cache of its own: the deploy suite runs several scripts at once.
  cacheDir: "node_modules/.vite-e2e/trust-billing-settings-e2e",
  appType: "custom",
  logLevel: "error",
  plugins: [harnessPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: [
      "src/renderer/stories/views-harness.tsx",
      "src/renderer/stories/trust-guardrails-harness.tsx",
      "src/renderer/stories/trust-billing-harness.tsx",
    ],
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
  const created = await context.newPage();
  created.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  return created;
}

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  const context = (device: Device, theme: Theme) =>
    device === "desktop"
      ? browser?.newContext({ viewport: { width: 1440, height: 900 }, locale: "es", colorScheme: theme })
      : browser?.newContext({
          ...iphone,
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          isMobile: true,
          locale: "es",
          colorScheme: theme,
        });

  const shots = option("shots");
  const only = option("only")?.split(",");
  if (shots) {
    const devices = option("devices")?.split(",") ?? ["desktop", "phone"];
    for (const device of ["desktop", "phone"] as const) {
      if (!devices.includes(device)) continue;
      for (const theme of ["dark", "light"] as const) {
        const created = await context(device, theme);
        assert.ok(created, "No browser.");
        const target = await newPage(created);
        for (const surface of SURFACES) {
          if (only && !only.includes(surface.name)) continue;
          await step(target, device, `screenshots ${surface.name} ${theme}`, async () => {
            await surface.open(target, origin, theme);
            await surfaceShots(
              target,
              resolve(SHOTS, shots, device === "desktop" ? "1440" : "390"),
              `${surface.name}-${theme}`,
            );
          });
        }
        await created.close();
      }
    }
  }

  if (!process.argv.includes("--shots-only")) {
    for (const device of ["desktop", "phone"] as const) {
      const created = await context(device, "dark");
      assert.ok(created, "No browser.");
      await checks(await newPage(created), origin, device);
      await created.close();
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
