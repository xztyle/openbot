// Walks the Slack views of the workspace on a computer and on an iPhone: Unreads (mark one
// conversation read, Undo, Escape on a group, mark all), Threads (unread first, Mark all as read),
// Later (complete, the Completed tab, remove with Undo), the message search (the top bar field or
// the phone's field, a modifier, a result that opens the exact message), Jump to (unread first, a
// fuzzy name; with no name that matches, Enter searches), a result on an agent's step, accents in the
// Channels tab, a recent search run from its words, Ctrl+F in a DM, Browse channels (preview before
// joining) and the shortcuts sheet. It serves the web client on a mock host with unread messages
// (`src/renderer/stories/web-client-inbox-harness.tsx`) and drives it in Chromium. No account service, host or provider is needed.
//
// `bun scripts/workspace-inbox-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/workspace-inbox-e2e/report.json and a screenshot of each view.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("workspace-inbox-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/workspace-inbox-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");

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
    <script type="module" src="/src/renderer/stories/web-client-inbox-harness.tsx"></script>
  </body>
</html>`;

/** Serves the harness page at `/app` and every address under it, as the site's `/app/$` route does. */
function webClientPages(): Plugin {
  return {
    name: "openbot-workspace-inbox-harness",
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
  pageErrors: string[];
  consoleErrors: string[];
  screenshots: string[];
  passed: boolean;
} = { steps: [], pageErrors: [], consoleErrors: [], screenshots: [], passed: false };

async function step(page: Page, viewport: ViewportName, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ viewport, name, passed: true });
  } catch (error) {
    report.steps.push({ viewport, name, passed: false, detail: String(error).slice(0, 800) });
    const shot = resolve(OUT, `${viewport}-${report.steps.length}-failed.png`);
    await page.screenshot({ path: shot }).catch(() => undefined);
    report.screenshots.push(shot);
  }
}

async function shot(page: Page, label: string): Promise<void> {
  const file = resolve(OUT, `${label}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(file);
}

/**
 * Opens a view as the reader does: on a computer from the sidebar row; on a phone from the shortcut
 * chips of the Chat tab. The page is not loaded again, so the mock host keeps what
 * the walk changed.
 */
async function openView(page: Page, view: "unreads" | "threads" | "later" | "dms", title: string): Promise<void> {
  const back = page.getByRole("button", { name: english("workspace.layout.back"), exact: true }).first();
  if (await back.isVisible()) await back.click();
  const tabs = page.getByRole("navigation", { name: english("workspace.phone.tabs") });
  const phone = page.viewportSize()?.width === VIEWPORTS.phone.viewport.width;
  if (phone) await tabs.waitFor({ timeout: UI_WAIT_MS });
  if (phone) {
    await tabs.getByRole("button", { name: new RegExp(`^${english("workspace.phone.chat")}`, "u") }).click();
    await page
      .getByRole("list", { name: english("workspace.phone.shortcuts") })
      .getByRole("button", { name: new RegExp(`^${english(`workspace.view.${view}`)}`, "u") })
      .click();
  } else {
    const nav = page.getByRole("navigation", { name: english("workspace.sidebar.label") });
    if (view === "dms") {
      await nav.getByRole("button", { name: english("workspace.sidebar.more"), exact: true }).click();
      await page.getByRole("menuitem", { name: english("workspace.view.dms") }).click();
    } else
      await nav
        .getByRole("button", { name: english(`workspace.view.${view}`) })
        .first()
        .click();
  }
  await page.getByRole("heading", { name: title, exact: true }).first().waitFor({ timeout: UI_WAIT_MS });
}

