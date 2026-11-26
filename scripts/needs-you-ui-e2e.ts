// Checks "Needs you" in the web client on a computer and on an iPhone. Chief gave Sales Outbound work,
// and the reader wrote only to Chief, so Sales Outbound has no DM row. The script acts as the host
// (`src/renderer/stories/web-client-needsyou-harness.tsx`): Sales Outbound asks the reader to sign in
// on accounts.google.com in a browser tab, with the events that `scripts/needs-you-host-e2e.ts` sees
// a real host send (the request, its escalation to Chief, and `agent-attention-changed`).
//
// Computer: the Sales Outbound row shows with the Needs you mark; the top bar has "Needs you" with the
// count; Chief's "Waiting for replies" row says what to do and where, with Take over; Today lists the
// request; a row of the top bar list opens Sales Outbound's chat with the takeover card in view; "I'm
// done" answers it once, and every mark goes. iPhone: the Today tab counts it; the card's Take over
// opens the chat with the card in view; "I'm done" clears Today.
//
// Money approval, on the computer and the phone: the trust card of a Meta ads call shows the agent's
// purpose first, then the fixed action line and the amount; the raw call stays behind the collapsed
// technical details.
//
// `bun scripts/needs-you-ui-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/needs-you-ui-e2e/report.json and a screenshot of each checked screen.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("needs-you-ui-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/needs-you-ui-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");
const SITE = "accounts.google.com";

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
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
    <script type="module" src="/src/renderer/stories/web-client-needsyou-harness.tsx"></script>
  </body>
</html>`;

/** Serves the harness page at `/app` and every address under it, as the site's `/app/$` route does. */
function webClientPages(): Plugin {
  return {
    name: "openbot-needs-you-harness",
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

/** The first load: Vite may still optimise the dependencies, so a blank page loads once more. */
async function load(page: Page, origin: string, path: string, ready: Locator): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${origin}${path}`, { waitUntil: "commit" });
    if (
      await ready.waitFor({ timeout: UI_WAIT_MS / 2 }).then(
        () => true,
        () => false,
      )
    )
      return;
  }
  await ready.waitFor({ timeout: UI_WAIT_MS });
}

const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: typeof name === "string" });
const needsYouTitle = english("workspace.needsYou.title");
/** A sidebar row of an agent, with the Needs you mark in its name or without. */
const agentRow = (page: Page, name: string) =>
  page.locator("[data-ws-conversation]").filter({ hasText: new RegExp(`^${name}`, "u") });
const markedRow = (page: Page, name: string) =>
  page.locator(`[data-ws-conversation][data-needs-you]`).filter({ hasText: new RegExp(`^${name}`, "u") });
const card = (page: Page) => page.getByText(english("prompt.browser.title.pending", { host: SITE }));
/** The request's card in Today. */
const todayCard = (page: Page, what: string) =>
  page.getByRole("article", { name: english("workspace.needsYou.rowLabel", { name: "Sales Outbound", action: what }) });
/** The Today tab of the phone, with the count of what waits. */
const todayTab = (page: Page, count: number) =>
  page.getByRole("navigation", { name: english("workspace.phone.tabs") }).getByRole("button", {
    name:
      count > 0
        ? `${english("workspace.view.today")}, ${english("workspace.phone.waiting", { count })}`
        : english("workspace.view.today"),
    exact: true,
  });
const action = english("workspace.needsYou.action.takeoverAt", { site: SITE });

async function request(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.dataset.needsYouReady !== undefined, null, {
    timeout: UI_WAIT_MS,
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("needs-you-harness", { detail: "request" })));
}

/** The element is inside its scroller's view, not under the fold. */
async function inView(page: Page, target: Locator): Promise<void> {
  const handle = await target.elementHandle({ timeout: UI_WAIT_MS });
  assert.ok(handle, "The element is not on the page.");
  await page.waitForFunction(
    (element) => {
      const scroller = element.closest(".conversation-scroll");
      if (!scroller) return false;
      const box = element.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
    },
    handle,
    { timeout: UI_WAIT_MS },
  );
}

async function answered(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.documentElement.dataset.needsYouAnswered ?? 0));
}

