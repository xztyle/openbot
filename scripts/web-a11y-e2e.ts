// Checks the web client with a keyboard and a screen reader in mind: where the focus goes when a
// dialog, a panel or a menu closes, when a decision or a message goes away, and what a screen reader
// hears when an agent answers. It also runs axe-core on the main views, on a computer and a phone.
//
// It serves the web client on a mock host (`src/renderer/stories/web-client-inbox-harness.tsx`, and
// `web-client-today-harness.tsx` with `?harness=today`) and drives it in Chromium. No account
// service, host or provider is needed.
//
// `bun scripts/web-a11y-e2e.ts [--browser-executable=<path>] [--headed] [--out=<dir>] [--cpu-throttle=<n>]`
// Writes report.json to .openbot-build/web-a11y-e2e, or to --out.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("web-a11y-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const UI_WAIT_MS = 60_000;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const OUT = resolve(option("out") ?? resolve(ROOT, ".openbot-build/web-a11y-e2e"));
const HARNESSES = {
  inbox: "web-client-inbox-harness",
  today: "web-client-today-harness",
} as const;

/** The site's /app page, with the harness that `?harness=` names. */
function harnessPage(name: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/${name}.tsx"></script>
  </body>
</html>`;
}

function webClientPages(): Plugin {
  return {
    name: "openbot-web-a11y-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        if (!/^\/app(?:[/?]|$)/u.test(url)) return next();
        const harness = new URL(url, "http://harness").searchParams.get("harness") === "today" ? "today" : "inbox";
        const html = await server.transformIndexHtml(url, harnessPage(HARNESSES[harness]));
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      });
    },
  };
}

interface Step {
  name: string;
  passed: boolean;
  detail?: string;
}

const report: { steps: Step[]; pageErrors: string[]; axe: Record<string, string[]>; passed: boolean } = {
  steps: [],
  pageErrors: [],
  axe: {},
  passed: false,
};

async function step(name: string, run: () => Promise<void>) {
  try {
    await run();
    report.steps.push({ name, passed: true });
    logger.info(`ok: ${name}`);
  } catch (error) {
    report.steps.push({ name, passed: false, detail: String(error).slice(0, 800) });
    logger.error(`failed: ${name}`, error);
  }
}

const AXE = readFileSync(new URL(import.meta.resolve("axe-core/axe.min.js")).pathname, "utf8");
/**
 * Rules other checks own (contrast, tap target size), and the label-in-name rule: the space tiles and
 * the avatars show initials ("GE", "AN") that are not words, and their names say the whole name.
 */
const AXE_SKIPPED = ["color-contrast", "target-size", "label-content-name-mismatch"];

/** The serious and critical axe-core violations in `scope`, as "rule: target" lines. */
async function axeViolations(page: Page, scope = "body"): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE });
  // The script tag's global `axe` has no type here, so the run is a page expression.
  const options = {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: Object.fromEntries(AXE_SKIPPED.map((rule) => [rule, { enabled: false }])),
  };
  const lines = await page.evaluate<unknown>(`axe
    .run(document.querySelector(${JSON.stringify(scope)}), ${JSON.stringify(options)})
    .then((result) => result.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .flatMap((violation) => violation.nodes.map((node) => violation.id + ": " + node.target.join(" "))))`);
  assert.ok(Array.isArray(lines), "axe-core returned no list.");
  return lines.map(String);
}

async function checkAxe(page: Page, name: string, scope?: string) {
  const violations = await axeViolations(page, scope);
  report.axe[name] = violations;
  assert.deepEqual(violations, [], `axe-core found serious violations in ${name}.`);
}

/** The focused element, as a test reads it: its role or tag, and its name. */
function focused(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body)
      return { tag: "body", name: "", role: null, text: "" };
    return {
      tag: element.tagName.toLowerCase(),
      name: element.getAttribute("aria-label") ?? "",
      role: element.getAttribute("role"),
      text: (element.textContent ?? "").trim().slice(0, 120),
    };
  });
}

/** Waits until the focus is on an element that `matches` accepts, and fails with where it is. */
async function focusSettles(
  page: Page,
  what: string,
  matches: (focus: Awaited<ReturnType<typeof focused>>) => boolean,
) {
  const deadline = Date.now() + 15_000;
  let last = await focused(page);
  while (Date.now() < deadline) {
    last = await focused(page);
    if (matches(last)) return;
    await page.waitForTimeout(50);
  }
  assert.fail(`The focus is not on ${what}: it is on ${JSON.stringify(last)}.`);
}

/**
 * Moves the focus of an open menu to the item `name`. The menu focuses its first item a frame after
 * it opens, so this waits for that before it moves on.
 */
async function focusMenuItem(page: Page, name: string) {
  await focusSettles(page, "the menu", (focus) => focus.role === "menuitem");
  await page.getByRole("menuitem", { name }).focus();
  await focusSettles(page, name, (focus) => focus.role === "menuitem" && focus.text === name);
}

const dialogs = (page: Page) => page.locator('[role="dialog"], [role="alertdialog"]');
const composer = (page: Page) => page.locator('.ws-layout-main [role="textbox"][contenteditable="true"]').first();

async function newPage(browser: Browser, phone: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }
      : { viewport: { width: 1440, height: 900 } },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  // `--cpu-throttle=4` slows the page as a busy machine does, to find steps that race the app.
  const throttle = Number(option("cpu-throttle") ?? 1);
  if (throttle > 1) {
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  return { context, page };
}

async function load(page: Page, url: string) {
  await page.goto(url, { waitUntil: "commit" });
  await page.locator(".web-app-frame").first().waitFor({ timeout: UI_WAIT_MS });
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
  optimizeDeps: {
    entries: Object.values(HARNESSES).map((name) => `src/renderer/stories/${name}.tsx`),
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

  // A computer: the dialogs, the switcher, the thread panel and the sidebar, in #general.
  {
    const { context, page } = await newPage(browser, false);
    await load(page, `${origin}/app/general/c/general`);
    await composer(page).waitFor({ timeout: UI_WAIT_MS });
    const threads = page.locator(".ws-sidebar button", { hasText: "Threads" }).first();

    await step("the channel and the sidebar have no serious axe-core violations", () => checkAxe(page, "desk-channel"));

    for (const [key, title] of [
      ["Control+k", "Jump to"],
      ["Control+n", "New message"],
      ["Control+Shift+l", "Browse channels"],
    ] as const) {
      await step(`${key} opens "${title}", and Escape gives the focus back to the button that had it`, async () => {
        await threads.focus();
        await page.keyboard.press(key);
        await dialogs(page).filter({ hasText: title }).waitFor();
        await focusSettles(page, "a field of the dialog", (focus) => focus.tag === "input");
        await page.keyboard.press("Escape");
        await dialogs(page).first().waitFor({ state: "detached" });
        await focusSettles(page, "Threads", (focus) => focus.text === "Threads");
      });
    }

    await step("Ctrl+/ moves the focus into the shortcuts sheet, and Escape gives it back", async () => {
      await threads.focus();
      await page.keyboard.press("Control+/");
      const sheet = dialogs(page).filter({ hasText: "Keyboard shortcuts" });
      await sheet.waitFor();
      await focusSettles(page, "the sheet", (focus) => focus.role === "dialog");
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
      await focusSettles(page, "Threads", (focus) => focus.text === "Threads");
    });

    await step("a dialog that a menu item opened gives the focus back to the menu's button", async () => {
      await page.locator('.ws-sidebar button[aria-label^="Channel general"]').first().focus();
      await page.keyboard.press("Tab");
      await focusSettles(page, "the options of general", (focus) => focus.name === "Options for general");
      await page.keyboard.press("Enter");
      await focusMenuItem(page, "Move to a new section");
      await page.keyboard.press("Enter");
      await dialogs(page).filter({ hasText: "New section" }).waitFor();
      // The menu closes as the dialog opens: Escape goes to the dialog once it has the focus.
      await focusSettles(page, "the dialog's field", (focus) => focus.tag === "input");
      await page.keyboard.press("Escape");
      await dialogs(page).first().waitFor({ state: "detached" });
      await focusSettles(page, "the options of general", (focus) => focus.name === "Options for general");
    });

    await step("Jump to is a combobox: the arrows move the option that a screen reader hears", async () => {
      await page.keyboard.press("Control+k");
      const field = page.getByRole("combobox", { name: "Jump to, search, or ask an agent" });
      await field.waitFor();
      await focusSettles(page, "the field", (focus) => focus.role === "combobox");
      await checkAxe(page, "desk-jump-to", '[role="dialog"]');
      const activeOption = () =>
        page.evaluate(() => {
          const id = document.activeElement?.getAttribute("aria-activedescendant");
          const option = id ? document.getElementById(id) : null;
          return option
            ? { role: option.getAttribute("role"), selected: option.getAttribute("aria-selected"), id }
            : null;
        });
      const first = await activeOption();
      assert.equal(first?.role, "option", "The field names no active option.");
      assert.equal(first?.selected, "true", "The active option is not selected.");
      await page.keyboard.press("ArrowDown");
      const second = await activeOption();
      assert.equal(second?.role, "option", "ArrowDown leaves no active option.");
      assert.notEqual(second?.id, first?.id, "ArrowDown does not move the active option.");
      assert.equal(await page.getByRole("option", { selected: true }).count(), 1, "More than one option is selected.");
      await page.keyboard.press("Escape");
      await dialogs(page).first().waitFor({ state: "detached" });
      // The focus goes back after a paint: wait for it, so it does not land after the next step's.
      await focusSettles(page, "the options of general", (focus) => focus.name === "Options for general");
    });

    await step("Escape closes a thread and gives the focus back to View thread", async () => {
      const viewThread = page.locator("button", { hasText: "View thread" }).first();
      await viewThread.focus();
      await page.keyboard.press("Enter");
      await page.locator(".ws-layout-panel").waitFor();
      await focusSettles(page, "the thread's message box", (focus) => focus.name.startsWith("Reply in the thread"));
      await page.keyboard.press("Escape");
      await page.locator(".ws-layout-panel").waitFor({ state: "detached" });
      await focusSettles(page, "View thread", (focus) => focus.text.includes("View thread"));
    });

    await step("a deleted message hands the focus to the message next to it", async () => {
      await composer(page).focus();
      await page.keyboard.type("A message to delete");
      await page.keyboard.press("Enter");
      const mine = page.locator("article.ws-message", { hasText: "A message to delete" }).last();
      await mine.waitFor();
      await mine.focus();
      await mine.getByRole("button", { name: "More actions" }).focus();
      await page.keyboard.press("Enter");
      await focusMenuItem(page, "Delete message");
      await page.keyboard.press("Enter");
      const confirm = page.getByRole("alertdialog");
      await confirm.waitFor();
      await confirm.getByRole("button", { name: "Delete message" }).press("Enter");
      await mine.waitFor({ state: "detached" });
      await focusSettles(page, "a message", (focus) => focus.tag === "article" && focus.name.includes(" at "));
      // The confirm focuses its target once more two frames after it closes: let that pass.
      await page.evaluate(
        () =>
          new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))),
      );
    });

    await step("leaving a channel from its menu keeps the focus in the sidebar", async () => {
      await page.locator('.ws-sidebar button[aria-label^="Channel general"]').first().focus();
      await page.keyboard.press("Tab");
      await focusSettles(page, "the options of general", (focus) => focus.name === "Options for general");
      await page.keyboard.press("Enter");
      await focusMenuItem(page, "Leave channel");
      await page.keyboard.press("Enter");
      await page.locator('.ws-sidebar button[aria-label^="Channel general"]').waitFor({ state: "detached" });
      await focusSettles(page, "a sidebar row", (focus) => focus.tag === "button" && focus.text.length > 0);
      assert.ok(
        await page.evaluate(() => document.querySelector(".ws-sidebar")?.contains(document.activeElement) === true),
        "The focus left the sidebar.",
      );
    });
    await context.close();
  }

  // A computer: what a screen reader hears when an agent answers in the owner's chat.
  {
    const { context, page } = await newPage(browser, false);
    await load(page, `${origin}/app/general/dm/chief`);
    const box = page.locator('[role="textbox"][contenteditable="true"]').first();
    await box.waitFor({ timeout: UI_WAIT_MS });
    await step("an agent's answer is read once it is complete, and the owner's own message is not", async () => {
      await box.click();
      await page.keyboard.type("Is the plan ready");
      await page.keyboard.press("Enter");
      const live = page.locator('.sr-only[aria-live="polite"]', { hasText: "New message from Chief" });
      await live.waitFor({ state: "attached", timeout: 10_000 });
      const text = (await live.textContent()) ?? "";
      assert.match(text, /New message from Chief: Mock reply from Chief/u);
      assert.doesNotMatch(text, /Preview User/u, "The owner's own message was read out.");
    });
    await context.close();
  }

  // A computer, with things that wait: Today's decisions and a thread where an agent reports.
  {
    const { context, page } = await newPage(browser, false);
    // Today lists the space that shows: Trading has a money decision and a question. Each check loads
    // the page again, so the other decision is still there to take the focus.
    await load(page, `${origin}/app/market-trading/today?harness=today`);
    const cards = page.locator("article.ws-today-decision");
    await cards.nth(1).waitFor({ timeout: UI_WAIT_MS });
    await step("Today has no serious axe-core violations", () => checkAxe(page, "desk-today"));
    await step("after Approve, the next decision takes the focus", async () => {
      const before = await cards.count();
      await page.getByRole("button", { name: "Approve" }).first().focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (count) => document.querySelectorAll("article.ws-today-decision").length < count,
        before,
      );
      await focusSettles(page, "the next decision", (focus) => focus.tag === "article" && focus.name.includes("needs"));
    });
    await load(page, `${origin}/app/market-trading/today?harness=today`);
    await cards.nth(1).waitFor({ timeout: UI_WAIT_MS });
    await step("after an answer, the next decision takes the focus", async () => {
      const before = await cards.count();
      const answer = page.getByPlaceholder("Type your answer").first();
      await answer.focus();
      await page.keyboard.type("The first hook");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (count) => document.querySelectorAll("article.ws-today-decision").length < count,
        before,
      );
      await focusSettles(page, "the next decision", (focus) => focus.tag === "article" && focus.name.includes("needs"));
    });

    await load(page, `${origin}/app/general/c/general?harness=today`);
    await step("a reply that an agent posts in an open thread is read out", async () => {
      await page.locator("button", { hasText: "View thread" }).first().click();
      await page.locator(".ws-layout-panel").waitFor();
      await page
        .locator('.ws-layout-panel .sr-only[aria-live="polite"]', { hasText: "New message from Research" })
        .waitFor({ state: "attached", timeout: 10_000 });
    });
    await context.close();
  }

  // A phone: the tabs and Today.
  {
    const { context, page } = await newPage(browser, true);
    await load(page, `${origin}/app/general?harness=today`);
    await page.locator("article.ws-today-decision").first().waitFor({ timeout: UI_WAIT_MS });
    await step("the phone's Today has no serious axe-core violations", () => checkAxe(page, "phone-today"));
    for (const tab of ["Chat", "Agents", "Inbox"]) {
      await step(`the phone's ${tab} tab has no serious axe-core violations`, async () => {
        await page.locator("nav[aria-label='Workspace sections'] button", { hasText: tab }).first().tap();
        await page.waitForFunction(
          (name) =>
            document
              .querySelector("nav[aria-label='Workspace sections'] button[aria-current='page']")
              ?.textContent?.includes(name) === true,
          tab,
        );
        await checkAxe(page, `phone-${tab.toLowerCase()}`);
      });
    }
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}

report.passed = report.steps.length > 0 && report.steps.every((entry) => entry.passed);
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
logger.info(`report: ${resolve(OUT, "report.json")}`);
if (!report.passed) {
  logger.error(
    "web a11y e2e failed",
    report.steps.filter((entry) => !entry.passed),
  );
  process.exit(1);
}
