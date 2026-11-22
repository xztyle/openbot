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
    // Every error, and the warnings of this view's code: Solid's diagnostics name the file they come from.
    const text = message.text();
    const ours = /UNCOMMITTED_INPUT_OVERWRITTEN|at \S*\/(Loop\w*|WorkspaceLoops|loops-harness)\.tsx/u.test(text);
    if (message.type() === "error" || (message.type() === "warning" && ours)) errors.push(`${viewport}: ${text}`);
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

  // Money and number fields store numbers as people type them on a phone, and refuse text.
  {
    const page = await open("phone");
    const panel = page.locator("aside.ws-loops-panel");
    const field = (label: string) =>
      panel.locator(".ws-loops-fields > *", { hasText: new RegExp(`^${label}`, "u") }).locator("input");
    await page.locator(".ws-loops-card", { hasText: "Beta" }).click();
    await field("Commission").fill("1,200");
    await field("Spend").fill("12,5");
    await field("Price").fill("$49");
    await field("Sales").fill("three");
    await panel.getByRole("button", { name: "Save" }).click();
    await panel.getByText("Sales: type a number").waitFor({ timeout: UI_WAIT_MS });
    check("text in a number field is refused", item("Beta")?.values.sales === undefined, item("Beta")?.values);
    await field("Sales").fill("3");
    await panel.getByRole("button", { name: "Save" }).click();
    await panel.getByRole("button", { name: "Save" }).waitFor({ state: "hidden", timeout: UI_WAIT_MS });
    const values = item("Beta")?.values;
    check(
      "typed amounts are stored as numbers",
      values?.commission_usd === 1200 && values.spend_usd === 12.5 && values.price_usd === 49 && values.sales === 3,
      values,
    );
    check("the refusal goes once the values are numbers", !(await panel.getByText("type a number").isVisible()));
    await page.context().close();
  }

  // The loop editor: a checklist takes new lines and spaces as typed, a metric that is not a rule
  // stays to be fixed with the reason, and Escape asks before it throws the changes away.
  {
    const page = await open("desktop");
    await page.getByRole("button", { name: "Edit loop" }).click();
    const editor = page.getByRole("dialog", { name: "Edit loop" });
    const checklist = editor.getByRole("textbox", { name: "Checklist to leave" });
    const metrics = editor.getByRole("textbox", { name: "Metrics to leave" });
    await checklist.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\nPixel installed ok", { delay: 5 });
    check(
      "the checklist keeps typed lines and spaces",
      (await checklist.inputValue()).endsWith("Producer rules read\nPixel installed ok"),
      await checklist.inputValue(),
    );
    await metrics.fill("sales >= one");
    await editor.getByText("Not a rule on a field of this loop: sales >= one").waitFor({ timeout: UI_WAIT_MS });
    check("a wrong metric blocks Save", await editor.getByRole("button", { name: "Save" }).isDisabled());
    await editor.getByRole("button", { name: /^Validate/u }).click();
    check("another stage has its own metrics", (await metrics.inputValue()) === "");
    await editor.getByRole("button", { name: /^Scout/u }).click();
    check("a wrong metric stays to be fixed", (await metrics.inputValue()) === "sales >= one");
    await metrics.fill("sales >= 1");
    await page.keyboard.press("Escape");
    const discard = page.getByRole("alertdialog", { name: "Discard changes?" });
    await discard.waitFor({ timeout: UI_WAIT_MS });
    await discard.getByRole("button", { name: "Keep editing" }).click();
    check("Keep editing keeps the editor", (await checklist.inputValue()).endsWith("Pixel installed ok"));
    await editor.getByRole("button", { name: "Save" }).click();
    await editor.waitFor({ state: "hidden", timeout: UI_WAIT_MS });
    const scout = loops.board("uo").loops[0]?.stages.find((stage) => stage.id === "scout");
    check("the checklist is stored line by line", scout?.checklist?.at(-1) === "Pixel installed ok", scout?.checklist);
    check(
      "the metric is stored",
      JSON.stringify(scout?.exitMetrics) === JSON.stringify([{ field: "sales", op: ">=", value: 1 }]),
      scout?.exitMetrics,
    );
    await page.getByRole("button", { name: "Edit loop" }).click();
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "hidden", timeout: UI_WAIT_MS });
    check("Escape closes an unchanged editor at once", (await page.getByRole("alertdialog").count()) === 0);
    await page.context().close();
  }

  // A second loop, with an item that asks the owner a question.
  const inbox = loops.apply(
    {
      kind: "create-loop",
      spaceId: "uo",
      definition: {
        name: "Customer inbox",
        fields: [],
        stages: [
          { id: "start", name: "New" },
          { id: "review", name: "Review" },
          { id: "closed", name: "Closed", outcome: "done" },
        ],
      },
    },
    owner,
  );
  const inboxId = inbox.createdId ?? "";
  const ticket = loops.apply({ kind: "save-item", loopId: inboxId, title: "Invoice request" }, owner);
  const question = loops.escalate(AGENT.agentId, ticket.createdId ?? "", "Can we give a VAT invoice?");

  // A link that opens a decision while the board already shows another loop: its loop and card show,
  // and the return key of the phone's keyboard sends the answer.
  {
    const page = await open("phone");
    await page.locator(".ws-loops-card").first().waitFor({ timeout: UI_WAIT_MS });
    const tab = page.locator(".ws-loops-tabs").getByRole("button", { name: /^Customer inbox/u });
    check("the board starts on the first loop", (await tab.getAttribute("aria-pressed")) === "false");
    // `window.harness` of `loops-harness.tsx`, as a link from Today opens the decision.
    await page.evaluate(`window.harness.open(${JSON.stringify(inboxId)}, ${JSON.stringify(question.id)})`);
    const card = page.locator(".ws-loops-decision[data-focused]");
    await card.waitFor({ timeout: UI_WAIT_MS });
    check("the link shows the decision's loop", (await tab.getAttribute("aria-pressed")) === "true");
    await page.waitForTimeout(300);
    check(
      "the decision is in view",
      await card.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
      }),
    );
    await card.getByRole("textbox").fill("Yes, with VAT");
    await card.getByRole("textbox").press("Enter");
    await card.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    const answered = loops.board("uo").decisions.find((entry) => entry.id === question.id);
    check("Enter sends the answer", answered?.status === "approved" && answered.note === "Yes, with VAT", answered);
    await page.context().close();
  }

  // A phone shows a column after the stage it showed is removed, and a dialog opens without the
  // error of an earlier action.
  {
    const page = await open("phone");
    await page
      .locator(".ws-loops-tabs")
      .getByRole("button", { name: /^Customer inbox/u })
      .click();
    await page
      .locator(".ws-loops-stage-picker")
      .getByRole("button", { name: /^Review/u })
      .click();
    await page.getByRole("button", { name: "Edit loop" }).click();
    const editor = page.getByRole("dialog", { name: "Edit loop" });
    await editor
      .locator(".ws-loops-flow")
      .getByRole("button", { name: /^Review/u })
      .click();
    await editor.getByRole("button", { name: "Remove stage" }).click();
    await editor.getByRole("button", { name: "Save" }).click();
    await editor.waitFor({ state: "hidden", timeout: UI_WAIT_MS });
    check("the stage is removed", loops.board("uo").loops.find((entry) => entry.id === inboxId)?.stages.length === 2);
    check("a column shows", (await page.locator("section.ws-loops-column:visible").count()) === 1);
    check(
      "its stage tab is the shown one",
      (await page.locator(".ws-loops-stage-picker [aria-pressed=true]").textContent())?.startsWith("New") === true,
    );
    // The item goes behind the view's back, as when an agent removes it: the next action fails.
    await page.locator(".ws-loops-card", { hasText: "Invoice request" }).click();
    loops.apply({ kind: "remove-item", itemId: ticket.createdId ?? "" }, owner);
    await page.locator("aside.ws-loops-panel").getByRole("button", { name: "Remove item" }).click();
    await page.locator("aside.ws-loops-panel [role=alert]").waitFor({ timeout: UI_WAIT_MS });
    await page.locator("aside.ws-loops-panel").getByRole("button", { name: "Close" }).first().click();
    await page.getByRole("button", { name: "Edit loop" }).click();
    await page.getByRole("dialog", { name: "Edit loop" }).waitFor({ timeout: UI_WAIT_MS });
    check(
      "the editor opens without an earlier error",
      (await page.getByRole("dialog", { name: "Edit loop" }).locator(".ui-form-dialog-error, [role=alert]").count()) ===
        0,
    );
    await page.context().close();
  }
} finally {
  await browser?.close();
  await server.close();
  database.close?.();
  rmSync(data, { recursive: true, force: true });
}
const realErrors = errors.filter((entry) => !entry.includes("[vite]"));
check("no console errors", realErrors.length === 0, realErrors);
process.exit(failures === 0 ? 0 : 1);
