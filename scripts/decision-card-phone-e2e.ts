// Checks the owner decision card on a phone, in the web client: the card that the owner saw expired on
// 2026-11-26 (the Christmas campaign budget). It serves the web client on a mock host
// (`src/renderer/stories/decision-card-harness.tsx`) at every address under `/app`, as the site does,
// and drives it in Chromium with an iPhone viewport and touch. The card must say who asks and what
// happens after the choice, show each option as a button with its consequence and the recommended one
// marked, keep the ticket key and the raw address behind the technical details, offer "Responder igual"
// although the agent's call ended, and send the tapped option as the answer of that card. A card the host
// made before the lasting ids (emoji rows, a bare link in the preview, a plain UUID) draws the same way,
// and its "Responder igual" sends the owner's choice to the agent as a message.
//
// `bun scripts/decision-card-phone-e2e.ts [--headed]`
// Writes .openbot-build/decision-card-phone-e2e/report.json and a screenshot before and after the tap.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { pastDecisionRequestId } from "@openbot/contracts/ui-blocks";
import { translateFor } from "@openbot/i18n";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { chromium, devices } from "playwright-core";
import { createServer, type Plugin } from "vite";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/decision-card-phone-e2e");
const BLOCK_ID = "owner-decision.9a1d6c0e-1d1c-4bb0-9a43-1e7c1f3e0a25";
const spanish = translateFor("es");
const HARNESS = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Atelier web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/decision-card-harness.tsx"></script>
  </body>
