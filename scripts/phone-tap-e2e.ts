// Checks that every control of the browser client takes one tap on a phone. Drives the mock host
// (`src/renderer/stories/web-client-harness.tsx`) at iPhone size with touch, through every workspace view.
//
// iOS Safari drops the click of a tap when the tap's hover changes what shows: a row's More button
// fading in, message actions, a thread summary swapping its text. The owner then has to tap twice.
// Chromium does not copy that rule, so the script checks for its cause instead: for each visible
// control it hovers the control and compares the visibility of the nearby elements. A change there is
// a control that iOS would make the owner tap twice. With `--survey`, it also taps each control and
// lists the ones where the page after a tap is the same as before it: no change, or a menu that
// opened and closed again at once.
//
// `bun scripts/phone-tap-e2e.ts [--survey] [--views=today,dm/chief] [--headed]`
// Writes .openbot-build/phone-tap-e2e/report.json. Exits 1 on a hover change.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("phone-tap-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, process.env.PHONE_TAP_OUT ?? ".openbot-build/phone-tap-e2e");
const SURVEY = process.argv.includes("--survey");
const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-harness.tsx"></script>
  </body>
</html>`;

const VIEWS = [
  "today",
  "activity",
  "unreads",
  "threads",
  "later",
  "drafts",
  "fleet",
  "org",
  "agents",
  "space-agents",
  "artifacts",
  "between-agents",
  "insights",
  "knowledge",
  "loops",
  "money",
  "portfolio",
  "reviews",
  "routines",
  "schedule",
  "search",
  "secrets",
  "storage",
  "tasks",
  "trust",
  "usage",
  "settings",
  "server-settings",
  "c/general",
  "c/general/t/general-root",
  "dm/chief",
];

/** The controls a tap should act on. */
const CONTROLS =
  'button:not([disabled]), a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], summary';

function webClientPages(): Plugin {
  return {
    name: "openbot-phone-tap-harness",
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

interface Finding {
  view: string;
  control: string;
  detail: string;
}
const hoverChanges: Finding[] = [];
const deadTaps: Finding[] = [];
const stuck: Finding[] = [];
let checked = 0;

/** Loads the view. The phone shell keeps its own tab state, so an in-page address change is not enough. */
async function open(page: Page, view: string): Promise<void> {
  await page.goto(`${origin}/app/general/${view}`, { waitUntil: "commit" });
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, null, {
    timeout: 120_000,
  });
  await page.waitForTimeout(1_500);
}

/** Marks the visible controls of the screen with an index, and names them. */
async function markControls(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const names: string[] = [];
    let index = 0;
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      element.removeAttribute("data-tap-probe");
      const box = element.getBoundingClientRect();
      if (box.width < 4 || box.height < 4 || box.bottom < 0 || box.top > innerHeight) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.pointerEvents === "none") continue;
      // A toast leaves by itself: its changes are not the control's.
      if (element.closest(".ui-toast-layer")) continue;
      element.setAttribute("data-tap-probe", String(index++));
      const label =
        element.getAttribute("aria-label") ||
        element.textContent?.replace(/\s+/gu, " ").trim().slice(0, 40) ||
        element.className.toString().split(" ")[0] ||
        element.tagName;
      names.push(`${element.tagName.toLowerCase()}.${element.className.toString().split(" ")[0] || ""} "${label}"`);
    }
    return names;
  }, CONTROLS);
}

/** What shows near a control: each element of its row, with its visibility. */
async function nearby(page: Page, index: number): Promise<string[]> {
  return page.evaluate((at) => {
    const control = document.querySelector<HTMLElement>(`[data-tap-probe="${at}"]`);
    if (!control) return [];
    let row: HTMLElement = control;
    for (let step = 0; step < 4 && row.parentElement && row.parentElement !== document.body; step++)
      row = row.parentElement;
    const shown: string[] = [];
    for (const element of [row, ...row.querySelectorAll<HTMLElement>("*")]) {
      const style = getComputedStyle(element);
      shown.push(
        `${element.className.toString().split(" ")[0] ?? ""}#${style.display}|${style.visibility}|${Number(style.opacity) > 0.05 ? 1 : 0}|${element.getBoundingClientRect().width > 0 ? 1 : 0}`,
      );
    }
    return shown;
  }, index);
}

