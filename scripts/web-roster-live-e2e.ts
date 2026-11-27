// Checks that the web client shows each change of an agent at once, with no page reload, on a
// computer and on a phone. It serves `src/renderer/stories/web-client-roster-harness.tsx`: a mock
// host with more than 100 agents, most of them made by another agent, whose roster events take the
// real wire (`agent-roster-changed` of `agent-roster-v1.ts`, encoded as the host encodes it for a
// fork peer, relayed and decoded as the client's peer decodes it). The frozen `bots-changed` event
// cannot carry that roster, so before the fix no change reached an open page.
// (a) A teammate that another agent makes shows with its name, with no reload.
// (b) An agent that the client hears of before its roster event (a lost event) shows with its name:
//     the client reads the roster for an agent id it does not know.
// (c) A model chosen in the DM header's picker shows in the picker and in the Agent settings panel
//     at once, and stays after the host's answer and the roster event.
// (d) A model change made on the host (an operator route, the agent's own `update_profile`) shows
//     in the open page.
// (e) A rename made on the host and the asleep switch show in the open page.
//
// `bun scripts/web-roster-live-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/web-roster-live-e2e/report.json and a screenshot of each viewport.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContextOptions, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("web-roster-live-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-roster-live-e2e");
const UI_WAIT_MS = 60_000;
const CHANGE_WAIT_MS = 5_000;
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
    <script type="module" src="/src/renderer/stories/web-client-roster-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-web-roster-harness",
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
  viewport: string;
  name: string;
  passed: boolean;
  detail?: string;
}

const report: {
  steps: Step[];
  pageErrors: string[];
  consoleErrors: string[];
  screenshots: string[];
  passed: boolean;
} = { steps: [], pageErrors: [], consoleErrors: [], screenshots: [], passed: false };

interface RosterControls {
  rosterEvents(): number;
  createByAgent(name: string): Promise<string>;
  createUnannounced(name: string): Promise<string>;
  turnStarted(agentId: string): void;
  hostUpdate(agentId: string, update: { name?: string; model?: string; title?: string }): Promise<unknown>;
  setAsleep(agentId: string, asleep: boolean): Promise<void>;
}

declare global {
  interface Window {
    /** The harness's controls of the mock host. */
    __roster?: RosterControls;
    /** Set once the page has loaded: a reload drops it. */
    __loaded?: boolean;
  }
}

async function step(page: Page, viewport: string, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ viewport, name, passed: true });
  } catch (error) {
    const shown = await page
      .evaluate(() =>
        [
          (document.querySelector(".web-app")?.textContent ?? "").replace(/\s+/gu, " ").slice(0, 600),
          [
            ...document.querySelectorAll(
              "[role=listbox] button, [role=option], header button, .conversation-panel button, aside button",
            ),
          ]
            .map((element) => element.getAttribute("aria-label") ?? element.textContent)
            .slice(0, 60)
            .join(" | "),
        ].join("\nOptions: "),
      )
      .catch((reason: unknown) => String(reason));
    report.steps.push({ viewport, name, passed: false, detail: `${String(error).slice(0, 600)}\nPage: ${shown}` });
    const shot = resolve(OUT, `${viewport}-${report.steps.length}-failed.png`);
    await page.screenshot({ path: shot }).catch(() => undefined);
    report.screenshots.push(shot);
    throw error;
  }
}

const modelName = (id: string) =>
  ({ "gpt-5.6-luna": "GPT-5.6 Luna", "gpt-5.6-terra": "GPT-5.6 Terra", "gpt-5.6-sol": "GPT-5.6 Sol" })[id] ?? id;

/** The model picker in the DM header. Its name holds the model it shows. */
const headerPicker = (page: Page) =>
  page
    .locator(".conversation-header")
    .getByRole("button", { name: new RegExp(`^${english("provider.picker.agentModel")}: `, "u") })
    .first();
/** The model picker of the Agent settings panel. */
const settingsPicker = (page: Page) =>
  page
    .locator(".settings-panel")
    .getByRole("button", { name: new RegExp(`^${english("agentSettings.runtime.model")}: `, "u") })
    .first();

