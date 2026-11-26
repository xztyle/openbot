// Checks that the rows of a long channel and of a long agent DM never draw over each other: each
// message is a card, and the next one starts below it. It serves the web client on a mock host with
// 330 messages of mixed heights in #historia and in the DM with Chief
// (`src/renderer/stories/web-client-long-history-harness.tsx`) and drives it in Chromium, on a
// computer and on an iPhone. After each step it reads every rendered row's box and asserts that no
// two rows overlap and that each row ends at or above the next row's top. The steps: open at the
// first unread message with the "New" divider; scroll up through the older pages, keeping the
// reader's place when a page loads; jump to the latest message; resize the window; grow the last
// message while the reader follows it (an edit in the channel, a streamed reply in the DM); open a
// link to an old message, which loads its page and shows it. It also times the frames of a scroll
// through the whole history, with the CPU slowed 4x.
//
// `bun scripts/timeline-flow-e2e.ts [--viewport=desktop|phone] [--surface=channel|dm] [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/timeline-flow-e2e/report.json and screenshots.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("timeline-flow-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/timeline-flow-e2e");
const UI_WAIT_MS = 30_000;
const STEP_MS = 240_000;
const CHANNEL_PATH = "/app/general/c/historia";
const DM_PATH = "/app/general/dm/chief";

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;

interface Surface {
  name: "channel" | "dm";
  path: string;
  /** The scroll container of the transcript. */
  scroller: string;
  /** The element whose children are the rows. */
  list: string;
}

const CHANNEL: Surface = {
  name: "channel",
  path: CHANNEL_PATH,
  scroller: ".ws-message-scroll",
  list: ":is(.ws-virtual-list, .ws-timeline)",
};
const DM: Surface = {
  name: "dm",
  path: DM_PATH,
  scroller: ".conversation-scroll",
  list: ".virtual-chat-list",
};

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
    <script type="module" src="/src/renderer/stories/web-client-long-history-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-timeline-flow-harness",
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
  surface: string;
  name: string;
  passed: boolean;
  detail?: string;
}

interface FrameTimes {
  frames: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  over50Ms: number;
}

const report: {
  steps: Step[];
  overlapChecks: number;
  frameTimes: Record<string, FrameTimes>;
  pageErrors: string[];
  consoleErrors: string[];
  screenshots: string[];
  passed: boolean;
} = { steps: [], overlapChecks: 0, frameTimes: {}, pageErrors: [], consoleErrors: [], screenshots: [], passed: false };

async function step(
  page: Page,
  viewport: ViewportName,
  surface: Surface,
  name: string,
  check: () => Promise<void>,
): Promise<void> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The step took longer than 240 s.")), STEP_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    report.steps.push({ viewport, surface: surface.name, name, passed: true });
  } catch (error) {
    report.steps.push({ viewport, surface: surface.name, name, passed: false, detail: String(error).slice(0, 1200) });
    const file = resolve(OUT, `${viewport}-${surface.name}-${report.steps.length}-failed.png`);
    await page.screenshot({ path: file }).catch(() => undefined);
    report.screenshots.push(file);
  }
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

async function shot(page: Page, label: string): Promise<void> {
  const file = resolve(OUT, `${label}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(file);
}

async function load(page: Page, origin: string, path: string, surface: Surface): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${origin}${path}`, { waitUntil: "commit" });
    const ready = await page
      .waitForFunction((list) => (document.querySelector(list)?.children.length ?? 0) > 5, surface.list, {
        timeout: UI_WAIT_MS / 2,
      })
      .then(
        () => true,
        () => false,
      );
    if (ready) return;
  }
  await page.waitForFunction((list) => (document.querySelector(list)?.children.length ?? 0) > 5, surface.list, {
    timeout: UI_WAIT_MS,
  });
}

