// Checks the ways into an agent's settings in the web client, on an iPhone and on a desktop: the
// gear of a Fleet card opens the settings of that agent, also the agent whose chat was open last.
// The New agent dialog of an Atelier theme offers faces and no color, which an Atelier face ignores.
// The Permissions page of an agent on a host offers no Computer Use switch, and its note does not
// point to one.
// It serves the web client on a mock host (`src/renderer/stories/web-client-harness.tsx`) at every
// address under `/app`, as the site does, and drives it in Chromium. No account service, host or
// provider is needed.
//
// `bun scripts/agent-settings-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/agent-settings-e2e/report.json, and a screenshot of a failed step.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("agent-settings-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/agent-settings-e2e");
const UI_WAIT_MS = 60_000;
// The dev server compiles the client on a page's first request. Beside the whole deploy suite that
// takes more than a minute, so a page load waits longer.
const LOAD_WAIT_MS = 180_000;
const english = translateFor("en");
const COMMIT = { waitUntil: "commit" } as const;

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
    <script type="module" src="/src/renderer/stories/web-client-harness.tsx"></script>
  </body>
</html>`;

/** Serves the harness page at `/app` and every address under it, as the site's `/app/$` route does. */
function webClientPages(): Plugin {
  return {
    name: "openbot-agent-settings-harness",
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
  device: string;
  url: string;
  passed: boolean;
  detail?: string;
}

const report: { steps: Step[]; pageErrors: string[]; screenshots: string[]; passed: boolean } = {
  steps: [],
  pageErrors: [],
  screenshots: [],
  passed: false,
};

async function step(page: Page, device: string, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ name, device, url: page.url(), passed: true });
  } catch (error) {
    report.steps.push({ name, device, url: page.url(), passed: false, detail: String(error).slice(0, 800) });
    const shot = resolve(OUT, `${report.steps.length}-${device}-failed.png`);
    await page.screenshot({ path: shot }).catch(() => undefined);
    report.screenshots.push(shot);
  }
}

/** The settings form of the open agent: its Name field holds the agent's name. */
async function settingsShowFor(page: Page, name: string): Promise<void> {
  const field = page.getByRole("textbox", { name: english("agentSettings.nameLabel"), exact: true }).first();
  await field.waitFor({ timeout: UI_WAIT_MS });
  assert.equal(await field.inputValue(), name);
}

const fleetSettings = (page: Page, name: string) =>
  page.getByRole("button", { name: english("workspace.fleet.settings", { name }), exact: true });

const tabBar = (page: Page) => page.getByRole("navigation", { name: english("workspace.phone.tabs") });

/** Fleet: the Agents tab on the phone, the Fleet address on the desktop. */
async function openFleet(page: Page, device: "phone" | "desktop"): Promise<void> {
  if (device === "desktop") {
    await page.goto(`${origin}/app/general/fleet`, COMMIT);
    return;
  }
  await page.goto(`${origin}/app/general`, COMMIT);
  const agents = tabBar(page).getByRole("button", { name: new RegExp(`^${english("workspace.phone.agents")}`, "u") });
  await agents.waitFor({ timeout: LOAD_WAIT_MS });
  await agents.tap();
}

async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
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
  optimizeDeps: { entries: ["src/renderer/stories/web-client-harness.tsx"], include: ["@norbert_bodziony/bloub"] },
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
  const phone = await browser.newContext({ ...iphone, hasTouch: true, isMobile: true });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // 1. Fleet's gear opens the agent's settings, also for the agent whose chat the shell has open.
  // The harness opens Chief's chat first, so Chief is that agent.
  for (const [device, context] of [
    ["phone", phone],
    ["desktop", desktop],
  ] as const) {
    const page = await newPage(context);
    await step(page, device, "Fleet's gear opens the settings of the agent whose chat was open", async () => {
      await openFleet(page, device);
      const gear = fleetSettings(page, "Chief");
      await gear.waitFor({ timeout: UI_WAIT_MS });
      await (device === "phone" ? gear.tap() : gear.click());
      await settingsShowFor(page, "Chief");
    });
    await step(page, device, "Fleet's gear opens the settings of another agent", async () => {
      await openFleet(page, device);
      const gear = fleetSettings(page, "Sales Outbound");
      await gear.waitFor({ timeout: UI_WAIT_MS });
      await (device === "phone" ? gear.tap() : gear.click());
      await settingsShowFor(page, "Sales Outbound");
    });
    await page.close();
  }

  // 2. New agent in an Atelier theme (the harness default): faces to pick, and no color picker.
  const page = await newPage(phone);
  await step(page, "phone", "New agent offers faces and no color in an Atelier theme", async () => {
    await openFleet(page, "phone");
    const add = page
      .getByRole("region", { name: english("workspace.view.fleet"), exact: true })
      .getByRole("button", { name: english("workspace.fleet.addAgent"), exact: true });
    await add.waitFor({ timeout: UI_WAIT_MS });
    await add.tap();
    const dialog = page.getByRole("dialog", { name: english("workspace.fleet.addAgent") });
    await dialog.getByRole("group", { name: english("agent.setup.face") }).waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await dialog.getByRole("group", { name: english("agent.setup.color") }).count(), 0);
  });
  await page.close();

  // 3. Permissions of a Workspace only agent on the host: the note names no switch that is not there.
  const permissions = await newPage(phone);
  await step(permissions, "phone", "Permissions does not point to a Computer Use switch it lacks", async () => {
    await openFleet(permissions, "phone");
    const gear = fleetSettings(permissions, "Sales Outbound");
    await gear.waitFor({ timeout: UI_WAIT_MS });
    await gear.tap();
    await settingsShowFor(permissions, "Sales Outbound");
    await permissions
      .getByRole("button", { name: new RegExp(`^${english("agentSettings.permissions.title")}`, "u") })
      .tap();
    const note = permissions.getByText(english("agentSettings.runtime.workspaceNote"), { exact: false });
    await note.waitFor({ timeout: UI_WAIT_MS });
    const text = (await note.textContent()) ?? "";
    assert.ok(text.includes(english("agentSettings.runtime.workspaceUnlimitedNoSwitch")), text);
    assert.ok(!text.includes(english("agentSettings.runtime.workspaceUnlimited")), text);
    assert.equal(
      await permissions.getByRole("switch", { name: english("agentSettings.computerUse.title") }).count(),
      0,
    );
  });
  await permissions.close();

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