/** The first load: Vite may still optimise the dependencies, so a blank page loads once more. */
async function load(page: Page, origin: string, path: string, title: string): Promise<void> {
  const heading = page.getByRole("heading", { name: title, exact: true }).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${origin}${path}`, { waitUntil: "commit" });
    if (
      await heading.waitFor({ timeout: UI_WAIT_MS / 2 }).then(
        () => true,
        () => false,
      )
    )
      return;
  }
  await heading.waitFor({ timeout: UI_WAIT_MS });
}

/** Runs a message search: the top bar's field on a computer, the search view's field on a phone. */
async function searchFor(page: Page, desktop: boolean, query: string) {
  if (desktop) {
    await page.keyboard.press("Control+g");
    await page.keyboard.press("Control+a");
    await page.keyboard.type(query);
    await page.keyboard.press("Enter");
  } else {
    const back = page.getByRole("button", { name: english("workspace.layout.back"), exact: true }).first();
    if (!(await page.locator(".ws-search").isVisible())) {
      while (await back.isVisible()) await back.click();
      await page
        .getByRole("navigation", { name: english("workspace.phone.tabs") })
        .getByRole("button", { name: new RegExp(`^${english("workspace.phone.chat")}`, "u") })
        .click();
      await page.getByRole("button", { name: english("workspace.app.menu.search"), exact: true }).click();
      await page.keyboard.type(query);
      await page.getByRole("option", { name: english("workspace.jump.searchMessages", { query }) }).click();
    } else {
      const field = page.getByRole("searchbox", { name: english("workspace.search.placeholder") });
      await field.fill(query);
      await field.press("Enter");
    }
  }
  const results = page.locator(".ws-search");
  await page
    .getByRole("heading", { name: english("workspace.view.search"), exact: true })
    .waitFor({ timeout: UI_WAIT_MS });
  return results;
}

const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

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
  const desktop = viewport === "desktop";

  await step(page, viewport, "the sidebar has Unreads, Threads, Activity, Later and Fleet at the top", async () => {
    await load(page, origin, "/app/general/activity", english("workspace.view.activity"));
    if (!desktop) return;
    const nav = page.getByRole("navigation", { name: english("workspace.sidebar.label") });
    for (const label of ["unreads", "threads", "activity", "later", "fleet"] as const)
      await nav
        .getByRole("button", { name: english(`workspace.view.${label}`) })
        .first()
        .waitFor();
  });

  // Unreads: one group per unread conversation; Mark as read folds it with Undo; Undo brings it back.
  await step(page, viewport, "Unreads lists #general and the DM with Ana, and marks one read with Undo", async () => {
    if (desktop) await page.keyboard.press("Control+Shift+A");
    else await openView(page, "unreads", english("workspace.view.unreads"));
    await page
      .getByRole("heading", { name: english("workspace.view.unreads"), exact: true })
      .waitFor({ timeout: UI_WAIT_MS });
    const markButtons = button(page, english("workspace.unreads.markRead"));
    await markButtons.nth(1).waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await markButtons.count(), 2, "two unread conversations");
    await page.getByText("Thanks all, the site looks great").waitFor();
    await page.getByText("Lunch at 12?").waitFor();
    await shot(page, `${viewport}-unreads`);
    await markButtons.first().click();
    await page.getByText(english("workspace.unreads.marked")).waitFor({ timeout: UI_WAIT_MS });
    await button(page, english("common.undo")).click();
    await markButtons.nth(1).waitFor({ timeout: UI_WAIT_MS });
  });
  if (desktop)
    await step(page, viewport, "Escape on a focused message marks its group read", async () => {
      await button(page, /Lunch at 12\?/u).focus();
      await page.keyboard.press("Escape");
      await page.getByText(english("workspace.unreads.marked")).waitFor({ timeout: UI_WAIT_MS });
    });
  await step(page, viewport, "Mark all messages read empties Unreads and the sidebar", async () => {
    await button(page, english("workspace.unreads.markAllMessagesRead")).click();
    await page.getByText(english("workspace.unreads.emptyTitle")).waitFor({ timeout: UI_WAIT_MS });
    // A new read of the view finds nothing unread: the host has the positions.
    await openView(page, "threads", english("workspace.view.threads"));
    await openView(page, "unreads", english("workspace.view.unreads"));
    await page.getByText(english("workspace.unreads.emptyTitle")).waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-unreads-empty`);
  });

  // Threads: the pricing thread has an unread reply from Research; Mark all as read reads it.
  await step(page, viewport, "Threads shows the unread thread first, and Mark all as read reads it", async () => {
    if (desktop) await page.keyboard.press("Control+Shift+T");
    else await openView(page, "threads", english("workspace.view.threads"));
    const badge = page.getByText(english("workspace.threads.new", { count: 1 }), { exact: true });
    await badge.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-threads`);
    await button(page, english("workspace.activity.markAllRead")).click();
    await badge.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });

  // Later: two saved, one completed.
  await step(page, viewport, "Later completes an item, shows Completed, and removes with Undo", async () => {
    if (desktop) await page.keyboard.press("Control+Shift+S");
    else await openView(page, "later", english("workspace.view.later"));
    const inProgress = page.getByRole("tab", { name: english("workspace.later.inProgressCount", { count: 2 }) });
    await inProgress.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-later`);
    await button(page, english("workspace.later.complete")).first().click();
    await page
      .getByRole("tab", { name: english("workspace.later.inProgressCount", { count: 1 }) })
      .waitFor({ timeout: UI_WAIT_MS });
    await page.getByRole("tab", { name: english("workspace.later.completed") }).click();
    const remove = button(page, english("workspace.later.remove"));
    await remove.nth(1).waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await remove.count(), 2, "two completed items");
    await remove.first().click();
    await page.getByText(english("workspace.later.removed")).waitFor({ timeout: UI_WAIT_MS });
    await page.waitForFunction(
      (label) => document.querySelectorAll(`button[aria-label="${label}"]`).length === 1,
      english("workspace.later.remove"),
      { timeout: UI_WAIT_MS },
    );
    await button(page, english("common.undo")).click();
    await remove.nth(1).waitFor({ timeout: UI_WAIT_MS });
  });

  // Search: a word, a `from:` modifier, and a result that opens the message in its channel.
  await step(page, viewport, "Search finds words, narrows with from:, and opens the exact message", async () => {
    if (desktop) {
      await page.keyboard.press("Control+g");
      const field = page.getByRole("combobox", {
        name: english("workspace.search.placeholderIn", { name: "General" }),
      });
      await field.waitFor({ timeout: UI_WAIT_MS });
      await page.keyboard.type("rivals");
      await page.getByRole("option", { name: english("workspace.search.searchFor", { query: "rivals" }) }).waitFor();
      await shot(page, `${viewport}-search-field`);
      await page.keyboard.press("Enter");
    } else {
      // A phone: the Chat header's search opens Jump to, whose first row searches the messages.
      const back = page.getByRole("button", { name: english("workspace.layout.back"), exact: true }).first();
      if (await back.isVisible()) await back.click();
      await page
        .getByRole("navigation", { name: english("workspace.phone.tabs") })
        .getByRole("button", { name: new RegExp(`^${english("workspace.phone.chat")}`, "u") })
        .click();
      await button(page, english("workspace.app.menu.search")).click();
      const jump = page.getByRole("dialog", { name: english("workspace.app.switcher.title") });
      await jump.waitFor({ timeout: UI_WAIT_MS });
      await page.keyboard.type("rivals");
      // No conversation is named "rivals": the first row searches, so the keyboard's Search key does
      // (it once offered "Create #rivals" first).
      await jump.getByRole("option", { name: english("workspace.jump.searchMessages", { query: "rivals" }) }).waitFor();
      assert.equal(
        await jump.getByRole("option").first().textContent(),
        english("workspace.jump.searchMessages", { query: "rivals" }),
      );
      await page.keyboard.press("Enter");
      await page
        .getByRole("heading", { name: english("workspace.view.search"), exact: true })
        .waitFor({ timeout: UI_WAIT_MS });
    }
    await page
      .getByRole("tab", { name: english("workspace.search.messages", { count: 2 }) })
      .waitFor({ timeout: UI_WAIT_MS });
    await page.locator(".ws-search-mark", { hasText: "rivals" }).first().waitFor();
    await shot(page, `${viewport}-search-results`);
    if (desktop) {
      await page.keyboard.press("Control+g");
      await page.keyboard.press("Control+a");
      await page.keyboard.type("from:@Research rivals");
      await page.keyboard.press("Enter");
    } else {
      const field = page.getByRole("searchbox", { name: english("workspace.search.placeholder") });
      await field.fill("from:@Research rivals");
      await field.press("Enter");
    }
    await page
      .getByRole("tab", { name: english("workspace.search.messages", { count: 1 }) })
      .waitFor({ timeout: UI_WAIT_MS });
    await button(page, /I compare the plans of both rivals/u).click();
    // A thread reply opens its thread: the address names the channel and the thread.
    await page.waitForURL((url) => url.pathname.includes("/c/general/t/general-root"), {
      timeout: UI_WAIT_MS,
      waitUntil: "commit",
    });
    await shot(page, `${viewport}-search-opened`);
  });
  if (desktop)
    await step(page, viewport, "Recent searches show in the empty field", async () => {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+g");
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Backspace");
      await page.getByRole("option", { name: "from:@Research rivals" }).waitFor({ timeout: UI_WAIT_MS });
      await page.keyboard.press("Escape");
    });

  // A result on an agent's step (shown only in debug mode) lights the answer of its turn; the
  // Channels tab matches without accents.
  await step(page, viewport, "A result on an agent's step lights its answer; accents fold", async () => {
    const results = await searchFor(page, desktop, "release branch blockers");
    await results.getByRole("button", { name: /Checking the release branch/u }).click();
    await page
      .locator(".ws-channel-pane [data-highlighted]", { hasText: "launch checklist" })
      .waitFor({ timeout: UI_WAIT_MS });
    await searchFor(page, desktop, "géneral");
    await page.getByRole("tab", { name: english("workspace.search.channels", { count: 1 }) }).waitFor();
  });
  // Recent searches: a tap on the words runs one; on a phone an emptied field shows them again.
  if (!desktop)
    await step(page, viewport, "A recent search runs from its words", async () => {
      const field = page.getByRole("searchbox", { name: english("workspace.search.placeholder") });
      await field.fill("");
      await field.press("Enter");
      await page.locator(".ws-search-recent-run", { hasText: /^rivals$/u }).click();
      await page
        .getByRole("tab", { name: english("workspace.search.messages", { count: 2 }) })
        .waitFor({ timeout: UI_WAIT_MS });
    });
  // Ctrl+F in a DM searches that DM: `in:@Ana`, not `in:#dm-ana`, which named no conversation.
  if (desktop)
    await step(page, viewport, "Ctrl+F in a DM searches it", async () => {
      await page.keyboard.press("Control+k");
      await page.keyboard.type("Ana");
      await page.getByRole("option", { name: /^Ana/u }).first().waitFor({ timeout: UI_WAIT_MS });
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.pathname.includes("/c/dm-ana"), { timeout: UI_WAIT_MS, waitUntil: "commit" });
      await page.keyboard.press("Control+f");
      const field = page.getByRole("combobox", {
        name: english("workspace.search.placeholderIn", { name: "General" }),
      });
      assert.equal(await field.inputValue(), "in:@Ana ");
      await page.keyboard.type("lunch");
      // On a cold start the field can still be taking the words; Enter searches what it holds.
      for (const deadline = Date.now() + UI_WAIT_MS; (await field.inputValue()) !== "in:@Ana lunch"; ) {
        assert.ok(Date.now() < deadline, `The search field holds "${await field.inputValue()}".`);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
      }
      await page.keyboard.press("Enter");
      await page
        .getByRole("tab", { name: english("workspace.search.messages", { count: 1 }) })
        .waitFor({ timeout: UI_WAIT_MS });
    });

  // Jump to: unread conversations first with no text; a fuzzy name finds the channel.
  await step(page, viewport, "Jump to lists the conversations and finds #general by gnrl", async () => {
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: english("workspace.app.switcher.title") });
    await dialog.waitFor({ timeout: UI_WAIT_MS });
    await dialog
      .getByRole("option", { name: /general/u })
      .first()
      .waitFor();
    await shot(page, `${viewport}-jump`);
    await page.keyboard.type("gnrl");
    await dialog
      .getByRole("option", { name: /^#?general/u })
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await page.waitForURL((url) => url.pathname.includes("/c/general"), { timeout: UI_WAIT_MS, waitUntil: "commit" });
  });

  await step(page, viewport, "The shortcuts sheet opens with ⌘/ or Ctrl+/", async () => {
    await page.keyboard.press("Control+/");
    const sheet = page.getByRole("dialog", { name: english("workspace.shortcuts.title") });
    await sheet.waitFor({ timeout: UI_WAIT_MS });
    await sheet.getByText(english("workspace.shortcuts.previousUnread")).waitFor();
    await shot(page, `${viewport}-shortcuts`);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  });

  await step(page, viewport, "Browse channels previews a channel before joining", async () => {
    await page.keyboard.press("Control+Shift+L");
    const dialog = page.getByRole("dialog", { name: english("workspace.app.browse.title") });
    await dialog.waitFor({ timeout: UI_WAIT_MS });
    await dialog.getByText(english("workspace.browse.joined"), { exact: true }).waitFor();
    await shot(page, `${viewport}-browse`);
    await dialog.getByRole("button", { name: english("workspace.browse.preview", { name: "random" }) }).click();
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await page.waitForURL((url) => url.pathname.includes("/c/random"), { timeout: UI_WAIT_MS, waitUntil: "commit" });
    // The reader is not in #random: the pane offers Join instead of the composer.
    await page
      .getByRole("button", { name: english("workspace.app.channel.join") })
      .first()
      .waitFor({
        timeout: UI_WAIT_MS,
      });
    await shot(page, `${viewport}-browse-preview`);
  });

  await step(page, viewport, "DMs lists the DM with Ana and its last message", async () => {
    if (desktop) await page.keyboard.press("Control+Shift+K");
    else await openView(page, "dms", english("workspace.view.dms"));
    await page
      .getByRole("heading", { name: english("workspace.view.dms"), exact: true })
      .waitFor({ timeout: UI_WAIT_MS });
    await page.getByText("Lunch at 12?").waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-dms`);
  });

  await context.close();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  // A cache of its own: the deploy suite runs several scripts at once, and a server that
  // rebuilds a shared cache for its own entries pulls the modules from under the others.
  cacheDir: "node_modules/.vite-e2e/workspace-inbox-e2e",
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: ["src/renderer/stories/web-client-inbox-harness.tsx"],
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
  for (const viewport of VIEWPORT_NAMES) await walk(browser, origin, viewport);
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