async function desktop(browser: Browser, origin: string): Promise<void> {
  const viewport = "desktop";
  const context = await browser.newContext(VIEWPORTS.desktop);
  const page = await context.newPage();
  watch(page, viewport);

  await step(page, viewport, "Sales Outbound has no DM row before it needs the reader", async () => {
    await load(page, origin, "/app/general/dm/chief", agentRow(page, "Chief"));
    assert.equal(await agentRow(page, "Sales Outbound").count(), 0, "Sales Outbound has a row before it asks.");
    assert.equal(await button(page, new RegExp(needsYouTitle, "u")).count(), 0, "Needs you shows with nothing.");
    await shot(page, "desktop-before");
  });

  await step(
    page,
    viewport,
    "the request shows the row with its mark, the top bar count and the waiting row",
    async () => {
      await request(page);
      await markedRow(page, "Sales Outbound").waitFor({ timeout: UI_WAIT_MS });
      await markedRow(page, "Chief").waitFor({ timeout: UI_WAIT_MS });
      await page
        .getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 1 }) })
        .waitFor({ timeout: UI_WAIT_MS });
      const waiting = page.locator(".awaiting-replies-item").filter({ hasText: "Sales Outbound" });
      await waiting.getByText(action).waitFor({ timeout: UI_WAIT_MS });
      await button(waiting, new RegExp(english("sidebar.waiting.action.takeover"), "u")).waitFor({
        timeout: UI_WAIT_MS,
      });
      await shot(page, "desktop-request");
    },
  );

  await step(page, viewport, "Today lists the request", async () => {
    await page
      .locator("[data-ws-row]")
      .filter({ hasText: english("workspace.view.today") })
      .first()
      .click();
    await todayCard(page, action).waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "desktop-today");
  });

  await step(page, viewport, "a row of the top bar list opens the chat with the card in view", async () => {
    await page.getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 1 }) }).click();
    const dialog = page.getByRole("dialog");
    await shot(page, "desktop-list");
    await dialog
      .getByRole("button", { name: english("workspace.needsYou.rowLabel", { name: "Sales Outbound", action }) })
      .click();
    // The card is taller than a laptop's chat; its actions are what must show.
    await inView(page, button(page, english("prompt.browser.done")));
    await shot(page, "desktop-card");
  });

  await step(page, viewport, "I'm done answers once, and every mark goes", async () => {
    await button(page, english("prompt.browser.done")).click();
    await page.waitForFunction(() => Number(document.documentElement.dataset.needsYouAnswered ?? 0) > 0, null, {
      timeout: UI_WAIT_MS,
    });
    await page
      .getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 1 }) })
      .waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await page
      .locator("[data-ws-conversation][data-needs-you]")
      .first()
      .waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await card(page).waitFor({ state: "detached", timeout: UI_WAIT_MS });
    assert.equal(await answered(page), 1, "The card answered more than once.");
    await shot(page, "desktop-cleared");
  });
  await context.close();
}

async function phone(browser: Browser, origin: string): Promise<void> {
  const viewport = "phone";
  const context = await browser.newContext(VIEWPORTS.phone);
  const page = await context.newPage();
  watch(page, viewport);
  await step(page, viewport, "Today counts the request once Sales Outbound asks", async () => {
    await load(page, origin, "/app/general", todayTab(page, 0));
    await request(page);
    await todayTab(page, 1).waitFor({ timeout: UI_WAIT_MS });
    await todayCard(page, action).waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "phone-today");
  });

  await step(page, viewport, "the card's Take over opens the chat with the card in view", async () => {
    await todayCard(page, action)
      .getByRole("button", { name: new RegExp(`^${english("workspace.today.takeOver")}`, "u") })
      .tap();
    await inView(page, card(page));
    await inView(page, button(page, english("prompt.browser.done")));
    await shot(page, "phone-card");
  });

  await step(page, viewport, "I'm done clears Today", async () => {
    await button(page, english("prompt.browser.done")).tap();
    await page.waitForFunction(() => Number(document.documentElement.dataset.needsYouAnswered ?? 0) > 0, null, {
      timeout: UI_WAIT_MS,
    });
    await card(page).waitFor({ state: "detached", timeout: UI_WAIT_MS });
    // Back goes to Today, where the request is gone too, and the tab has no count.
    await button(page, english("workspace.layout.back")).first().tap();
    await todayTab(page, 0).waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await todayCard(page, action).count(), 0, "Today keeps the answered request.");
    await shot(page, "phone-cleared");
  });
  await context.close();
}

