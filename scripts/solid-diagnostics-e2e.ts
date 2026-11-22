// Checks the web client for the Solid dev diagnostics that once marked real bugs here: a value read
// once in a component body that never updates (the owner's "Add teammates" and Apps, Today's hidden
// guide), store writes that replace a whole container, and effects that write their own inputs. It
// serves the web client on a mock host (`src/renderer/stories/web-client-today-harness.tsx`), drives
// the desktop sidebar and Ctrl+K and the phone tabs in Chromium, and fails on a diagnostic from a
// call site in `WATCHED`. No account service, host or provider is needed.
//
// `bun scripts/solid-diagnostics-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/solid-diagnostics-e2e/report.json with every diagnostic seen, by call site.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/solid-diagnostics-e2e");
const english = translateFor("en");

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/**
 * The call sites that must stay quiet, as a pattern over the diagnostic text and the stack of the
 * console call. Each one was a bug or a needless re-run that this branch fixed.
 */
const WATCHED: { name: string; pattern: RegExp }[] = [
  {
    name: "web workspace host read once",
    pattern: /"createWebWorkspace\.state\.host" read directly in <WebWorkspaceFrame>/u,
  },
  { name: "Today guide flag read once", pattern: /read directly in <WorkspaceTodayView>/u },
  { name: "switcher icons read once", pattern: /read directly in <Show>[\s\S]*WorkspaceSwitcher\.tsx/u },
  { name: "Later lists replaced", pattern: /IMMUTABLE_UPDATE_IN_STORE\] "store\.(saved|done)"/u },
  { name: "activity replaced", pattern: /IMMUTABLE_UPDATE_IN_STORE\] "store\.activity"/u },
  { name: "sidebar lists replaced", pattern: /IMMUTABLE_UPDATE_IN_STORE\] "store\.sidebar\./u },
  { name: "flush in the channels effect", pattern: /FLUSH_IN_EFFECT_CALLBACK[\s\S]*channels-controller/u },
  { name: "button ref read once", pattern: /read directly in <Button>/u },
  { name: "search bar query read once", pattern: /read directly in <WorkspaceSearchBar>/u },
  { name: "day marker read once", pattern: /read directly in <DayMarker>/u },
  { name: "usage panel props read once", pattern: /read directly in <AgentUsagePanel>/u },
  { name: "command bar labels read once", pattern: /read directly in <QuickSwitcher>/u },
  {
    name: "web workspace seeds read once",
    pattern:
      /"(revocationRevision|activeLocale|createWebServerNotifications\.stored)" read directly in <WebWorkspaceFrame>/u,
  },
];

const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-today-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-solid-diagnostics-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        if (!/^\/app(?:[/?]|$)/u.test(url)) return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await server.transformIndexHtml(url, HARNESS));
      });
    },
  };
}

// Keeps each warning and error with the app frames of its stack: a diagnostic about a read in an
// effect callback names no location, and the stack says which code read.
const CAPTURE = `(() => {
  Error.stackTraceLimit = 60;
  window.__diagnostics = [];
  for (const level of ["warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const stack = (new Error().stack ?? "").split("\\n")
        .filter((line) => /\\/src\\/|\\/packages\\/|@kobalte/.test(line) && !/@solidjs\\//.test(line))
        .slice(1, 9).map((line) => line.trim().replace(location.origin, "")).join(" | ");
      window.__diagnostics.push({ text: String(args[0]), stack });
      return original(...args);
    };
  }
})()`;

interface Diagnostic {
  text: string;
  stack: string;
}
declare global {
  interface Window {
    __diagnostics?: Diagnostic[];
  }
}
const seen = new Map<string, { count: number; text: string; stack: string; where: string }>();
const failures: string[] = [];

async function drain(page: Page, where: string): Promise<void> {
  const items = await page.evaluate(() => {
    const list = window.__diagnostics ?? [];
    window.__diagnostics = [];
    return list;
  });
  for (const item of items) {
    const code = /\[([A-Z_]{6,})\]/u.exec(item.text)?.[1];
    if (!code) continue;
    const key = `${code} ${item.text.split("\n")[0]} ${item.stack.split(" | ").slice(0, 2).join(" | ")}`;
    const entry = seen.get(key) ?? { count: 0, text: item.text, stack: item.stack, where };
    entry.count += 1;
    seen.set(key, entry);
  }
}

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}\n`);
}

async function mounted(page: Page): Promise<void> {
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, null, {
    timeout: 90_000,
  });
  await page
    .getByRole("button", { name: english("workspace.sidebar.directMessages") })
    .first()
    .waitFor({ timeout: 60_000 })
    .catch(() => undefined);
}

const server = await createServer({
  root: ROOT,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: ["src/renderer/stories/web-client-today-harness.tsx"],
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
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(option("browser-executable") ? { executablePath: option("browser-executable") } : {}),
  });

  // A computer: the sidebar, the views it opens, and Ctrl+K.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(CAPTURE);
    await page.goto(`${origin}/app/general`, { waitUntil: "commit" });
    await mounted(page);
    // The host and its role arrive after the workspace mounts: the owner still gets the action.
    await page
      .getByRole("button", { name: english("workspace.sidebar.addTeammates") })
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    check(
      "the owner can add teammates",
      (await page.getByRole("button", { name: english("workspace.sidebar.addTeammates") }).count()) === 1,
    );
    await drain(page, "desktop load");
    const rows = page.locator("nav button:visible, aside button:visible");
    const count = Math.min(await rows.count(), 30);
    for (let index = 0; index < count; index += 1) {
      await rows
        .nth(index)
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      await page.keyboard.press("Escape");
      await drain(page, `desktop row ${index}`);
    }
    await page.keyboard.press("Control+k");
    await page.keyboard.type("appr");
    await page.keyboard.press("Escape");
    await drain(page, "desktop ctrl+k");
    await context.close();
  }

  // An iPhone: every tab of the tab bar.
  {
    const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
    const context = await browser.newContext({ ...iphone, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.addInitScript(CAPTURE);
    await page.goto(`${origin}/app/general`, { waitUntil: "commit" });
    await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, null, {
      timeout: 90_000,
    });
    const tabs = page.getByRole("navigation", { name: english("workspace.phone.tabs") }).getByRole("button");
    await tabs.first().waitFor({ timeout: 60_000 });
    const count = await tabs.count();
    for (let index = 0; index < count; index += 1) {
      // A tab can open a pane over the bar, such as a chat: then the bar comes back with Back.
      if (!(await tabs.nth(index).isVisible())) await page.goBack({ waitUntil: "commit" });
      await tabs.nth(index).tap({ timeout: 10_000 });
      await page
        .getByRole("main")
        .first()
        .waitFor()
        .catch(() => undefined);
      await drain(page, `phone tab ${index}`);
    }
    await context.close();
  }

  const report = [...seen.values()].sort((left, right) => right.count - left.count);
  for (const watched of WATCHED) {
    const hits = report.filter((entry) => watched.pattern.test(`${entry.text}\n${entry.stack}`));
    check(
      `no diagnostic: ${watched.name}`,
      hits.length === 0,
      hits.map((hit) => hit.text.split("\n")[0]),
    );
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    resolve(OUT, "report.json"),
    JSON.stringify({ passed: failures.length === 0, failures, diagnostics: report }, null, 2),
  );
} finally {
  await browser?.close();
  await server.close();
}
if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.exit(0);
