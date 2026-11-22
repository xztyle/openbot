// Checks the learning card and the agent's learning settings on a phone: Undo of a cleanup that
// applied by itself, Apply of a lesson, the settings history with its diff and Roll back, and the
// forget of one chat with its confirm step, and a forget preview that comes back after the panel
// moved to another agent, which must not show there. The page runs on fake host calls
// (`src/renderer/stories/agent-learning-harness.tsx`); each call it makes is checked.
//
// `bun scripts/agent-learning-e2e.ts [--browser-executable=<path>] [--headed] [--out=<dir>]`
// Writes the screenshots to .openbot-build/agent-learning-e2e, or to --out.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("agent-learning-e2e");
const ROOT = resolve(import.meta.dirname, "..");

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const OUT = resolve(option("out") ?? resolve(ROOT, ".openbot-build/agent-learning-e2e"));
const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Learning</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/agent-learning-harness.tsx"></script>
  </body>
</html>`;

function harnessPage(): Plugin {
  return {
    name: "openbot-agent-learning-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await server.transformIndexHtml("/", HARNESS));
      });
    },
  };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  plugins: [harnessPage(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: { entries: ["src/renderer/stories/agent-learning-harness.tsx"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
let browser: Browser | null = null;
const errors: string[] = [];

try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.getByText("Settings history").waitFor({ timeout: 60_000 });
  await page.getByText("By Lead").waitFor();
  await page.screenshot({ path: resolve(OUT, "01-cards.png"), fullPage: true });

  const calls = async () => ((await page.locator("body").getAttribute("data-learning-calls")) ?? "").split("\n");

  await page.getByRole("button", { name: "Undo" }).tap();
  await page.getByText("Undone").waitFor();
  await page.getByRole("button", { name: "Apply" }).tap();
  await page.getByText("Applied", { exact: true }).waitFor();
  assert.deepEqual(await calls(), ["decide:merge:revert", "decide:lesson:accept"]);

  await page.getByRole("button", { name: "Show changes" }).tap();
  await page.getByText("+ Always add three hashtags.").waitFor();
  await page.getByText("claude-sonnet-4-5 → claude-opus-4-5").waitFor();
  await page.screenshot({ path: resolve(OUT, "02-history.png"), fullPage: true });
  await page.getByRole("button", { name: "Roll back" }).tap();
  await page.getByText("Rolled back").waitFor();

  await page.getByRole("button", { name: "Forget what it learned in this chat" }).tap();
  await page.getByRole("button", { name: "Forget 1 item learned in this chat" }).waitFor();
  await page.getByText("The bakery opens at 8 on Sundays.").waitFor();
  await page.screenshot({ path: resolve(OUT, "03-forget.png"), fullPage: true });
  await page.getByRole("button", { name: "Forget 1 item learned in this chat" }).tap();
  await page.getByText("1 item forgotten").waitFor();
  assert.deepEqual((await calls()).slice(2), ["rollback:c1", "forget:chief:false", "forget:chief:true"]);

  // A preview that comes back after the panel moved to another agent is dropped: its items and
  // its confirm button would forget the other agent's chat.
  await page.evaluate(() => {
    document.body.dataset.holdForget = "";
  });
  await page.getByRole("button", { name: "Forget what it learned in this chat" }).tap();
  await page.waitForFunction(() => (document.body.dataset.learningCalls ?? "").split("\n").length === 6);
  await page.evaluate(() => {
    location.hash = "lead";
  });
  await page.getByRole("button", { name: "Forget what it learned in this chat" }).waitFor();
  await page.evaluate(() => {
    delete document.body.dataset.holdForget;
  });
  // The buttons come back once the held preview is done.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "Tidy memories now" && !button.disabled,
    ),
  );
  assert.equal(await page.getByRole("button", { name: "Forget 1 item learned in this chat" }).count(), 0);
  assert.equal(await page.getByText("The bakery opens at 8 on Sundays.").count(), 0);
  assert.deepEqual((await calls()).slice(5), ["forget:chief:false"]);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `The page scrolls sideways by ${overflow}px on a phone.`);
  assert.deepEqual(errors, []);
  logger.info(`Passed. Screenshots: ${OUT}`);
} finally {
  await browser?.close();
  await server.close();
}