/**
 * A Motion ticket that asks the reader to approve, on a phone, where the browser client has no desktop
 * preload: Approve on Today's card sends the reader's message to the agent and answers the ticket.
 */
async function ticketApproval(browser: Browser, origin: string): Promise<void> {
  const viewport = "phone";
  const context = await browser.newContext(VIEWPORTS.phone);
  const page = await context.newPage();
  watch(page, viewport);
  const ticketAction = english("workspace.needsYou.action.ticket");
  await step(page, viewport, "Approve on a Motion ticket's card sends the answer", async () => {
    await load(page, origin, "/app/general", todayTab(page, 0));
    await page.waitForFunction(() => document.documentElement.dataset.needsYouReady !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("needs-you-harness", { detail: "ticket" })));
    const ticketCard = todayCard(page, ticketAction);
    await ticketCard.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, "phone-ticket");
    await button(ticketCard, english("workspace.needsYou.ticket.approve")).tap();
    await page.waitForFunction(() => document.documentElement.dataset.needsYouTicket !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
    const sent = await page.evaluate(() => document.documentElement.dataset.needsYouSent ?? "");
    assert.match(sent, /^sales: .*MAN-5.*Approved\./u, "The agent did not get the approval.");
    const answers = await page.evaluate(() => document.documentElement.dataset.needsYouTicket ?? "");
    // The answer says what it decides, so the host answers the ticket's decision card the same way.
    assert.deepEqual(JSON.parse(answers), {
      answer: [english("workspace.needsYou.ticket.approved")],
      decision: ["approve"],
    });
    assert.equal(await page.getByText(english("workspace.today.answerFailed")).count(), 0, "The card says it failed.");
    await shot(page, "phone-ticket-approved");
  });
  await context.close();
}

/**
 * A ticket whose title asks nothing, which a manager passed to the reader after the grader's three
 * reviews: the card says it in plain words, the raw reason only behind "Technical details", and Send
 * back takes a note that goes to the agent and the ticket.
 */
async function ticketReview(browser: Browser, origin: string): Promise<void> {
  const viewport = "phone";
  const context = await browser.newContext(VIEWPORTS.phone);
  const page = await context.newPage();
  watch(page, viewport);
  const ticketAction = english("workspace.needsYou.action.ticket");
  await step(page, viewport, "Send back on an escalated review takes a note", async () => {
    await load(page, origin, "/app/general", todayTab(page, 0));
    await page.waitForFunction(() => document.documentElement.dataset.needsYouReady !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("needs-you-harness", { detail: "ticket-review" })));
    const ticketCard = todayCard(page, ticketAction);
    await ticketCard.waitFor({ timeout: UI_WAIT_MS });
    // The card says it in plain words (docs/approvals.md); the raw reason waits behind the collapsed
    // technical details until the reader opens them.
    await ticketCard.getByText("Do you accept the ad research as it is?").waitFor({ timeout: UI_WAIT_MS });
    await ticketCard.getByText("Lead passed this to you.", { exact: false }).waitFor({ timeout: UI_WAIT_MS });
    const technical = ticketCard.getByText("Courses advertised with evidence", { exact: false });
    assert.equal(await technical.isVisible(), false, "The technical reason shows before the reader asks for it.");
    await ticketCard.getByText(english("workspace.today.technicalDetails")).tap();
    await technical.waitFor({ timeout: UI_WAIT_MS });
    assert.equal(
      await button(ticketCard, english("workspace.needsYou.ticket.acceptAsIs")).count(),
      1,
      "The escalated review has no Accept as is.",
    );
    await shot(page, "phone-ticket-review");
    const sendBack = english("workspace.needsYou.ticket.sendBack");
    await button(ticketCard, sendBack).first().tap();
    const note = ticketCard.getByLabel(english("workspace.today.noteLabel"));
    await note.waitFor({ timeout: UI_WAIT_MS });
    await note.fill("Paste the table of ads");
    await button(ticketCard, sendBack).last().tap();
    await page.waitForFunction(() => document.documentElement.dataset.needsYouTicket !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
    const sent = await page.evaluate(() => document.documentElement.dataset.needsYouSent ?? "");
    assert.match(sent, /^sales: .*COC-44.*Paste the table of ads/u, "The agent did not get the note.");
    const answers = await page.evaluate(() => document.documentElement.dataset.needsYouTicket ?? "");
    assert.deepEqual(JSON.parse(answers), {
      answer: [english("workspace.needsYou.ticket.sentBack", { note: "Paste the table of ads" })],
      decision: ["decline"],
      verdict: ["send-back"],
    });
    await shot(page, "phone-ticket-sent-back");
  });
  await context.close();
}

