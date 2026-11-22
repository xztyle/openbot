// Checks that the read state and every count agree in the workspace on a computer and on an iPhone:
// opening a channel or a DM reads it (sidebar row, Space rail, tab title, phone Chat tab), a read DM
// takes its mention out of Activity, a read on another device of the reader clears this one, a reply
// that came into the open thread while the window was in the background is read when the reader comes
// back, and an agent the reader has not written to lately shows its DM row when it wrote to them.
// It serves the web client on the mock host of `src/renderer/stories/web-client-inbox-harness.tsx`
// and drives it in Chromium. No account service, host or provider is needed.
//
// `bun scripts/workspace-unread-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/workspace-unread-e2e/report.json, and a screenshot of each failed step.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("workspace-unread-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/workspace-unread-e2e");
const UI_WAIT_MS = 60_000;

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;

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

function webClientPages(): Plugin {
  return {
    name: "openbot-workspace-unread-harness",
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

interface ReadState {
  unreadCount: number;
  firstUnreadMessageId: string | null;
  throughMessageId: string | null;
}
declare global {
  interface Window {
    /** The mock host of `web-client-inbox-harness.tsx`: the parts that this check uses. */
    harnessHost?: {
      api: {
        agent: {
          readChannel(input: { channelId: string }): Promise<{ throughSequence: number }>;
          channelCommand(command: {
            type: "read";
            channelId: string;
            throughSequence: number;
            operationId: string;
          }): Promise<unknown>;
          workspaceActivity?(input: { limit: number }): Promise<{ threads: { unreadCount: number }[] }>;
          workspaceDmAgents?(...args: unknown[]): Promise<{ agentIds: string[]; recentAgentIds?: string[] }>;
          listConversationReads(...args: unknown[]): Promise<Record<string, ReadState>>;
        };
      };
      postChannelMessage(
        channelId: string,
        author: { kind: "agent"; id: string; name: string },
        text: string,
        threadRootId?: string,
      ): unknown;
    };
  }
}

interface Step {
  viewport: ViewportName;
  name: string;
  passed: boolean;
  detail?: string;
}
const report: { steps: Step[]; pageErrors: string[]; passed: boolean } = { steps: [], pageErrors: [], passed: false };

async function step(page: Page, viewport: ViewportName, name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.steps.push({ viewport, name, passed: true });
  } catch (error) {
    report.steps.push({ viewport, name, passed: false, detail: String(error).slice(0, 800) });
    await page.screenshot({ path: resolve(OUT, `${viewport}-${report.steps.length}-failed.png`) }).catch(() => {});
  }
}

/** What the page says is unread: the labels of the sidebar rows and rail buttons, the tab title and tabs. */
interface Marks {
  title: string;
  rows: string[];
  activity: string;
  threadsUnread: boolean;
  tabs: string[];
}
function marks(page: Page): Promise<Marks> {
  return page.evaluate(() => {
    const label = (element: Element) => element.getAttribute("aria-label") ?? "";
    const rows = [...document.querySelectorAll(".ws-sidebar-row, .space-rail-button")]
      .map(label)
      .filter((text) => /unread|mention/iu.test(text));
    const nav = [...document.querySelectorAll(".ws-sidebar-row")];
    const activity = nav.find((row) => /^Activity/u.test(row.textContent?.trim() ?? ""));
    const threads = nav.find((row) => /^Threads/u.test(row.textContent?.trim() ?? ""));
    const tabs = [...document.querySelectorAll("button")]
      .map(label)
      .filter((text) => /^(Today|Chat|Agents|Inbox)\b/u.test(text));
    return {
      title: document.title,
      rows,
      activity: activity?.textContent?.trim().replace(/\s+/gu, " ") ?? "",
      threadsUnread: threads?.hasAttribute("data-unread") ?? false,
      tabs,
    };
  });
}

async function until(page: Page, check: (value: Marks) => boolean, what: string): Promise<Marks> {
  const deadline = Date.now() + 10_000;
  let last = await marks(page);
  while (Date.now() < deadline) {
    if (check(last)) return last;
    await page.waitForTimeout(250);
    last = await marks(page);
  }
  throw new Error(`${what}: ${JSON.stringify(last)}`);
}

const hasRow = (value: Marks, pattern: RegExp) => value.rows.some((row) => pattern.test(row));

/** Loads the harness. `recentOnly` makes the host list only Chief as written to lately, with Sales unread. */
async function open(browser: Browser, viewport: ViewportName, recentOnly = false): Promise<Page> {
  const context = await browser.newContext(VIEWPORTS[viewport]);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(`${viewport}: ${error.message}`));
  if (recentOnly)
    await page.addInitScript(() => {
      let host: Window["harnessHost"];
      Object.defineProperty(window, "harnessHost", {
        configurable: true,
        get: () => host,
        set(value: NonNullable<Window["harnessHost"]>) {
          host = value;
          const agent = value.api.agent;
          const dmAgents = agent.workspaceDmAgents?.bind(agent);
          if (dmAgents)
            agent.workspaceDmAgents = async (...args: unknown[]) => ({
              ...(await dmAgents(...args)),
              recentAgentIds: ["chief"],
            });
          const reads = agent.listConversationReads.bind(agent);
          agent.listConversationReads = async (...args: unknown[]) => ({
            ...(await reads(...args)),
            sales: { unreadCount: 2, firstUnreadMessageId: null, throughMessageId: null },
          });
        },
      });
    });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${origin}/app`, { waitUntil: "commit" });
    const ready = await page
      .waitForFunction(() => window.harnessHost && document.querySelector(".ws-sidebar-row"), null, {
        timeout: UI_WAIT_MS / 2,
      })
      .then(
        () => true,
        () => false,
      );
    if (ready) break;
  }
  // The list, the activity and the agents' reads arrive after the first rows.
  await until(page, (value) => /^\(\d+\)/u.test(value.title), "the tab title counts");
  return page;
}

async function openRow(page: Page, name: RegExp): Promise<void> {
  await page.locator(".ws-sidebar-row").filter({ hasText: name }).first().click();
}

async function desktop(browser: Browser): Promise<void> {
  const page = await open(browser, "desktop");
  await step(page, "desktop", "the start counts #general, Ana's DM and Activity", async () => {
    await until(
      page,
      (value) =>
        hasRow(value, /^Channel general, Unread/u) &&
        hasRow(value, /^Ana, .*1 mention/u) &&
        value.activity === "Activity1" &&
        value.title.startsWith("(1)"),
      "start",
    );
  });
  await step(page, "desktop", "opening #general reads it", async () => {
    await openRow(page, /^#?\s*general/u);
    await until(page, (value) => !hasRow(value, /^Channel general/u), "#general stays unread");
  });
  await step(page, "desktop", "opening Ana's DM reads it, and Activity, the rail and the title follow", async () => {
    await openRow(page, /^AN\s*Ana|^Ana/u);
    await until(
      page,
      (value) =>
        !hasRow(value, /^Ana,/u) &&
        !hasRow(value, /^General,/u) &&
        value.activity === "Activity" &&
        !value.title.startsWith("("),
      "Ana's DM or its mention stays",
    );
  });
  await page.context().close();

  const remote = await open(browser, "desktop");
  await step(remote, "desktop", "a read on another device clears every count here", async () => {
    await remote.evaluate(async () => {
      const agent = window.harnessHost?.api.agent;
      if (!agent) throw new Error("No mock host.");
      for (const channelId of ["dm-ana", "general"]) {
        const page = await agent.readChannel({ channelId });
        await agent.channelCommand({
          type: "read",
          channelId,
          throughSequence: page.throughSequence,
          operationId: crypto.randomUUID(),
        });
      }
    });
    await until(
      remote,
      (value) =>
        !hasRow(value, /^(Channel general|Ana,|General,)/u) &&
        value.activity === "Activity" &&
        !value.title.startsWith("("),
      "a count stays after the other device read",
    );
  });
  await step(remote, "desktop", "a reply that came while away is read when the window is back", async () => {
    const threads = () =>
      remote.evaluate(async () =>
        ((await window.harnessHost?.api.agent.workspaceActivity?.({ limit: 100 }))?.threads ?? []).map(
          (thread) => thread.unreadCount,
        ),
      );
    await remote
      .locator(".ws-sidebar-row")
      .filter({ hasText: /^Threads/u })
      .first()
      .click();
    await remote.getByText("2 replies").first().click();
    await until(remote, (value) => !value.threadsUnread, "the opened thread stays unread");
    await remote.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event("blur"));
      window.harnessHost?.postChannelMessage(
        "general",
        { kind: "agent", id: "research", name: "Research" },
        "One more price checked.",
        "general-root",
      );
    });
    await remote.waitForTimeout(1_500);
    assert.deepEqual(await threads(), [1], "a reply while away must stay unread");
    await remote.evaluate(() => {
      document.hasFocus = () => true;
      window.dispatchEvent(new Event("focus"));
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await threads())[0] !== 0) await remote.waitForTimeout(250);
    assert.deepEqual(await threads(), [0], "the thread is read when the reader is back");
  });
  await remote.context().close();

  const hidden = await open(browser, "desktop", true);
  await step(hidden, "desktop", "an agent not written to lately shows its unread DM", async () => {
    await until(
      hidden,
      (value) => hasRow(value, /^Sales Outbound, .*2 mentions/u) && value.title.startsWith("(3)"),
      "Sales' unread DM is missing",
    );
  });
  await hidden.context().close();
}

async function phone(browser: Browser): Promise<void> {
  const page = await open(browser, "phone");
  await step(page, "phone", "the Chat tab is read once its channel and DM are", async () => {
    await until(
      page,
      (value) => value.tabs.includes("Chat, Unread") && value.tabs.some((tab) => /^Inbox, 1/u.test(tab)),
      "start",
    );
    await page.getByRole("button", { name: /^Chat/u }).first().click();
    await openRow(page, /^#?\s*general/u);
    await page.waitForTimeout(1_000);
    await page.goBack();
    await openRow(page, /^AN\s*Ana|^Ana/u);
    await until(
      page,
      (value) => value.tabs.includes("Chat") && value.tabs.includes("Inbox") && !value.title.startsWith("("),
      "the phone tabs keep a count",
    );
  });
  await page.context().close();
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
  await desktop(browser);
  await phone(browser);
  report.passed =
    report.steps.length > 0 && report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps. Report: ${resolve(OUT, "report.json")}`,
);
for (const item of report.steps.filter((entry) => !entry.passed)) logger.error(`${item.name}: ${item.detail}`);
for (const error of report.pageErrors) logger.error(error);
process.exit(report.passed ? 0 : 1);
