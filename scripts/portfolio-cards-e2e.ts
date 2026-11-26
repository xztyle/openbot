// Checks the chat cards of `post_card` on a phone, in the three Atelier themes in dark and light:
// a table of ad variants answered row by row, a choice, an approve with its own labels and a short
// form. The page runs on fake answers (`src/renderer/stories/portfolio-cards-harness.tsx`); each
// answer it sends is checked, then the frozen cards are drawn in every theme.
//
// `bun scripts/portfolio-cards-e2e.ts [--browser-executable=<path>] [--headed] [--out=<dir>]`
// Writes the screenshots and report.json to .openbot-build/portfolio-cards-e2e, or to --out.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("portfolio-cards-e2e");
const ROOT = resolve(import.meta.dirname, "..");

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const OUT = resolve(option("out") ?? resolve(ROOT, ".openbot-build/portfolio-cards-e2e"));
const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cards</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/portfolio-cards-harness.tsx"></script>
  </body>
</html>`;

function harnessPage(): Plugin {
  return {
    name: "openbot-portfolio-cards-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await server.transformIndexHtml("/", HARNESS));
      });
    },
  };
}

const THEMES = ["craft", "modern", "riso"] as const;
const SCHEMES = ["dark", "light"] as const;

async function theme(page: Page, name: string, scheme: string): Promise<void> {
  await page.evaluate(
    ([atelier, color]) => {
      document.documentElement.dataset.atelierTheme = atelier;
      document.documentElement.dataset.openbotColorScheme = color;
    },
    [name, scheme],
  );
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  // A cache of its own: the deploy suite runs several scripts at once, and a server that
  // rebuilds a shared cache for its own entries pulls the modules from under the others.
  cacheDir: "node_modules/.vite-e2e/portfolio-cards-e2e",
  appType: "custom",
  logLevel: "error",
  plugins: [harnessPage(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: { entries: ["src/renderer/stories/portfolio-cards-harness.tsx"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
let browser: Browser | null = null;
const errors: string[] = [];
const report: { answers: string[]; screenshots: string[]; passed: boolean } = {
  answers: [],
  screenshots: [],
  passed: false,
};

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
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on("crash", () => errors.push("The page crashed."));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.getByText("Approve these ad variants?").waitFor({ timeout: 60_000 });
  await theme(page, "craft", "dark");
  await page.screenshot({ path: resolve(OUT, "01-open-craft-dark.png"), fullPage: true });
  report.screenshots.push("01-open-craft-dark.png");
  const answers = async () => ((await page.locator("body").getAttribute("data-card-answers")) ?? "").split("\n");

  const send = page.getByRole("button", { name: "Send", exact: true }).first();
  assert.equal(await send.isDisabled(), true, "Send waits for a decision on every row.");
  await page.getByRole("button", { name: "Approve A", exact: true }).tap();
  await page.getByRole("button", { name: "Reject B", exact: true }).tap();
  await page.getByRole("button", { name: "Approve C", exact: true }).tap();
  await send.tap();
  await page.getByText("Approved: A (v1), C (v3). Rejected: B (v2).").waitFor();

  await page.getByRole("radio", { name: "French sauces" }).check();
  await page.getByRole("button", { name: "Send", exact: true }).first().tap();
  await page.getByText("French sauces.").waitFor();

  await page.getByRole("button", { name: "Publish", exact: true }).tap();
  await page.getByText("Approved.", { exact: true }).waitFor();

  await page.getByLabel("Opening hours").fill("9-18");
  await page.getByRole("button", { name: "Submit", exact: true }).tap();
  await page.getByText("Opening hours: 9-18.").waitFor();

  report.answers = await answers();
  assert.deepEqual(report.answers, [
    '00000000-0000-4000-8000-000000000001:{"rows":{"v1":"approve","v2":"reject","v3":"approve"}}',
    '00000000-0000-4000-8000-000000000002:{"selected":["sauces"]}',
    '00000000-0000-4000-8000-000000000003:{"approved":true}',
    '00000000-0000-4000-8000-000000000004:{"values":{"hours":"9-18"}}',
  ]);
  await page.screenshot({ path: resolve(OUT, "02-answered-craft-dark.png"), fullPage: true });
  report.screenshots.push("02-answered-craft-dark.png");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `The page scrolls sideways by ${overflow}px on a phone.`);

  await page.goto(`http://127.0.0.1:${address.port}/?answered`);
  await page.getByText("Approve these ad variants?").waitFor({ timeout: 60_000 });
  for (const name of THEMES)
    for (const scheme of SCHEMES) {
      await theme(page, name, scheme);
      const file = `03-${name}-${scheme}.png`;
      await page.screenshot({ path: resolve(OUT, file), fullPage: true });
      report.screenshots.push(file);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(sideways <= 0, `${name} ${scheme} scrolls sideways by ${sideways}px.`);
    }
  assert.deepEqual(errors, []);
  report.passed = true;
  logger.info(`Passed. Screenshots: ${OUT}`);
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ ...report, errors }, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