const secretAction = english("workspace.needsYou.action.secretAt", { site: SITE });
const secretTitle = () => english("browser.secret.title.code");

/**
 * `submit_secret`: Sales Outbound asks for a 6-digit SMS code. "Needs you" lists it, a row opens the
 * chat with the secure card in view, and the typed code goes to the runtime's secret answer once.
 */
async function secretCard(browser: Browser, origin: string, viewport: ViewportName): Promise<void> {
  const context = await browser.newContext(VIEWPORTS[viewport]);
  const page = await context.newPage();
  watch(page, viewport);
  const tap = (target: Locator) => (viewport === "phone" ? target.tap() : target.click());

  await step(page, viewport, "a secret request shows in Needs you", async () => {
    await load(
      page,
      origin,
      viewport === "phone" ? "/app/general" : "/app/general/dm/chief",
      viewport === "phone" ? todayTab(page, 0) : page.locator("[data-ws-conversation]").first(),
    );
    await page.waitForFunction(() => document.documentElement.dataset.needsYouReady !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("needs-you-harness", { detail: "secret" })));
    if (viewport === "phone") {
      // A phone opens on Today: the request's card is there, with Take over.
      const today = todayCard(page, secretAction);
      await today.waitFor({ timeout: UI_WAIT_MS });
      await shot(page, `${viewport}-secret-list`);
      await tap(today.getByRole("button", { name: new RegExp(`^${english("workspace.today.takeOver")}`, "u") }));
      return;
    }
    await markedRow(page, "Sales Outbound").waitFor({ timeout: UI_WAIT_MS });
    await page.getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 1 }) }).click();
    const row = page.getByRole("button", {
      name: english("workspace.needsYou.rowLabel", { name: "Sales Outbound", action: secretAction }),
    });
    await row.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-secret-list`);
    await tap(row);
  });

  await step(page, viewport, "the chat shows the secure code card in view", async () => {
    await inView(page, button(page, english("browser.secret.submit")));
    await shot(page, `${viewport}-secret-card`);
  });

  await step(page, viewport, "the typed code goes to the secret answer once, and the card goes", async () => {
    await page.getByLabel(english("browser.secret.codeLength", { digits: 6 }), { exact: true }).focus();
    await page.keyboard.type("482913");
    await tap(button(page, english("browser.secret.submit")));
    await page.waitForFunction(() => document.documentElement.dataset.needsYouSecrets !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.needsYouSecrets), "482913");
    await page.getByText(secretTitle()).first().waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-secret-cleared`);
  });
  await context.close();
}

/**
 * The live case: Sales Outbound's turn runs, and its event stream stalls while reads still work, so
 * the secret request and the requested runtime snapshot never come. The silent-turn check finds the
 * missing snapshot and replaces the connection; the new stream brings the card.
 */
async function stalledSecret(browser: Browser, origin: string): Promise<void> {
  const viewport = "desktop";
  const context = await browser.newContext(VIEWPORTS.desktop);
  const page = await context.newPage();
  watch(page, viewport);
  await step(page, viewport, "a stalled event stream is replaced, and the secret card shows", async () => {
    await load(page, origin, "/app/general/dm/sales?stall", page.locator("[data-ws-conversation]").first());
    await page.waitForFunction(() => document.documentElement.dataset.needsYouStalled !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
    // 30 s of silence, the check every 5 s, then 10 s for the snapshot that does not come.
    await page.waitForFunction(() => document.documentElement.dataset.needsYouReplaced !== undefined, null, {
      timeout: 120_000,
    });
    assert.ok(
      Number(await page.evaluate(() => document.documentElement.dataset.needsYouSnapshotRequests ?? 0)) > 0,
      "The silent-turn check did not ask for the runtime snapshot first.",
    );
    await inView(page, button(page, english("browser.secret.submit")));
    await page.getByRole("button", { name: english("workspace.needsYou.buttonLabel", { count: 1 }) }).waitFor({
      timeout: UI_WAIT_MS,
    });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.needsYouReplaced), "1");
    await shot(page, "desktop-stalled-secret");
  });
  await context.close();
}