const frames = (page: Page, count = 3) =>
  page.evaluate(
    (n) =>
      new Promise<void>((done) => {
        let left = n;
        const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    count,
  );

/**
 * Every rendered row's box, in order: each row must end at or above the next row's top, so no row
 * draws over another. Rows with no height (nothing to draw) are skipped.
 */
async function assertNoOverlap(page: Page, surface: Surface, label: string): Promise<void> {
  report.overlapChecks += 1;
  const problems = await page.evaluate(
    ({ list, scroller }) => {
      const root = document.querySelector(list);
      if (!root) return ["no list"];
      const boxes = [...root.children]
        .map((element, index) => {
          const box = element.getBoundingClientRect();
          return {
            index,
            top: box.top,
            bottom: box.bottom,
            height: box.height,
            text: (element.textContent ?? "").trim().slice(0, 50),
          };
        })
        .filter((box) => box.height > 0);
      const found: string[] = [];
      for (let index = 1; index < boxes.length; index++) {
        const above = boxes[index - 1];
        const below = boxes[index];
        if (!above || !below) continue;
        if (above.bottom > below.top + 0.5)
          found.push(
            `row ${above.index} (${above.text}) ends at ${above.bottom.toFixed(1)}, below its next row ${below.index} (${below.text}) starting at ${below.top.toFixed(1)}`,
          );
      }
      // A row's own content must fit its box: a box shorter than its content lets the next row cover it.
      // Only rows on the screen: a row away from it skips its layout (content-visibility) and is not drawn.
      const view = document.querySelector(scroller)?.getBoundingClientRect();
      for (const element of root.children) {
        if (!(element instanceof HTMLElement) || element.offsetHeight === 0 || !view) continue;
        const own = element.getBoundingClientRect();
        if (own.bottom < view.top || own.top > view.bottom) continue;
        const content = [...element.children].reduce((bottom, child) => {
          const box = child.getBoundingClientRect();
          // A hidden child has an empty box at the page's origin.
          if (box.width === 0 && box.height === 0) return bottom;
          if (getComputedStyle(child).position === "sticky") return bottom;
          return Math.max(bottom, box.bottom);
        }, element.getBoundingClientRect().top);
        if (content > own.bottom + 1) {
          const child = [...element.children].find((item) => item.getBoundingClientRect().bottom === content);
          found.push(
            `a row's content (${child?.tagName.toLowerCase()}.${child?.className}) ends at ${content.toFixed(1)}, ${(content - own.bottom).toFixed(1)}px below its box`,
          );
        }
      }
      return found.slice(0, 5);
    },
    { list: surface.list, scroller: surface.scroller },
  );
  assert.deepEqual(problems, [], `${label}: rows overlap`);
}

/** How far the transcript is from its end. */
const remaining = (page: Page, surface: Surface) =>
  page.evaluate((scroller) => {
    const element = document.querySelector(scroller);
    return element ? element.scrollHeight - element.scrollTop - element.clientHeight : Number.NaN;
  }, surface.scroller);

/** The first row whose top is in the view, with its distance from the view's top. */
const anchor = (page: Page, surface: Surface) =>
  page.evaluate(
    ({ scroller, list }) => {
      const view = document.querySelector(scroller)?.getBoundingClientRect();
      const root = document.querySelector(list);
      if (!view || !root) return null;
      for (const element of root.children) {
        const box = element.getBoundingClientRect();
        if (box.height > 0 && box.top >= view.top + 40) {
          const text = (element.textContent ?? "").trim().slice(0, 80);
          return { text, offset: box.top - view.top };
        }
      }
      return null;
    },
    { scroller: surface.scroller, list: surface.list },
  );

const rowCount = (page: Page, surface: Surface) =>
  page.evaluate((list) => document.querySelector(list)?.children.length ?? 0, surface.list);

/** The rows hold the oldest message: the history is fully loaded. */
const hasOldest = (page: Page, surface: Surface) =>
  page.evaluate(
    (list) =>
      [...(document.querySelector(list)?.querySelectorAll("p") ?? [])].some((p) =>
        /^Mensaje 0: /u.test(p.textContent ?? ""),
      ),
    surface.list,
  );

async function scrollBy(page: Page, surface: Surface, delta: number): Promise<void> {
  const box = await page.locator(surface.scroller).first().boundingBox();
  assert.ok(box, "The transcript has no box.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, delta);
}

/** Resolves when the view has not moved for three frames, as a smooth wheel scroll ends. */
const settled = (page: Page, surface: Surface) =>
  page.evaluate(
    (scroller) =>
      new Promise<void>((done) => {
        const element = document.querySelector(scroller);
        let last = Number.NaN;
        let still = 0;
        let frames = 0;
        const tick = () => {
          const top = element?.scrollTop ?? 0;
          still = Math.abs(top - last) < 0.5 ? still + 1 : 0;
          last = top;
          frames += 1;
          if (still >= 3 || frames > 120) done();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    surface.scroller,
  );

/** Where a row is from the top of the view, by the text it starts with. */
const rowOffset = (page: Page, surface: Surface, text: string) =>
  page.evaluate(
    ({ scroller, list, text }) => {
      const view = document.querySelector(scroller)?.getBoundingClientRect();
      const root = document.querySelector(list);
      if (!view || !root) return null;
      for (const element of root.children)
        if ((element.textContent ?? "").trim().slice(0, 80) === text)
          return element.getBoundingClientRect().top - view.top;
      return null;
    },
    { scroller: surface.scroller, list: surface.list, text },
  );

/**
 * Scrolls to the top with the wheel. Each older page that loads above the reader keeps the row they
 * looked at where the wheel left it: without that, the row would jump down by the page's height.
 */
async function scrollThroughHistory(page: Page, surface: Surface): Promise<void> {
  let moves = 0;
  let checkedLoads = 0;
  while (!(await hasOldest(page, surface)) && moves < 150) {
    const count = await rowCount(page, surface);
    const top = await page.evaluate((scroller) => document.querySelector(scroller)?.scrollTop ?? 0, surface.scroller);
    const place = await anchor(page, surface);
    await scrollBy(page, surface, -1200);
    moves += 1;
    await settled(page, surface);
    const nearTop = await page.evaluate(
      (scroller) => (document.querySelector(scroller)?.scrollTop ?? 0) < 300,
      surface.scroller,
    );
    // A page loads when the reader reaches the top: wait for it.
    const loaded =
      (await rowCount(page, surface)) > count ||
      (nearTop &&
        (await page
          .waitForFunction(
            ({ list, count }) => (document.querySelector(list)?.children.length ?? 0) > count,
            { list: surface.list, count },
            { timeout: 3_000 },
          )
          .then(
            () => true,
            () => false,
          )));
    if (loaded) await settled(page, surface);
    await assertNoOverlap(page, surface, `scroll up ${moves}${loaded ? " and a page loaded" : ""}`);
    if (loaded && place) {
      checkedLoads += 1;
      const offset = await rowOffset(page, surface, place.text);
      assert.ok(offset !== null, "The row the reader looked at left the transcript when a page loaded.");
      // The wheel moved the view up by 1200px, or to the top when it was nearer.
      const expected = place.offset + Math.min(1200, top);
      assert.ok(
        Math.abs(offset - expected) < 200,
        `A loaded page moved the reader's row: it is ${offset.toFixed(0)}px from the top, not about ${expected.toFixed(0)}px.`,
      );
    }
  }
  assert.ok(await hasOldest(page, surface), "The history never reached its first message.");
  assert.ok(checkedLoads >= 1, "No older page loaded while scrolling up.");
}

/** Times the frames of a scroll from the top of the history to its end and back. */
async function frameTimes(page: Page, surface: Surface, label: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const result = await page.evaluate(async (scroller) => {
    const element = document.querySelector(scroller);
    if (!element) return null;
    const times: number[] = [];
    let last = await new Promise<number>((done) => requestAnimationFrame(done));
    const run = async (from: number, to: number) => {
      const steps = 120;
      for (let index = 1; index <= steps; index++) {
        element.scrollTop = from + ((to - from) * index) / steps;
        const now = await new Promise<number>((done) => requestAnimationFrame(done));
        times.push(now - last);
        last = now;
      }
    };
    element.scrollTop = 0;
    last = await new Promise<number>((done) => requestAnimationFrame(done));
    await run(0, element.scrollHeight);
    await run(element.scrollHeight, 0);
    times.sort((left, right) => left - right);
    const mean = times.reduce((sum, value) => sum + value, 0) / times.length;
    return {
      frames: times.length,
      meanMs: Math.round(mean * 10) / 10,
      p95Ms: Math.round((times[Math.floor(times.length * 0.95)] ?? 0) * 10) / 10,
      maxMs: Math.round((times.at(-1) ?? 0) * 10) / 10,
      over50Ms: times.filter((value) => value > 50).length,
    };
  }, surface.scroller);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.detach();
  if (result) report.frameTimes[label] = result;
}

async function jumpToLatest(page: Page, surface: Surface): Promise<void> {
  await page.locator(".ws-jump-latest").first().click();
  await page.waitForFunction(
    (scroller) => {
      const element = document.querySelector(scroller);
      return element ? element.scrollHeight - element.scrollTop - element.clientHeight <= 2 : false;
    },
    surface.scroller,
    { timeout: 10_000 },
  );
  await frames(page, 6);
  assert.ok((await remaining(page, surface)) <= 2, "Jump to latest did not reach the end.");
}

async function grow(page: Page, surface: Surface): Promise<void> {
  const run =
    surface.name === "channel"
      ? page.evaluate("globalThis.openbotFlow.growChannel(14)")
      : page.evaluate("globalThis.openbotFlow.streamDm(240, 'FIN-DEL-STREAM')");
  let done = false;
  void run.finally(() => {
    done = true;
  });
  let checks = 0;
  let worst = 0;
  while (!done) {
    await page.waitForTimeout(120);
    await assertNoOverlap(page, surface, `while growing ${checks}`);
    worst = Math.max(worst, await remaining(page, surface));
    checks += 1;
  }
  await run;
  await frames(page, 8);
  await assertNoOverlap(page, surface, "after growing");
  const end = await remaining(page, surface);
  assert.ok(end <= 2, `The transcript stopped following the growing message: ${end}px from the end.`);
  assert.ok(checks >= 3, "The message grew too fast to check.");
  logger.info(
    `${surface.name}: worst distance from the end while growing: ${worst.toFixed(0)}px over ${checks} checks`,
  );
}

/** A link to an old message: the client loads its page and shows it in the view. */
async function openLink(page: Page, origin: string, surface: Surface, id: string, prefix: string): Promise<void> {
  await page.goto(`${origin}${surface.path}/m/${id}`, { waitUntil: "commit" });
  await page.waitForFunction(
    ({ scroller, prefix }) => {
      const view = document.querySelector(scroller)?.getBoundingClientRect();
      if (!view) return false;
      for (const p of document.querySelectorAll(`${scroller} p`)) {
        if (!(p.textContent ?? "").startsWith(prefix)) continue;
        const box = p.getBoundingClientRect();
        return box.bottom > view.top && box.top < view.bottom;
      }
      return false;
    },
    { scroller: surface.scroller, prefix },
    { timeout: UI_WAIT_MS },
  );
  await frames(page, 6);
  await assertNoOverlap(page, surface, `link to ${id}`);
}

async function run(browser: Browser, origin: string, viewport: ViewportName): Promise<void> {
  const only = option("surface");
  for (const surface of [CHANNEL, DM].filter((item) => !only || item.name === only)) {
    const context = await browser.newContext({ ...VIEWPORTS[viewport] });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    watch(page, viewport);
    await step(page, viewport, surface, "opens at the first unread message with the New divider", async () => {
      await load(page, origin, surface.path, surface);
      const divider = page
        .locator(
          `${surface.scroller} :is(.ws-new-divider, [class*="new-messages-divider"], [class*="unread-messages-divider"])`,
        )
        .first();
      await divider.waitFor({ timeout: UI_WAIT_MS });
      await frames(page, 6);
      const inView = await divider.evaluate((element, scroller) => {
        const view = document.querySelector(scroller)?.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return view ? box.top >= view.top - 1 && box.bottom <= view.bottom + 1 : false;
      }, surface.scroller);
      assert.ok(inView, "The New divider is not in view when the conversation opens.");
      await assertNoOverlap(page, surface, "open at unread");
    });
    await shot(page, `${viewport}-${surface.name}-1-unread`);
    await step(page, viewport, surface, "scrolls up through every older page, keeping the place", async () => {
      await scrollThroughHistory(page, surface);
      await assertNoOverlap(page, surface, "at the top");
    });
    await shot(page, `${viewport}-${surface.name}-2-top`);
    if (viewport === "desktop")
      await step(page, viewport, surface, "frame times of a scroll through the history", async () => {
        await frameTimes(page, surface, `${viewport}-${surface.name}`);
        await frames(page, 6);
        await assertNoOverlap(page, surface, "after the timed scroll");
      });
    await step(page, viewport, surface, "jumps to the latest message", async () => {
      await scrollBy(page, surface, -400);
      await frames(page, 6);
      await jumpToLatest(page, surface);
      await assertNoOverlap(page, surface, "at the end");
    });
    await step(page, viewport, surface, "a resize keeps the rows apart and the end in view", async () => {
      const size = VIEWPORTS[viewport].viewport;
      await page.setViewportSize({ width: Math.round(size.width * 0.7), height: Math.round(size.height * 0.8) });
      await frames(page, 8);
      await assertNoOverlap(page, surface, "narrow");
      assert.ok((await remaining(page, surface)) <= 2, "A narrower window left the end.");
      await page.setViewportSize(size);
      await frames(page, 8);
      await assertNoOverlap(page, surface, "restored");
      assert.ok((await remaining(page, surface)) <= 2, "A wider window left the end.");
    });
    await step(page, viewport, surface, "follows a message that grows", async () => {
      await grow(page, surface);
    });
    await shot(page, `${viewport}-${surface.name}-3-grown`);
    await step(page, viewport, surface, "a link to an old message loads its page and shows it", async () => {
      await openLink(page, origin, surface, surface.name === "channel" ? "historia-40" : "dm-40", "Mensaje 40: ");
      if (surface.name === "channel") {
        const highlighted = await page.locator(`${surface.scroller} .ws-message[data-highlighted]`).count();
        assert.ok(highlighted >= 1, "The linked message is not highlighted.");
      }
      await scrollBy(page, surface, 900);
      await frames(page, 6);
      await assertNoOverlap(page, surface, "after the link, scrolled");
    });
    await shot(page, `${viewport}-${surface.name}-4-link`);
    await context.close();
  }
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
  // A cache of its own: the deploy suite runs several scripts at once, and a server that
  // rebuilds a shared cache for its own entries pulls the modules from under the others.
  cacheDir: "node_modules/.vite-e2e/timeline-flow-e2e",
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: ["src/renderer/stories/web-client-long-history-harness.tsx"],
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
  const viewports = option("viewport");
  if (!viewports || viewports === "desktop") await run(browser, origin, "desktop");
  if (!viewports || viewports === "phone") await run(browser, origin, "phone");
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
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps, ${report.overlapChecks} overlap checks. Frame times: ${JSON.stringify(report.frameTimes)}. Report: ${resolve(OUT, "report.json")}`,
);
process.exit(report.passed ? 0 : 1);