/** What a tap's hover would show on iOS: by `:hover` styles, and by touch enter handlers. */
async function hoverEffects(page: Page, index: number): Promise<{ styles: number; handlers: number }> {
  const control = page.locator(`[data-tap-probe="${index}"]`);
  // Move the pointer away, read the row, hover the control, read again.
  await page.mouse.move(1, 1);
  await page.waitForTimeout(30);
  const before = await nearby(page, index);
  await control.hover({ timeout: 2_000, force: true }).catch(() => undefined);
  await page.waitForTimeout(260);
  const after = await nearby(page, index);
  // Only what the hover shows counts, as on iOS: an element that appears or turns visible. Live
  // views also remove and fade elements by themselves.
  const shown = (value: string | undefined) => value !== undefined && /#(?!none)[^|]*\|visible\|1\|1$/u.test(value);
  // A hover style goes again when the pointer leaves. What stays after the pointer left came from
  // the view itself (a list that loaded or rendered again), not from the hover.
  await page.mouse.move(1, 1);
  await page.waitForTimeout(260);
  const away = await nearby(page, index);
  const appeared = (from: string[]) =>
    after.length !== from.length
      ? Math.max(0, after.length - from.length)
      : from.filter((value, at) => !shown(value) && shown(after[at])).length;
  const styles = Math.min(appeared(before), appeared(away));
  // The events iOS sends for a finger before the click: touch pointer events, then emulated mouse
  // events. A handler of these that adds an element anywhere (a tooltip) costs the tap its click.
  await page.mouse.move(1, 1);
  const handlers = await page.evaluate((at) => {
    const target = document.querySelector<HTMLElement>(`[data-tap-probe="${at}"]`);
    if (!target) return 0;
    const count = () => document.body.getElementsByTagName("*").length;
    const start = count();
    const touch = { bubbles: true, pointerType: "touch", isPrimary: true, pointerId: 7 };
    target.dispatchEvent(new PointerEvent("pointerover", touch));
    target.dispatchEvent(new PointerEvent("pointerenter", { ...touch, bubbles: false }));
    target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("mouseenter"));
    target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    return new Promise<number>((done) =>
      setTimeout(() => {
        const grown = count() - start;
        target.dispatchEvent(new PointerEvent("pointerleave", { ...touch, bubbles: false }));
        target.dispatchEvent(new MouseEvent("mouseleave"));
        done(grown);
      }, 120),
    );
  }, index);
  return { styles, handlers };
}

/** The probe itself: a control with a hover-shown button and a tooltip on mouse enter must count. */
async function checkProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const row = document.createElement("div");
    row.id = "tap-probe-check";
    // Above the app, which covers the page.
    row.style.cssText = "position:fixed;top:200px;left:20px;z-index:2147483647";
    row.innerHTML =
      "<style>#tap-probe-check .more{opacity:0}#tap-probe-check:hover .more{opacity:1}</style>" +
      '<button data-tap-probe="-1">Row</button><button class="more">More</button>';
    row.querySelector("button")?.addEventListener("mouseenter", () => {
      document.body.append(Object.assign(document.createElement("div"), { textContent: "Tooltip" }));
    });
    document.body.prepend(row);
  });
  const effects = await hoverEffects(page, -1);
  await page.evaluate(() => document.getElementById("tap-probe-check")?.remove());
  assert.ok(effects.styles > 0, "The probe missed a button that a :hover style shows.");
  assert.ok(effects.handlers > 0, "The probe missed a tooltip that a mouse enter handler shows.");
}