async function waitForLabel(page: Page, picker: ReturnType<typeof headerPicker>, text: string): Promise<void> {
  const deadline = Date.now() + CHANGE_WAIT_MS;
  let label = "";
  while (Date.now() < deadline) {
    label = (await picker.getAttribute("aria-label").catch(() => null)) ?? "";
    if (label.includes(text)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`The picker shows "${label}", not ${text}.`);
}

/** Whether a text shows in the page, in the agent lists or in a header. */
async function waitForText(page: Page, text: string): Promise<void> {
  await page.waitForFunction((value) => document.body.innerText.includes(value), text, { timeout: CHANGE_WAIT_MS });
}

async function run(browser: Browser, viewport: string, contextOptions: BrowserContextOptions): Promise<void> {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(`${viewport}: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource") &&
      !message.text().startsWith("[vite]")
    )
      report.consoleErrors.push(`${viewport}: ${message.text().slice(0, 1_000)}`);
  });
  const phone = viewport === "phone";
  // A mark on the page's window: a reload drops it.
  const stillLoaded = async () => assert.equal(await page.evaluate(() => window.__loaded), true, "The page reloaded.");

  await step(page, viewport, "the owner's DM with Chief opens", async () => {
    await page.goto(`${origin}/app/general/dm/chief`, COMMIT);
    await headerPicker(page).waitFor({ timeout: UI_WAIT_MS });
    await waitForLabel(page, headerPicker(page), modelName("gpt-5.6-luna"));
    await page.evaluate(() => {
      window.__loaded = true;
    });
  });

  // (a) On a phone the DM covers the lists, so the check reads the Chat tab after Back.
  const showLists = async () => {
    if (!phone) return;
    await page.evaluate(() => history.back());
    await page
      .getByRole("navigation", { name: english("workspace.phone.tabs") })
      .getByRole("button", { name: new RegExp(`^${english("workspace.phone.chat")}`, "u") })
      .tap();
  };
  const reopenChief = async () => {
    await page.getByText("Chief", { exact: true }).first().tap();
    await headerPicker(page).waitFor({ timeout: UI_WAIT_MS });
  };

  await step(page, viewport, "a teammate that another agent makes shows with its name", async () => {
    const before = await page.evaluate(() => window.__roster?.rosterEvents() ?? 0);
    await page.evaluate(() => window.__roster?.createByAgent("Fichador Nuevo"));
    const after = await page.evaluate(() => window.__roster?.rosterEvents() ?? 0);
    assert.ok(after > before, "The host sent no roster event.");
    await showLists();
    await waitForText(page, "Fichador Nuevo");
  });

  await step(page, viewport, "an agent heard of before its roster event shows with its name", async () => {
    const id = await page.evaluate(() => window.__roster?.createUnannounced("Ayudante Silencioso"));
    await page.evaluate((agentId) => window.__roster?.turnStarted(agentId ?? ""), id);
    await waitForText(page, "Ayudante Silencioso");
  });
  await page.screenshot({ path: resolve(OUT, `${viewport}-lists.png`) });
  report.screenshots.push(resolve(OUT, `${viewport}-lists.png`));
  await stillLoaded();
  if (phone) {
    // The DM again, as a tap on its row opens it.
    await reopenChief();
    await page.evaluate(() => {
      window.__loaded = true;
    });
  }

  await step(page, viewport, "the header picker shows the chosen model, and so does the settings panel", async () => {
    await headerPicker(page).click();
    await page
      .locator(`[role=listbox] [aria-label="${modelName("gpt-5.6-terra")}"]`)
      .first()
      .click();
    await waitForLabel(page, headerPicker(page), modelName("gpt-5.6-terra"));
    await page.keyboard.press("Escape");
    // The side panel's launcher opens Agent settings, as `web-side-panel-e2e.ts` does.
    // A phone's header keeps the model and More, and More's sheet opens the panel.
    if (phone) {
      await page
        .locator(`button[aria-label="${english("workspace.message.more")}"]:visible`)
        .first()
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: english("conversation.sidePanel.open") })
        .click();
    } else
      await page
        .locator(`button[aria-label="${english("conversation.sidePanel.open")}"]:visible`)
        .first()
        .click();
    await page
      .getByRole("button", {
        name: english("conversation.sidePanel.openPane", { name: english("conversation.sidePanel.pane.settings") }),
        exact: true,
      })
      .first()
      .click();
    await settingsPicker(page).waitFor({ timeout: UI_WAIT_MS });
    await waitForLabel(page, settingsPicker(page), modelName("gpt-5.6-terra"));
    // The host's answer and its roster event came: the picker keeps the choice.
    await page.waitForTimeout(1_000);
    await waitForLabel(page, headerPicker(page), modelName("gpt-5.6-terra"));
  });

  await step(page, viewport, "a model change made on the host shows in the open page", async () => {
    await page.evaluate(() => window.__roster?.hostUpdate("chief", { model: "gpt-5.6-sol" }));
    await waitForLabel(page, headerPicker(page), modelName("gpt-5.6-sol"));
    await waitForLabel(page, settingsPicker(page), modelName("gpt-5.6-sol"));
  });

  await step(page, viewport, "a rename made on the host shows in the open page", async () => {
    await page.evaluate(() => window.__roster?.hostUpdate("chief", { name: "Jefa" }));
    await waitForText(page, "Jefa");
  });

  await step(page, viewport, "the asleep switch shows in the open page", async () => {
    // A generated avatar marks the mood, a face its state.
    const ASLEEP = '[data-mood="asleep"], [data-state="sleeping"]';
    const before = await page.locator(ASLEEP).count();
    await page.evaluate(() => window.__roster?.setAsleep("chief", true));
    await page.waitForFunction(
      ([selector, count]) => document.querySelectorAll(selector).length > count,
      [ASLEEP, before] as const,
      { timeout: CHANGE_WAIT_MS },
    );
    await page.evaluate(() => window.__roster?.setAsleep("chief", false));
    await page.waitForFunction(
      ([selector, count]) => document.querySelectorAll(selector).length <= count,
      [ASLEEP, before] as const,
      { timeout: CHANGE_WAIT_MS },
    );
  });
  await stillLoaded();
  await page.screenshot({ path: resolve(OUT, `${viewport}-dm.png`) });
  report.screenshots.push(resolve(OUT, `${viewport}-dm.png`));
  await context.close();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  cacheDir: "node_modules/.vite-e2e/web-roster-live-e2e",
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: ["src/renderer/stories/web-client-roster-harness.tsx"],
    include: ["@norbert_bodziony/bloub"],
  },
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
  await run(browser, "desktop", { viewport: { width: 1440, height: 900 } });
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  await run(browser, "phone", { ...iphone, hasTouch: true, isMobile: true });
  assert.deepEqual(report.pageErrors, [], "The page threw.");
  report.passed = report.steps.every((entry) => entry.passed);
} catch (error) {
  logger.error("The roster check failed:", error);
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
  for (const entry of report.steps) logger.info(`${entry.passed ? "PASS" : "FAIL"} ${entry.viewport}: ${entry.name}`);
  if (!report.passed) process.exitCode = 1;
}
