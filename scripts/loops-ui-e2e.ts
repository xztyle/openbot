// Checks the Loops view on an iPhone and on a computer against a real loop service: the page
// (`src/renderer/stories/loops-harness.tsx`) reads and changes loops through `LoopService` on a fresh,
// migrated database, so each check compares what the view shows with what the host stores.
//
// `bun scripts/loops-ui-e2e.ts [--browser-executable=<path>] [--headed] [--serve]`
// `--serve` only serves the page and prints its address, for a look by hand.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseWorkspaceLoopAction, parseWorkspaceLoopsInput } from "@openbot/contracts/ipc";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { LoopService } from "../src/backend/loops/loop-service";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const ROOT = resolve(import.meta.dirname, "..");
const UI_WAIT_MS = 30_000;
const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1440, height: 900 } },
} as const;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Loops</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/loops-harness.tsx"></script>
  </body>
</html>`;

const data = mkdtempSync(join(tmpdir(), "loops-ui-e2e-"));
const database = new OpenBotDatabase(join(data, "user-data"));
await runCauseEffect(database.initialize());
database.connection.exec(
  "INSERT INTO spaces (space_id, name, slug, icon, hue, position) VALUES ('uo', 'Universidad Online', 'uo', NULL, NULL, 1)",
);
const AGENT_IDS = ["a-orchestrator", "a-game-designer", "a-qa", "a-art-producer"];
const loops = LoopService.create(database, {
  agents: () => AGENT_IDS.map((id) => ({ id, name: id })),
  agentSpace: () => "uo",
  spaceExists: (spaceId) => spaceId === "uo",
  notifyAgent: () => undefined,
  runRoutine: async () => undefined,
  createTicket: async () => null,
});
const owner = { kind: "person" } as const;
/** An agent of the space, for the moves and questions that wait for the owner. */
const AGENT = { kind: "agent", agentId: "a-orchestrator" } as const;

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((done, failed) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => done(text || "{}"));
    request.on("error", failed);
  });
}

/** The item of a `/loops/ask` call. */
function askedItem(text: string): string {
  return /"itemId":"([^"]+)"/u.exec(text)?.[1] ?? "";
}

/** The page at `/`, and the loop host at `/loops/board` and `/loops/action`. */
function harness(): Plugin {
  return {
    name: "openbot-loops-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        if (url.startsWith("/loops/")) {
          response.setHeader("Content-Type", "application/json");
          try {
            const body = await readBody(request);
            const answer = url.startsWith("/loops/board")
              ? loops.board(parseWorkspaceLoopsInput(JSON.parse(body)).spaceId)
              : url.startsWith("/loops/ask")
                ? loops.escalate(AGENT.agentId, askedItem(body), "Can we give a VAT invoice?")
                : url.startsWith("/loops/agent")
                  ? loops.apply(parseWorkspaceLoopAction(JSON.parse(body)), AGENT)
                  : loops.apply(parseWorkspaceLoopAction(JSON.parse(body)), owner);
            response.end(JSON.stringify(answer));
          } catch (error) {
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
          return;
        }
        if (url !== "/" && !url.startsWith("/?")) return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await server.transformIndexHtml("/", HARNESS));
      });
    },
  };
}

const server = await createServer({
  root: ROOT,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  plugins: [harness(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: { entries: ["src/renderer/stories/loops-harness.tsx"] },
  server: {
    host: "127.0.0.1",
    port: Number(option("port") ?? 0),
    strictPort: false,
    fs: { strict: false },
    hmr: false,
  },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
const base = `http://127.0.0.1:${address.port}/`;

if (process.argv.includes("--serve")) {
  process.stdout.write(`serving ${base}\n`);
  await new Promise(() => undefined);
}

let browser: Browser | null = null;
const errors: string[] = [];
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures += 1;
  process.stdout.write(
    `${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` ${JSON.stringify(detail)}`}\n`,
  );
}

async function open(viewport: keyof typeof VIEWPORTS, query = ""): Promise<Page> {
  if (!browser) throw new Error("no browser");
  const context = await browser.newContext(VIEWPORTS[viewport]);
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(`${viewport}: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${viewport}: ${error.message}`));
  await page.goto(`${base}${query}`);
  return page;
}

try {
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(option("browser-executable") ? { executablePath: option("browser-executable") } : {}),
  });
  const created = loops.apply({ kind: "create-loop", spaceId: "uo", templateId: "affiliate-growth" }, owner);
  const loopId = created.createdId ?? "";
  check("seed loop", loopId !== "");
  const item = (title: string) => loops.board("uo").items.find((entry) => entry.title === title);
  for (const title of ["Alpha", "Beta"]) loops.apply({ kind: "save-item", loopId, title }, owner);

  // An item's unsaved values stay with that item: opening another item neither shows nor saves them.
  {
    const page = await open("desktop");
    const panel = page.locator("aside.ws-loops-panel");
    const field = (label: string) => panel.locator(".ws-loops-fields > *", { hasText: label }).locator("input");
    await page.locator(".ws-loops-card", { hasText: "Alpha" }).click();
    await field("Product ID").fill("ALPHA-1");
    await page.locator(".ws-loops-card", { hasText: "Beta" }).click();
    await panel.and(page.getByLabel("Beta")).waitFor({ timeout: UI_WAIT_MS });
    check("another item shows its own value", (await field("Product ID").inputValue()) === "");
    check("another item has nothing to save", !(await panel.getByRole("button", { name: "Save" }).isVisible()));
    await page.locator(".ws-loops-card", { hasText: "Alpha" }).click();
    check("the item keeps its unsaved value", (await field("Product ID").inputValue()) === "ALPHA-1");
    await panel.getByRole("button", { name: "Save" }).click();
    await panel.getByRole("button", { name: "Save" }).waitFor({ state: "hidden", timeout: UI_WAIT_MS });
    check("the value is saved to its item", item("Alpha")?.values.product_id === "ALPHA-1", item("Alpha")?.values);
    check("no value goes to another item", item("Beta")?.values.product_id === undefined, item("Beta")?.values);
    await page.context().close();
  }
} finally {
  await browser?.close();
  await server.close();
  database.close?.();
  rmSync(data, { recursive: true, force: true });
}
// Kobalte's polymorphic trigger reads a prop outside a tracking scope in every tooltip: not this view's.
const realErrors = errors.filter((entry) => !entry.includes("[vite]") && !entry.includes("@kobalte/core"));
check("no console errors", realErrors.length === 0, realErrors);
process.exit(failures === 0 ? 0 : 1);