async function checkView(page: Page, view: string): Promise<void> {
  await open(page, view);
  await page.screenshot({ path: resolve(OUT, `${view.replaceAll("/", "_")}.png`) });
  const names = await markControls(page);
  for (let index = 0; index < names.length; index++) {
    if ((await page.locator(`[data-tap-probe="${index}"]`).count()) === 0) continue;
    checked++;
    const { styles, handlers } = await hoverEffects(page, index);
    const control = names[index] ?? "";
    if (styles > 0) hoverChanges.push({ view, control, detail: `a :hover style shows ${styles} elements` });
    if (handlers > 0) hoverChanges.push({ view, control, detail: `a touch enter handler adds ${handlers} elements` });
  }
  if (!SURVEY) return;
  for (let index = 0; index < names.length; index++) {
    await open(page, view);
    await markControls(page);
    const control = page.locator(`[data-tap-probe="${index}"]`);
    if ((await control.count()) === 0) continue;
    const name = names[index] ?? "";
    if (/delete|remove|sign out|log out|leave|eliminar|salir/iu.test(name)) continue;
    // The tab or option that is already chosen has nothing to change.
    const chosen = await control.evaluate(
      (element) =>
        ["aria-selected", "aria-pressed", "aria-checked", "data-selected"].some(
          (name) => element.getAttribute(name) === "true" || element.getAttribute(name) === "",
        ) || element.getAttribute("aria-current") !== null,
    );
    if (chosen) continue;
    // A tap that opens a menu which closes again at once changes the DOM twice and leaves it as it
    // was: the page after the tap is compared with the page before, not the changes in between.
    const page_ = () => page.evaluate(() => `${location.href}\n${document.body.innerHTML}`);
    const before = await page_();
    await control.tap({ timeout: 2_000, force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    if ((await page_()) === before) deadTaps.push({ view, control: name, detail: "no change" });
    await page.keyboard.press("Escape").catch(() => undefined);
  }
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
  optimizeDeps: { entries: ["src/renderer/stories/web-client-harness.tsx"], include: ["@norbert_bodziony/bloub"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
try {
  const iphone = devices["iPhone 13"];
  assert.ok(iphone, "Playwright has no iPhone 13 descriptor.");
  const { defaultBrowserType: _engine, ...phone } = iphone;
  const context = await browser.newContext(phone);
  // A link may lead off the harness; the survey stays on it.
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/u, (route) => route.abort());
  const freshPage = async () => {
    const created = await context.newPage();
    created.setDefaultTimeout(15_000);
    created.setDefaultNavigationTimeout(60_000);
    return created;
  };
  let page = await freshPage();
  await page.goto(`${origin}/app/general/today`, { waitUntil: "commit" });
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, null, {
    timeout: 120_000,
  });
  await page.waitForTimeout(3_000);
  // The phone reports no hover, as Safari on an iPhone does.
  assert.equal(await page.evaluate(() => matchMedia("(hover: hover)").matches), false);
  await checkProbe(page);
  const only = process.argv
    .find((arg) => arg.startsWith("--views="))
    ?.slice("--views=".length)
    .split(",");
  for (const view of only ?? VIEWS) {
    // A page that stops answering (a script that never returns) must not stop the walk.
    const stalled = new Promise<string>((done) => setTimeout(() => done("no answer in 6 minutes"), 360_000));
    const outcome = await Promise.race([
      checkView(page, view).then(
        () => null,
        (error: unknown) => (error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)),
      ),
      stalled,
    ]);
    if (outcome !== null) {
      stuck.push({ view, control: "", detail: outcome });
      await page.close().catch(() => undefined);
      page = await freshPage();
    }
    logger.info(
      `${view}: ${checked} controls so far, ${hoverChanges.length} hover changes, ${deadTaps.length} dead taps`,
    );
  }
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ checked, hoverChanges, deadTaps, stuck }, null, 2)}\n`);
for (const finding of hoverChanges) logger.info(`hover: ${finding.view} ${finding.control} (${finding.detail})`);
for (const finding of deadTaps) logger.info(`dead tap: ${finding.view} ${finding.control}`);
for (const finding of stuck) logger.info(`stuck: ${finding.view} (${finding.detail})`);
logger.info(`${checked} controls: ${hoverChanges.length} change on hover, ${deadTaps.length} taps changed nothing.`);
process.exit(hoverChanges.length === 0 ? 0 : 1);
