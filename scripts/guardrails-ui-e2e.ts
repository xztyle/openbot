// Serves the Guardrails tab of the Trust view on a fake host (`src/renderer/stories/trust-guardrails-harness.tsx`)
// and drives it in Chromium, on a desktop and a phone viewport: the paused agent resumes, a limit is
// changed and saved, and the meter and the events show. Light and dark screenshots of each.
// `bun scripts/guardrails-ui-e2e.ts [--browser-executable=<path>]`
// Writes .openbot-build/guardrails-ui-e2e/report.json and screenshots.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/guardrails-ui-e2e");
const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Guardrails</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/trust-guardrails-harness.tsx"></script>
  </body>
</html>`;

function harnessPage(): Plugin {
  return {
    name: "openbot-guardrails-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!/^\/guardrails(?:[/?]|$)/u.test(request.url ?? "")) return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await server.transformIndexHtml(request.url ?? "/guardrails", HARNESS));
      });
    },
  };
}

const steps: { name: string; passed: boolean; detail?: string }[] = [];
const step = (name: string, passed: boolean, detail?: string) =>
  steps.push({ name, passed, ...(detail ? { detail } : {}) });

/** The calls the fake host got, as the harness writes them on the body. */
async function hostCalls(page: Page): Promise<{ resumed: string[]; saves: number; savedTurns: number | null }> {
  const value = JSON.parse(await page.evaluate(() => document.body.dataset.guardrailsCalls ?? "{}"));
  const turns = value?.saved?.[0]?.agentDefaults?.turnsPerDay;
  return {
    resumed: Array.isArray(value?.resumed) ? value.resumed.map(String) : [],
    saves: Array.isArray(value?.saved) ? value.saved.length : 0,
    savedTurns: typeof turns === "number" ? turns : null,
  };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  // A cache of its own: the deploy suite runs several scripts at once, and a server that
  // rebuilds a shared cache for its own entries pulls the modules from under the others.
  cacheDir: "node_modules/.vite-e2e/guardrails-ui-e2e",
  appType: "custom",
  logLevel: "error",
  plugins: [harnessPage(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: { entries: ["src/renderer/stories/trust-guardrails-harness.tsx"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${address.port}`;
let browser: Browser | null = null;
try {
  const executablePath = process.argv.find((arg) => arg.startsWith("--browser-executable="))?.slice(21);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  for (const [name, viewport] of [
    ["desktop", { width: 1100, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport, colorScheme: scheme });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${origin}/guardrails`, { waitUntil: "networkidle", timeout: 180_000 });
      await page.getByText("Paused now").waitFor({ timeout: 60_000 });
      await page.screenshot({ path: resolve(OUT, `${name}-${scheme}.png`), fullPage: true });
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      step(`${name} ${scheme}: no horizontal scroll`, width <= viewport.width, `scrollWidth ${width}`);
      step(`${name} ${scheme}: no page error`, errors.length === 0, errors.join("; "));
      if (scheme === "dark") {
        await page.close();
        continue;
      }
      step(
        `${name}: meter shows the forecast`,
        await page
          .getByText(/runs out about/u)
          .first()
          .isVisible(),
      );
      step(`${name}: the blocked injection shows`, await page.getByText(/Blocked meta-ads/u).isVisible());
      await page.getByRole("button", { name: "Resume" }).click();
      await page.getByText("Nothing is paused.").waitFor({ timeout: 10_000 });
      const { resumed } = await hostCalls(page);
      step(
        `${name}: Resume ends the pause on the host`,
        JSON.stringify(resumed) === '["agent:ana-1"]',
        JSON.stringify(resumed),
      );
      // A settings group is a titled section: a region named by its title.
      const turns = page.getByRole("region", { name: "Each agent, per day" }).getByLabel("Turns");
      await turns.fill("300");
      await page.getByRole("button", { name: "Save" }).click();
      await page.waitForFunction(() => (document.body.dataset.guardrailsCalls ?? "").includes('"saved":[{'));
      const saved = (await hostCalls(page)).savedTurns;
      step(`${name}: a changed limit saves`, saved === 300, String(saved));
      await page.screenshot({ path: resolve(OUT, `${name}-after.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
const passed = steps.length > 0 && steps.every((entry) => entry.passed);
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ passed, steps }, null, 2)}\n`);
for (const entry of steps)
  process.stdout.write(`${entry.passed ? "ok  " : "FAIL"} ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}\n`);
if (!passed) process.exit(1);
