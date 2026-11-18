// Walks the create flows of the workspace on a computer and on an iPhone: New agent, New channel with
// its people, Add members, New message and New space, and the Slack sidebar (More, collapsed groups). Each one must open the shared FormDialog (a
// dialog on a computer, a sheet on a phone), keep a failure inside it, close on Cancel
// and Escape, and open what it made. It serves the web client on a mock host (the "Spaces workspace"
// story, `src/renderer/stories/web-client-harness.tsx`) and drives it in Chromium. No account
// service, host or provider is needed.
//
// `bun scripts/ux-creation-flows-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/ux-creation-flows-e2e/report.json and a screenshot of each dialog.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("ux-creation-flows-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/ux-creation-flows-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");
const COMMIT = { waitUntil: "commit" } as const;

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;
const VIEWPORT_NAMES: readonly ViewportName[] = ["desktop", "phone"];

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
    name: "openbot-ux-creation-flows-harness",
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
  viewport: ViewportName;
  name: string;
  passed: boolean;
  detail?: string;
}

const report: {
  steps: Step[];
  dialogs: { viewport: ViewportName; flow: string; width: number; height: number; sheet: boolean }[];
  pageErrors: string[];
  consoleErrors: string[];
  screenshots: string[];
  passed: boolean;
} = { steps: [], dialogs: [], pageErrors: [], consoleErrors: [], screenshots: [], passed: false };

async function step(page: Page, viewport: ViewportName, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ viewport, name, passed: true });
  } catch (error) {
    report.steps.push({ viewport, name, passed: false, detail: String(error).slice(0, 600) });
    const shot = resolve(OUT, `${viewport}-${report.steps.length}-failed.png`);
    await page.screenshot({ path: shot }).catch(() => undefined);
    report.screenshots.push(shot);
    throw error;
  }
}

