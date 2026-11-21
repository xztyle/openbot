// Measures how the web client's chat scales with the length of a conversation. It serves the
// long-history harness (`src/renderer/stories/web-client-long-history-harness.tsx`) with `?count=<n>`
// messages in #historia and in the DM with Chief, loads the whole history by scrolling to its top, and
// then measures, in Chromium through the DevTools protocol:
//
// - open: from a click on the conversation in the sidebar until its rows are drawn (ms).
// - history: the time to load every older page by scrolling up (s), and the rows then in the page.
// - DOM nodes and JS heap after a garbage collection.
// - keystroke: from a key press in the composer until the frame after it is drawn (median, p95 ms).
// - scroll: frame times of a scroll of 40px per frame up from the end and back (mean, p95, frames
//   over 33 ms).
// - stream: main-thread time per streamed token in the DM, or per edit of a growing channel message.
// - event: main-thread time per host event that brings a new message.
//
// `--profile=desktop` is a 1280x800 window at full speed; `--profile=phone` is an iPhone (390x844)
// with the CPU slowed 4x and every row drawn, as Safari draws them (no `content-visibility`, no
// scroll anchoring).
//
// `bun scripts/timeline-perf-bench.ts [--counts=300,1500,5000] [--profile=desktop|phone|both]
//  [--surface=channel|dm] [--out=<folder>] [--browser-executable=<path>]`
// Writes .openbot-build/<out>/report.json and prints a table.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { extname, relative, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type CDPSession, chromium, type Page } from "playwright-core";
import { build, createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("timeline-perf-bench");
const ROOT = resolve(import.meta.dirname, "..");

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const OUT = resolve(ROOT, ".openbot-build", option("out") ?? "timeline-perf-bench");
const COUNTS = (option("counts") ?? "300,1500,5000").split(",").map(Number);
const isProfile = (name: string): name is ProfileName => name === "desktop" || name === "phone";
const PROFILE_NAMES: ProfileName[] =
  (option("profile") ?? "both") === "both" ? ["desktop", "phone"] : [option("profile") ?? ""].filter(isProfile);

const PROFILES = {
  desktop: { context: { viewport: { width: 1280, height: 800 } }, throttle: 1, safari: false },
  phone: {
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    throttle: 4,
    safari: true,
  },
} as const;
type ProfileName = keyof typeof PROFILES;

interface Surface {
  name: "channel" | "dm";
  path: string;
  scroller: string;
  list: string;
  composer: string;
  /** The sidebar entry that opens it. */
  link: string;
}

const SURFACES: Surface[] = [
  {
    name: "channel",
    path: "/app/general/c/historia",
    scroller: ".ws-message-scroll",
    list: ".ws-timeline",
    composer:
      ".ws-message-list ~ * [contenteditable='true'], .ws-composer [contenteditable='true'], .ws-composer textarea",
    link: "a[href$='/c/historia']",
  },
  {
    name: "dm",
    path: "/app/general/dm/chief",
    scroller: ".conversation-scroll",
    list: ".virtual-chat-list",
    composer: "[contenteditable='true'], textarea",
    link: "a[href$='/dm/chief']",
  },
];

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
    name: "openbot-timeline-perf-harness",
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

/** Safari has neither `content-visibility` with anchoring nor scroll anchoring: every row draws. */
const SAFARI_CSS = `
[data-chat-flow] > .chat-flow-row { content-visibility: visible !important; contain-intrinsic-size: none !important; }
.ws-message-scroll, .conversation-scroll, .direct-message-list { overflow-anchor: none !important; }
`;

interface Result {
  profile: ProfileName;
  surface: Surface["name"];
  count: number;
  openMs: number;
  historyS: number;
  rows: number;
  domNodes: number;
  heapMb: number;
  keyMedianMs: number;
  keyP95Ms: number;
  scrollMeanMs: number;
  scrollP95Ms: number;
  scrollOver33: number;
  streamMsPerToken: number;
  eventMsPerEvent: number;
}

const frames = (page: Page, count = 2) =>
  page.evaluate(
    (n) =>
      new Promise<void>((done) => {
        let left = n;
        const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    count,
  );

async function metric(cdp: CDPSession, name: string): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((item) => item.name === name)?.value ?? 0;
}

const PROFILE_CPU = process.argv.includes("--cpu-profile");

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
  children?: number[];
}

/** The functions with the most self time in a CPU profile, for `--cpu-profile`. */
function topFunctions(
  profile: { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[] },
  limit = 25,
): string {
  const self = new Map<string, number>();
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  (profile.samples ?? []).forEach((id, index) => {
    const node = byId.get(id);
    if (!node) return;
    const frame = node.callFrame;
    const key = `${frame.functionName || "(anon)"} ${frame.url.replace(/^.*\/(?=[^/]+\/[^/]+$)/u, "")}:${frame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas?.[index] ?? 0) / 1000);
  });
  return [...self.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([key, ms]) => `${ms.toFixed(1).padStart(8)} ms  ${key}`)
    .join("\n");
}

/** Main-thread time (ms) that `work` took, from the renderer's task durations. */
async function busy(cdp: CDPSession, work: () => Promise<void>, label?: string): Promise<number> {
  if (PROFILE_CPU && label) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  const before = await metric(cdp, "TaskDuration");
  await work();
  const spent = ((await metric(cdp, "TaskDuration")) - before) * 1000;
  if (PROFILE_CPU && label) {
    const { profile } = await cdp.send("Profiler.stop");
    writeFileSync(resolve(OUT, `${label}.cpuprofile`), JSON.stringify(profile));
    logger.info(`${label}: ${spent.toFixed(0)} ms busy. Top self time:\n${topFunctions(profile)}`);
  }
  return spent;
}

const rowCount = (page: Page, surface: Surface) =>
  page.evaluate(
    (list) => document.querySelector(list)?.querySelectorAll(":scope > [data-row-key]").length ?? 0,
    surface.list,
  );

const hasOldest = (page: Page, surface: Surface) =>
  page.evaluate(
    (scroller) =>
      [...(document.querySelector(scroller)?.querySelectorAll("p") ?? [])].some((p) =>
        /^Mensaje 0: /u.test(p.textContent ?? ""),
      ),
    surface.scroller,
  );

/** Scrolls to the top until the first message is in the page. */
async function loadHistory(page: Page, surface: Surface): Promise<number> {
  const started = Date.now();
  let still = 0;
  let last = -1;
  while (!(await hasOldest(page, surface))) {
    await page.evaluate((scroller) => {
      const element = document.querySelector(scroller);
      if (element) element.scrollTop = 0;
    }, surface.scroller);
    await page.waitForTimeout(150);
    // The rows in the page, by their keys: a bounded list has as many rows as ever, with a new first one.
    const first = await page.evaluate(
      (list) => `${document.querySelector(list)?.firstElementChild?.getAttribute("data-row-key") ?? ""}`,
      surface.list,
    );
    const marker = first.length + (await rowCount(page, surface)) * 1e6 + first.charCodeAt(first.length - 1);
    still = marker === last ? still + 1 : 0;
    last = marker;
    if (still > 40) throw new Error(`The history stopped loading at ${await rowCount(page, surface)} rows.`);
  }
  return (Date.now() - started) / 1000;
}

async function keystrokes(page: Page, surface: Surface): Promise<{ median: number; p95: number }> {
  const composer = page.locator(surface.composer).last();
  await composer.click();
  await page.evaluate(() => {
    // The times go in an attribute of the page, which the script reads back.
    document.body.dataset.keyTimes = "";
    document.addEventListener(
      "keydown",
      (event) => {
        const start = event.timeStamp;
        // The frame after the key is drawn: a task after the next animation frame.
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            document.body.dataset.keyTimes += ` ${performance.now() - start}`;
          };
          channel.port2.postMessage(null);
        });
      },
      { capture: true },
    );
  });
  await page.keyboard.type("hola, esto es una prueba de escritura rapida", { delay: 40 });
  await page.waitForTimeout(300);
  const times = (await page.evaluate(() => document.body.dataset.keyTimes ?? ""))
    .split(" ")
    .filter(Boolean)
    .map(Number);
  // Clears the composer so the draft does not stay.
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  times.sort((left, right) => left - right);
  return {
    median: Math.round((times[Math.floor(times.length / 2)] ?? 0) * 10) / 10,
    p95: Math.round((times[Math.floor(times.length * 0.95)] ?? 0) * 10) / 10,
  };
}

async function scrollFrames(page: Page, surface: Surface): Promise<{ mean: number; p95: number; over: number }> {
  const result = await page.evaluate(async (scroller) => {
    const element = document.querySelector(scroller);
    if (!element) return null;
    element.scrollTop = element.scrollHeight;
    const times: number[] = [];
    let last = await new Promise<number>((done) => requestAnimationFrame(done));
    for (const direction of [-1, 1])
      for (let index = 0; index < 90; index++) {
        element.scrollTop += direction * 40;
        const now = await new Promise<number>((done) => requestAnimationFrame(done));
        times.push(now - last);
        last = now;
      }
    times.sort((left, right) => left - right);
    return {
      mean: Math.round((times.reduce((sum, value) => sum + value, 0) / times.length) * 10) / 10,
      p95: Math.round((times[Math.floor(times.length * 0.95)] ?? 0) * 10) / 10,
      over: times.filter((value) => value > 33).length,
    };
  }, surface.scroller);
  assert.ok(result, "No transcript to scroll.");
  return result;
}

async function toEnd(page: Page, surface: Surface): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await page.evaluate((scroller) => {
      const element = document.querySelector(scroller);
      if (element) element.scrollTop = element.scrollHeight;
    }, surface.scroller);
    await page.waitForTimeout(200);
  }
}

async function measure(browser: Browser, origin: string, profile: ProfileName, surface: Surface, count: number) {
  const config = PROFILES[profile];
  const context = await browser.newContext({ ...config.context });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  if (config.safari)
    await page.addInitScript((css) => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.append(style);
      });
    }, SAFARI_CSS);
  page.on("pageerror", (error) => logger.warn(`page error: ${error.message}`));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  // Starts in #general, then opens the conversation from the sidebar.
  await page.goto(`${origin}/app/general/c/general?count=${count}`, { waitUntil: "commit" });
  await page.locator(".ws-message-scroll").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const link = page.locator(surface.link).first();
  // A first open loads the modules of the view: the measured open is the second.
  if (await link.count()) {
    await link.click();
    await page.waitForFunction(
      (list) => (document.querySelector(list)?.querySelectorAll(":scope > [data-row-key]").length ?? 0) > 5,
      surface.list,
    );
    await page.waitForTimeout(1000);
    await page.locator("a[href$='/c/general']").first().click();
    await page.locator(".ws-message-scroll").first().waitFor();
    await page.waitForTimeout(1000);
  }
  if (config.throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: config.throttle });
  let openMs: number;
  if (await link.count()) {
    const started = Date.now();
    await link.click();
    await page.waitForFunction(
      (list) => (document.querySelector(list)?.querySelectorAll(":scope > [data-row-key]").length ?? 0) > 5,
      surface.list,
    );
    await frames(page, 2);
    openMs = Date.now() - started;
  } else {
    const started = Date.now();
    await page.goto(`${origin}${surface.path}?count=${count}`, { waitUntil: "commit" });
    await page.waitForFunction(
      (list) => (document.querySelector(list)?.querySelectorAll(":scope > [data-row-key]").length ?? 0) > 5,
      surface.list,
    );
    await frames(page, 2);
    openMs = Date.now() - started;
  }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.waitForTimeout(800);
  const historyS = await loadHistory(page, surface);
  await toEnd(page, surface);
  await page.waitForTimeout(500);
  const rows = await rowCount(page, surface);
  await cdp.send("HeapProfiler.collectGarbage");
  const heapMb = (await metric(cdp, "JSHeapUsedSize")) / 1024 / 1024;
  const domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);
  if (config.throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: config.throttle });
  const key = await keystrokes(page, surface);
  await toEnd(page, surface);
  let scroll = { mean: 0, p95: 0, over: 0 };
  await busy(
    cdp,
    async () => {
      scroll = await scrollFrames(page, surface);
    },
    `${profile}-${surface.name}-${count}-scroll`,
  );
  await toEnd(page, surface);
  await page.waitForTimeout(500);
  let streamMsPerToken: number;
  if (surface.name === "dm") {
    const tokens = 200;
    streamMsPerToken =
      (await busy(
        cdp,
        async () => {
          await page.evaluate(`globalThis.openbotFlow.streamDm(${tokens}, 'FIN')`);
          await page.waitForTimeout(1500);
        },
        `${profile}-${surface.name}-${count}-stream`,
      )) / tokens;
  } else {
    const edits = 14;
    streamMsPerToken =
      (await busy(
        cdp,
        async () => {
          await page.evaluate(`globalThis.openbotFlow.growChannel(${edits})`);
          await page.waitForTimeout(800);
        },
        `${profile}-${surface.name}-${count}-stream`,
      )) / edits;
  }
  await page.waitForTimeout(800);
  const events = 8;
  const idle = await busy(cdp, () => page.waitForTimeout(events * 700 + 1500));
  const eventMsPerEvent =
    ((await busy(
      cdp,
      async () => {
        await page.evaluate(
          surface.name === "dm"
            ? `globalThis.openbotFlow.postDm(${events}, 700)`
            : `globalThis.openbotFlow.postChannel(${events}, 700)`,
        );
        await page.waitForTimeout(1500);
      },
      `${profile}-${surface.name}-${count}-event`,
    )) -
      idle) /
    events;
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await context.close();
  const result: Result = {
    profile,
    surface: surface.name,
    count,
    openMs,
    historyS: Math.round(historyS * 10) / 10,
    rows,
    domNodes,
    heapMb: Math.round(heapMb * 10) / 10,
    keyMedianMs: key.median,
    keyP95Ms: key.p95,
    scrollMeanMs: scroll.mean,
    scrollP95Ms: scroll.p95,
    scrollOver33: scroll.over,
    streamMsPerToken: Math.round(streamMsPerToken * 100) / 100,
    eventMsPerEvent: Math.round(eventMsPerEvent * 10) / 10,
  };
  logger.info(JSON.stringify(result));
  return result;
}

mkdirSync(OUT, { recursive: true });
/**
 * The harness as users get the client: a production build (`--dev` serves the development build,
 * whose reactive tracing costs more than the work it traces).
 */
async function serveHarness(): Promise<{ origin: string; close: () => Promise<void> }> {
  if (process.argv.includes("--dev")) {
    const server = await createServer({
      root: ROOT,
      configFile: false,
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
    return { origin: `http://127.0.0.1:${address.port}`, close: () => server.close() };
  }
  const page = resolve(OUT, "harness.html");
  writeFileSync(page, HARNESS);
  const dist = resolve(OUT, "dist");
  await build({
    root: ROOT,
    configFile: false,
    mode: "production",
    logLevel: "error",
    plugins: [tailwindcss({ optimize: false }), solidPlugin()],
    resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
    // A profile names the functions only in an unminified build.
    build: { outDir: dist, emptyOutDir: true, minify: !PROFILE_CPU, rolldownOptions: { input: page } },
  });
  const html = readFileSync(resolve(dist, relative(ROOT, page)), "utf8");
  const types: Record<string, string> = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".json": "application/json",
  };
  const server = createHttpServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    if (/^\/app(?:\/|$)/u.test(path)) {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
      return;
    }
    const file = resolve(dist, `.${path}`);
    if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
    response.end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object", "The harness server has no port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
const server = await serveHarness();
const origin = server.origin;
// `--serve` only serves the harness, for a look in a browser.
if (process.argv.includes("--serve")) {
  logger.info(`Serving the harness at ${origin}/app/general/c/historia?count=1500`);
  await new Promise(() => undefined);
}
const results: Result[] = [];
let browser: Browser | null = null;
try {
  const executablePath = option("browser-executable");
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const only = option("surface");
  for (const profile of PROFILE_NAMES)
    for (const surface of SURFACES.filter((item) => !only || item.name === only))
      for (const count of COUNTS) {
        try {
          results.push(await measure(browser, origin, profile, surface, count));
        } catch (error) {
          logger.error(`${profile} ${surface.name} ${count}: ${String(error).slice(0, 600)}`);
        }
        writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(results, null, 2)}\n`);
      }
} finally {
  await browser?.close();
  await server.close();
}
const header =
  "| profile | surface | msgs | open ms | history s | rows | DOM nodes | heap MB | key p50/p95 ms | scroll mean/p95 ms (>33) | ms/token | ms/event |";
const lines = results.map(
  (r) =>
    `| ${r.profile} | ${r.surface} | ${r.count} | ${r.openMs} | ${r.historyS} | ${r.rows} | ${r.domNodes} | ${r.heapMb} | ${r.keyMedianMs}/${r.keyP95Ms} | ${r.scrollMeanMs}/${r.scrollP95Ms} (${r.scrollOver33}) | ${r.streamMsPerToken} | ${r.eventMsPerEvent} |`,
);
const table = [header, `|${"---|".repeat(12)}`, ...lines].join("\n");
writeFileSync(resolve(OUT, "table.md"), `${table}\n`);
logger.info(`\n${table}`);
process.exit(0);