const MONEY_PURPOSE = "Quiero aprobación para revisar los topes de la campaña y modificarlos si superan los 7 USD.";
const MONEY_RAW = "--daily-budget 7";

/**
 * A money approval of the trust gate: the chat card (computer) and Today's card (phone) show what the
 * agent wants first, then the fixed action line and the amount, and the raw call only on request.
 */
async function moneyApproval(browser: Browser, origin: string, viewport: ViewportName): Promise<void> {
  const context = await browser.newContext(VIEWPORTS[viewport]);
  const page = await context.newPage();
  watch(page, viewport);
  await step(page, viewport, "a money approval shows the agent's purpose, the action and the amount", async () => {
    await load(
      page,
      origin,
      viewport === "phone" ? "/app/general" : "/app/general/dm/sales",
      viewport === "phone" ? todayTab(page, 0) : page.locator("[data-ws-conversation]").first(),
    );
    await page.waitForFunction(() => document.documentElement.dataset.needsYouReady !== undefined, null, {
      timeout: UI_WAIT_MS,
    });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("needs-you-harness", { detail: "money-approval" })));
    const cardOf =
      viewport === "phone"
        ? todayCard(page, english("workspace.needsYou.action.approval"))
        : page.getByRole("region", { name: english("prompt.approval.label") });
    const moneyCard = cardOf.first();
    await moneyCard.waitFor({ timeout: UI_WAIT_MS });
    const purpose = moneyCard.getByText(MONEY_PURPOSE, { exact: false });
    await purpose.waitFor({ timeout: UI_WAIT_MS });
    // The action line names the place in words; the tool's own name is technical and stays hidden.
    await moneyCard.getByText("Meta ads", { exact: false }).first().waitFor({ timeout: UI_WAIT_MS });
    await moneyCard.getByText("7 USD", { exact: false }).first().waitFor({ timeout: UI_WAIT_MS });
    if (viewport === "desktop")
      await moneyCard.getByText(english("prompt.approval.title.trust")).waitFor({ timeout: UI_WAIT_MS });
    // The purpose comes before the action line, and the raw call stays hidden until asked for.
    const text = (await moneyCard.innerText()).replace(/\s+/gu, " ");
    assert.ok(
      text.indexOf(MONEY_PURPOSE) >= 0 && text.indexOf(MONEY_PURPOSE) < text.indexOf("Meta ads"),
      `The purpose does not lead the card: ${text.slice(0, 400)}`,
    );
    assert.ok(!text.includes("meta-ads create-campaign"), `The tool's name shows on the card: ${text.slice(0, 400)}`);
    const raw = moneyCard.getByText(MONEY_RAW, { exact: false });
    assert.equal(await raw.isVisible(), false, "The raw call shows without being asked for.");
    const technical = moneyCard.getByText(
      viewport === "phone" ? english("workspace.today.technicalDetails") : english("prompt.approval.technical"),
    );
    await (viewport === "phone" ? technical.tap() : technical.click());
    await raw.waitFor({ state: "visible", timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-money-approval`);
  });
  await context.close();
}

function watch(page: Page, viewport: ViewportName): void {
  page.on("pageerror", (error) => report.pageErrors.push(`${viewport}: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource") &&
      !message.text().startsWith("[vite]")
    )
      report.consoleErrors.push(`${viewport}: ${message.text().slice(0, 1_000)}`);
  });
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
    entries: ["src/renderer/stories/web-client-needsyou-harness.tsx"],
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
  await desktop(browser, origin);
  await phone(browser, origin);
  await secretCard(browser, origin, "desktop");
  await secretCard(browser, origin, "phone");
  await stalledSecret(browser, origin);
  await ticketApproval(browser, origin);
  await ticketReview(browser, origin);
  await moneyApproval(browser, origin, "desktop");
  await moneyApproval(browser, origin, "phone");
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