</html>`;

/** The messages the harness recorded, as the page wrote them. */
function sentMessages(value: unknown): { agentId: string; text: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isDynamicRecord(entry) && isString(entry.agentId) && isString(entry.text)
      ? [{ agentId: entry.agentId, text: entry.text }]
      : [],
  );
}

function harnessPages(): Plugin {
  return {
    name: "openbot-decision-card-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "/";
        if (url !== "/app" && !url.startsWith("/app/") && !url.startsWith("/app?")) return next();
        const html = await server.transformIndexHtml(url, HARNESS);
        response.setHeader("Content-Type", "text/html");
        response.end(html);
      });
    },
  };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
}

const server = await createServer({
  root: ROOT,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  plugins: [harnessPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: { entries: ["src/renderer/stories/decision-card-harness.tsx"], include: ["@norbert_bodziony/bloub"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
let failure: string | null = null;
try {
  const iphone = devices["iPhone 13"];
  assert.ok(iphone, "Playwright has no iPhone 13 descriptor.");
  const { defaultBrowserType: _engine, ...phone } = iphone;
  const context = await browser.newContext(phone);
  const opened: string[] = [];
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/u, (route) => {
    opened.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${origin}/app/general/dm/chief`, { waitUntil: "commit" });
  const cards = page.locator("article.ui-block-decision");
  await cards.first().waitFor({ state: "visible", timeout: 120_000 });
  // The chat ends with the new card; the legacy card is the one above it.
  const card = cards.last();
  const legacyCard = cards.first();
  check("two decision cards, the legacy one too", (await cards.count()) === 2, await cards.count());
  await card.scrollIntoViewIfNeeded();
  await card.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(OUT, "before-top.png") });
  await card.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await page.screenshot({ path: resolve(OUT, "before-bottom.png") });

  const width = await page.evaluate(() => innerWidth);
  const box = await card.boundingBox();
  check("phone width", width <= 430, width);
  check("the card fits the phone", box !== null && box.width <= width, box);

  const text = (await card.innerText()).replace(/\s+/gu, " ");
  check(
    "says who asks",
    text.includes(spanish("uiBlock.decision.askedBy", { name: "CSO - Director de Ventas" })),
    text,
  );
  check(
    "says what happens after the choice",
    text.includes("Cuando elijas, CSO - Director de Ventas recibe tu respuesta"),
  );
  check("says the card still takes an answer", text.includes(spanish("uiBlock.decision.answerAnyway")));
  check("does not say nobody answered", !text.includes(spanish("uiBlock.outcome.expired")));
  check("does not show the expired badge", !text.includes(spanish("uiBlock.status.expired")));
  check("no raw ticket key or address outside the details", !text.includes("COC-25") && !text.includes("adsmanager"));
  check("no emoji or # rows", !text.includes("💰") && !/(^|\s)#(\s|:)/u.test(text));
  const details = card.locator("details.ui-decision-technical");
  check("technical details are closed", (await details.getAttribute("open")) === null);

  const options = card.locator("button.ui-decision-option");
  check("three option buttons", (await options.count()) === 3, await options.count());
  const first = options.nth(0);
  const firstText = ((await first.innerText()) ?? "").replace(/\s+/gu, " ");
  check(
    "the first option shows its consequence and is marked recommended",
    firstText.includes("3 USD al día del 1 al 9") && firstText.includes(spanish("uiBlock.decision.recommended")),
    firstText,
  );
  const secondText = ((await options.nth(1).innerText()) ?? "").replace(/\s+/gu, " ");
  check(
    "the other options are not marked",
    !secondText.includes(spanish("uiBlock.decision.recommended")) && secondText.includes("Mismo gasto diario"),
    secondText,
  );
  const tapHeight = (await first.boundingBox())?.height ?? 0;
  check("option buttons are tall enough to tap", tapHeight >= 44, tapHeight);
  check("options are enabled", await first.isEnabled());

  const link = card.locator("button.ui-decision-link");
  check(
    "the link is a labelled button",
    (await link.innerText()).trim() === "Ver campaña en Meta",
    await link.innerText(),
  );
  await link.tap();
  await page.waitForFunction(() => true);

  await details.locator("summary").tap();
  const detailsText = (await details.innerText()).replace(/\s+/gu, " ");
  check(
    "the details hold the ticket and the address",
    detailsText.includes("COC-25") && detailsText.includes("adsmanager"),
  );

  await first.tap();
  await page.waitForFunction(() => document.documentElement.dataset.decisionAnswers !== undefined, null, {
    timeout: 15_000,
  });
  const sent = await page.locator("html").getAttribute("data-decision-answers");
  check(
    "the tap answers this card through its lasting id",
    sent ===
      JSON.stringify([
        { requestId: pastDecisionRequestId(BLOCK_ID), answers: { action: ["125 USD: 3/día y luego 7"] } },
      ]),
    sent,
  );
  await card.locator(".ui-block-outcome[data-status='answered']").waitFor({ state: "visible" });
  const after = (await card.innerText()).replace(/\s+/gu, " ");
  check(
    "the card shows the answer and no buttons",
    after.includes("125 USD: 3/día y luego 7") && (await options.count()) === 0,
    after,
  );
  await card.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: resolve(OUT, "after.png") });
  check(
    "the link went to the campaign",
    opened.some((url) => url.startsWith("https://adsmanager.facebook.com/")),
    opened,
  );

  // The legacy card: the same layout, and an answer that goes as a message.
  await legacyCard.evaluate((element) => element.scrollIntoView({ block: "start" }));
  // A row far from the view is not drawn until it is in it: its text reads as empty before that.
  await legacyCard.locator("button.ui-decision-option").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(OUT, "legacy-before.png") });
  const legacyText = (await legacyCard.innerText()).replace(/\s+/gu, " ");
  check(
    "legacy: no emoji, arrow or # rows",
    !/[💰⏱→]/u.test(legacyText) && !/(^|\s)#(\s|:)/u.test(legacyText),
    legacyText,
  );
  check("legacy: the amount shows", legacyText.includes("125 USD"), legacyText);
  check(
    "legacy: says who asks",
    legacyText.includes(spanish("uiBlock.decision.askedBy", { name: "Chief" })),
    legacyText,
  );
  check("legacy: the option shows its consequence", legacyText.includes("La cuenta queda lista"), legacyText);
  check(
    "legacy: no raw ticket key or address outside the details",
    !legacyText.includes("EVE-40") && !legacyText.includes("adsmanager"),
  );
  check("legacy: offers Responder igual", legacyText.includes(spanish("uiBlock.decision.answerAnyway")));
  const legacyLink = legacyCard.locator("button.ui-decision-link");
  check(
    "legacy: the bare link is a labelled button",
    (await legacyLink.innerText()).trim() === "Ver campaña en Meta",
    await legacyLink.innerText(),
  );
  const legacyDetails = legacyCard.locator("details.ui-decision-technical");
  check("legacy: technical details are closed", (await legacyDetails.getAttribute("open")) === null);
  await legacyDetails.locator("summary").tap();
  check("legacy: the details hold the ticket", (await legacyDetails.innerText()).includes("EVE-40"));
  await legacyCard.locator("button.ui-decision-option").first().tap();
  await page.waitForFunction(() => document.documentElement.dataset.decisionMessages !== undefined, null, {
    timeout: 15_000,
  });
  const messages = sentMessages(
    JSON.parse((await page.locator("html").getAttribute("data-decision-messages")) ?? "[]"),
  );
  check(
    "legacy: the tap sends the decision to the asking agent as a message",
    messages.length === 1 &&
      messages[0]?.agentId === "chief" &&
      messages[0].text ===
        spanish("uiBlock.decision.lateMessage", {
          title: "¿Acepto las condiciones de Meta para «Moño y Confeti»?",
          answer: "Aceptar y crear",
        }),
    messages,
  );
  await legacyCard.locator(".ui-block-outcome[data-status='answered']").waitFor({ state: "visible" });
  await page.screenshot({ path: resolve(OUT, "legacy-after.png") });
  await context.close();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await browser.close();
  await server.close();
}
const ok = failure === null && checks.every((entry) => entry.ok);
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ ok, failure, checks }, null, 2)}\n`);
for (const entry of checks) process.stdout.write(`${entry.ok ? "ok  " : "FAIL"} ${entry.name}\n`);
if (failure) process.stdout.write(`error: ${failure}\n`);
process.exit(ok ? 0 : 1);