async function shot(page: Page, label: string): Promise<void> {
  const file = resolve(OUT, `${label}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(file);
}

/** The open form dialog: a phone shows it as a sheet, a computer as a centred dialog. */
async function checkFrame(page: Page, viewport: ViewportName, flow: string, dialog: Locator): Promise<void> {
  await dialog.waitFor({ timeout: UI_WAIT_MS });
  // The sheet rises from the bottom edge: measure it where it stops.
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const box = await dialog.boundingBox();
  assert.ok(box, `${flow}: the dialog has no box`);
  const size = page.viewportSize();
  assert.ok(size);
  // A phone shows the sheet: the full width, down to the bottom edge, and nearly the full height.
  const sheet = box.width >= size.width - 1 && box.y + box.height >= size.height - 1 && box.height >= size.height * 0.9;
  report.dialogs.push({ viewport, flow, width: Math.round(box.width), height: Math.round(box.height), sheet });
  assert.equal(sheet, viewport === "phone", `${flow}: a sheet should show ${viewport === "phone"}`);
  // One frame: a close button in the header, the primary action in the footer.
  await dialog.getByRole("button", { name: english("common.close"), exact: true }).waitFor();
  await shot(page, `${viewport}-${flow}`);
}

const dialogNamed = (page: Page, name: string) => page.getByRole("dialog", { name, exact: true });

/** On a phone the workspace shows one pane: Back shows the sidebar. */
async function showSidebar(page: Page, viewport: ViewportName): Promise<void> {
  if (viewport !== "phone") return;
  const back = page.getByRole("button", { name: english("workspace.layout.back"), exact: true }).first();
  if (await back.isVisible()) await back.click();
}

async function waitForPath(page: Page, test: (path: string) => boolean, label: string): Promise<void> {
  await page
    .waitForURL((url) => test(url.pathname), { timeout: UI_WAIT_MS, waitUntil: "commit" })
    .catch(() => assert.fail(`${label}: the address stayed ${new URL(page.url()).pathname}`));
}

async function walk(browser: Browser, origin: string, viewport: ViewportName): Promise<void> {
  const context = await browser.newContext(VIEWPORTS[viewport]);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(`${viewport}: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    // The dev server's own socket is no part of the client: a page left during a step drops it.
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource") &&
      !message.text().startsWith("[vite]")
    )
      report.consoleErrors.push(`${viewport}: ${message.text().slice(0, 1_000)}`);
  });
  const suffix = viewport === "phone" ? "p" : "d";

  await step(page, viewport, "the workspace loads", async () => {
    await page.goto(`${origin}/app/general/activity`, COMMIT);
    await page
      .getByRole("heading", { name: english("workspace.view.activity"), exact: true })
      .waitFor({ timeout: UI_WAIT_MS });
  });

  // 1. New agent: the sidebar row opens the dialog; Escape closes it; Create opens the agent's chat.
  const agentName = `Scout ${suffix}`;
  await step(page, viewport, "New agent opens the form dialog, and Escape closes it", async () => {
    await showSidebar(page, viewport);
    await page.getByRole("button", { name: english("workspace.sidebar.addAgent"), exact: true }).click();
    const dialog = dialogNamed(page, english("agent.setup.titleAdditional"));
    await checkFrame(page, viewport, "new-agent", dialog);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });
  await step(page, viewport, "New agent creates the agent and opens its chat", async () => {
    await showSidebar(page, viewport);
    await page.getByRole("button", { name: english("workspace.sidebar.addAgent"), exact: true }).click();
    const dialog = dialogNamed(page, english("agent.setup.titleAdditional"));
    await dialog.waitFor({ timeout: UI_WAIT_MS });
    await dialog.getByRole("textbox", { name: english("agent.setup.name") }).fill(agentName);
    await dialog.getByRole("button", { name: english("agent.setup.create"), exact: true }).click();
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await waitForPath(page, (path) => path.includes("/dm/"), "new agent chat");
  });

  // 2. New channel: two steps in the same frame; the second adds a person with Enter in the search.
  const channelName = `launch-${suffix}`;
  await step(page, viewport, "New channel: details, then people, then the channel opens", async () => {
    await showSidebar(page, viewport);
    await page.getByRole("button", { name: english("workspace.sidebar.addChannels"), exact: true }).click();
    const browse = dialogNamed(page, english("workspace.app.browse.title"));
    await browse.waitFor({ timeout: UI_WAIT_MS });
    await browse.getByRole("button", { name: english("workspace.app.browse.create"), exact: true }).click();
    const details = dialogNamed(page, english("workspace.create.title"));
    await checkFrame(page, viewport, "new-channel", details);
    const next = details.getByRole("button", { name: english("common.next"), exact: true });
    assert.equal(await next.isDisabled(), true, "Next is off without a name");
    await details.getByRole("textbox", { name: english("workspace.create.name") }).fill(channelName);
    await next.click();
    const people = dialogNamed(page, english("workspace.create.addTitle", { name: channelName }));
    await people.waitFor({ timeout: UI_WAIT_MS });
    const search = people.getByRole("textbox", { name: english("workspace.create.addLabel") });
    await search.fill("Chief");
    await search.press("Enter");
    await people
      .getByRole("button", { name: english("workspace.picker.remove", { name: "Chief" }), exact: true })
      .waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-new-channel-people`);
    await people.getByRole("button", { name: english("workspace.create.create"), exact: true }).click();
    await people.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await waitForPath(page, (path) => path.includes("/c/"), "new channel");
    await page.getByRole("region", { name: channelName, exact: true }).first().waitFor({ timeout: UI_WAIT_MS });
  });

  // 3. Add members from the new channel's intro.
  await step(page, viewport, "Add members adds a person to the channel", async () => {
    await page
      .getByRole("button", { name: english("workspace.app.channel.addPeople"), exact: true })
      .first()
      .click();
    const dialog = dialogNamed(page, english("workspace.app.invite.title", { name: channelName }));
    await checkFrame(page, viewport, "add-members", dialog);
    const add = dialog.getByRole("button", { name: english("workspace.app.invite.add"), exact: true });
    assert.equal(await add.isDisabled(), true, "Add members is off with nobody picked");
    const search = dialog.getByRole("textbox", { name: english("workspace.app.invite.label") });
    await search.fill("Sales");
    await search.press("Enter");
    await add.click();
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });

  // 3b. Delete the channel from its details: a confirm that Cancel keeps, then the channel goes.
  await step(page, viewport, "Delete channel asks first, then deletes it", async () => {
    await page
      .getByRole("button", { name: english("workspace.header.details"), exact: true })
      .first()
      .click();
    await page.getByRole("tab", { name: english("workspace.details.settings"), exact: true }).click();
    const remove = page.getByRole("button", { name: english("workspace.details.archive"), exact: true });
    await remove.click();
    const confirm = page.getByRole("alertdialog", { name: english("sidebar.delete.title", { name: channelName }) });
    await confirm.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-delete-channel-confirm`);
    await confirm.getByRole("button", { name: english("common.cancel"), exact: true }).click();
    await confirm.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await remove.click();
    await confirm.getByRole("button", { name: english("sidebar.channelMenu.delete"), exact: true }).click();
    await confirm.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await waitForPath(page, (path) => path.endsWith("/activity"), "deleted channel");
  });

  // 4. New message: Cancel closes it; Start DM opens the conversation.
  await step(page, viewport, "New message: Cancel closes it, Start DM opens the DM", async () => {
    await showSidebar(page, viewport);
    const open = page.getByRole("button", { name: english("workspace.sidebar.newMessage"), exact: true }).first();
    await open.click();
    const dialog = dialogNamed(page, english("workspace.newMessage.title"));
    await checkFrame(page, viewport, "new-message", dialog);
    await dialog.getByRole("button", { name: english("common.cancel"), exact: true }).click();
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await showSidebar(page, viewport);
    await open.click();
    await dialog.waitFor({ timeout: UI_WAIT_MS });
    const search = dialog.getByRole("textbox", { name: english("workspace.newMessage.to") });
    await search.fill("Sales");
    await search.press("Enter");
    const before = new URL(page.url()).pathname;
    await dialog.getByRole("button", { name: english("workspace.newMessage.start"), exact: true }).click();
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    // The owner's DM with an agent is the agent's chat.
    await waitForPath(page, (path) => path !== before && /\/(c|dm)\//u.test(path), "new message");
  });

  // 5. The sidebar as in Slack: the other views are under More (a menu on a computer, the More tab on
  // a phone); a collapsed group keeps its open row and stays collapsed after a reload.
  await step(page, viewport, "More opens a view that is not a top row", async () => {
    await showSidebar(page, viewport);
    const sidebar = page.getByRole("navigation", { name: english("workspace.sidebar.label") });
    assert.equal(
      await sidebar.getByRole("button", { name: english("workspace.view.agents"), exact: true }).count(),
      0,
      "Between agents is not a top row",
    );
    if (viewport === "phone") {
      // The phone shell has no More row in the list: More is a tab of the bottom bar.
      await page
        .getByRole("navigation", { name: english("workspace.phone.tabs") })
        .getByRole("button", { name: english("workspace.phone.more"), exact: true })
        .click();
      await page.getByRole("button", { name: english("workspace.view.agents"), exact: true }).click();
    } else {
      await sidebar.getByRole("button", { name: english("workspace.sidebar.more"), exact: true }).click();
      await page.getByRole("menuitem", { name: english("workspace.view.agents") }).click();
    }
    await page
      .getByRole("heading", { name: english("workspace.view.agents"), exact: true })
      .waitFor({ timeout: UI_WAIT_MS });
  });
  if (viewport === "desktop")
    await step(page, viewport, "A collapsed group keeps the open channel and stays collapsed", async () => {
      const sidebar = page.getByRole("navigation", { name: english("workspace.sidebar.label") });
      const general = sidebar.getByRole("button", {
        name: new RegExp(`^${english("workspace.sidebar.publicChannel", { name: "general" })}`, "u"),
      });
      await general.first().click();
      const toggle = sidebar.getByRole("button", { name: english("workspace.sidebar.channels"), exact: true });
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await general.first().waitFor({ timeout: UI_WAIT_MS });
      assert.equal(
        await sidebar.getByRole("button", { name: english("workspace.sidebar.addChannels"), exact: true }).count(),
        0,
        "a collapsed group hides its add row",
      );
      await page.reload(COMMIT);
      const again = page
        .getByRole("navigation", { name: english("workspace.sidebar.label") })
        .getByRole("button", { name: english("workspace.sidebar.channels"), exact: true });
      await again.waitFor({ timeout: UI_WAIT_MS });
      await page.waitForFunction(
        (label) =>
          [...document.querySelectorAll("button[aria-expanded]")].some(
            (button) => button.textContent?.trim() === label && button.getAttribute("aria-expanded") === "false",
          ),
        english("workspace.sidebar.channels"),
        { timeout: UI_WAIT_MS },
      );
      await again.click();
    });

  // 6. A settings page has a visible way out: Close on a computer, Back on a phone.
  await step(page, viewport, "Settings closes with its own button", async () => {
    await page.goto(`${origin}/app/general/activity?page=settings`, COMMIT);
    const heading = page.getByRole("heading", { name: english("app.settingsPage.title") });
    await heading.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-settings`);
    const label = viewport === "phone" ? english("common.back") : english("common.close");
    await page.locator(".settings-page").getByRole("button", { name: label, exact: true }).click();
    await heading.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await waitForPath(page, (path) => path === "/app/general/activity", "settings closed");
  });

  // 7. New space from the rail (a computer) or the space switcher of Home (a phone): the new space opens.
  await step(page, viewport, "New space creates the space and shows it", async () => {
    if (viewport === "phone") {
      await showSidebar(page, viewport);
      await page
        .getByRole("navigation", { name: english("workspace.phone.tabs") })
        .getByRole("button", { name: english("workspace.phone.home"), exact: true })
        .click();
      await page.getByRole("button", { name: new RegExp(`^${english("workspace.phone.switch")}`, "u") }).click();
      await dialogNamed(page, english("workspace.phone.switch"))
        .getByRole("button", { name: english("workspace.spaces.create"), exact: true })
        .click();
    } else {
      await page.getByRole("button", { name: english("workspace.spaces.create"), exact: true }).click();
    }
    const dialog = dialogNamed(page, english("workspace.spaces.createTitle"));
    await checkFrame(page, viewport, "new-space", dialog);
    const create = dialog.getByRole("button", { name: english("workspace.spaces.createButton"), exact: true });
    assert.equal(await create.isDisabled(), true, "Create space is off without a name");
    await dialog.getByRole("textbox", { name: english("workspace.spaces.name") }).fill(`Ops ${suffix}`);
    await create.click();
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    // The new space shows: the address names it (its slug, or its id when the host gives no slug).
    await waitForPath(page, (path) => !path.startsWith("/app/general/"), "new space");
    // A computer shows it on the rail; a phone names it at the top of Home.
    await (viewport === "phone"
      ? page.getByText(`Ops ${suffix}`, { exact: true })
      : page.getByRole("button", { name: new RegExp(`^Ops ${suffix}`, "u") })
    )
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
  });

  await context.close();
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
  for (const viewport of VIEWPORT_NAMES) {
    try {
      await walk(browser, origin, viewport);
    } catch (error) {
      logger.warn(`${viewport}: ${String(error).slice(0, 300)}`);
    }
  }
  report.passed =
    report.steps.length > 0 &&
    report.steps.every((item) => item.passed) &&
    report.pageErrors.length === 0 &&
    report.consoleErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps. Report: ${resolve(OUT, "report.json")}`,
);
process.exit(report.passed ? 0 : 1);
