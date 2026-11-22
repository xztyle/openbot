// Measures the web client on a large mock host (`src/renderer/stories/web-client-stress-harness.tsx`):
// 150 more channels, one of 3,000 messages, and 40 more agents, with the production builds of Solid.
// No account service, host or provider is needed.
//
// 1. Load: the time until the sidebar lists the last channel, on a computer and on an iPhone with a
//    4x slower CPU.
// 2. stream: a reply streams into a channel that is not open (50 flushes, 100 ms apart), then into the
//    open channel. Counts the host calls (the channel list, the open page, the agent's steps) and the
//    main thread's long tasks.
// 3. typing: a key's time to the next frame on a 4x slower CPU while a reply streams elsewhere.
// 4. resync: messages that came while the connection was down show once each after the reconnect.
// 5. reconnect: lost connections in a row (`--cycles=<n>`, 10). Counts the reads of each reconnect and
//    checks the window and document listeners, the elements and the heap after a GC.
// 6. idle: the second minute in the foreground without an event. Counts the host calls.
//
// `bun scripts/web-perf-stress-e2e.ts [--only=<phase,...>] [--latency=<ms>] [--cycles=<n>] [--effects]
//   [--snapshot=<file>] [--browser-executable=<path>] [--headed]`
// `--latency` delays each host call of the mock, as a phone's link does. `--effects` counts, by call
// site, the effects that ran again with an unchanged value. `--snapshot` writes a heap snapshot after
// the reconnects. Writes .openbot-build/web-perf-stress-e2e/report.json; a budget that fails fails the run.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type CDPSession, chromium, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("web-perf-stress-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-perf-stress-e2e");
const UI_WAIT_MS = 90_000;
const english = translateFor("en");

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}
const ONLY = option("only")?.split(",");
const runs = (phase: string) => !ONLY || ONLY.includes(phase);
/** `--latency=<ms>`: each host call of the mock waits this long, as over a phone's link. */
const LATENCY = Number(option("latency") ?? 0);

const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-stress-harness.tsx"></script>
  </body>
</html>`;

function webClientPages(): Plugin {
  return {
    name: "openbot-web-perf-stress-harness",
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

/**
 * `--effects`: app code gets a `solid-js` whose `createEffect` counts, per call site, the runs whose
 * source gave the same value as the run before. Solid 2 runs an effect again each time its source
 * runs, also with an equal value, so such an effect repeats its work (a read of the host, an IPC
 * call) on every unrelated change.
 */
const EFFECTS_SHIM = "\0openbot-effect-count";
function effectCounter(): Plugin {
  return {
    name: "openbot-effect-count",
    enforce: "pre",
    resolveId(source, importer) {
      if (source !== "solid-js" || !importer || importer === EFFECTS_SHIM || importer.includes("node_modules"))
        return null;
      return EFFECTS_SHIM;
    },
    load(id) {
      if (id !== EFFECTS_SHIM) return null;
      return `export * from "solid-js";
import { createEffect as solidCreateEffect } from "solid-js";
const sites = (globalThis.__effectRuns ??= {});
const UNSET = Symbol("unset");
export function createEffect(compute, effect, options) {
  const line = (new Error().stack ?? "").split("\\n")[2] ?? "";
  const site = line.replace(/^\\s*at\\s*/u, "").replace(/https?:\\/\\/[^/]+\\//u, "").replace(/\\?[^:]*/u, "");
  let previous = UNSET;
  const wrap = (fn) => (value, prev) => {
    const entry = (sites[site] ??= { equal: 0, changed: 0 });
    if (previous !== UNSET && Object.is(value, previous)) entry.equal += 1;
    else entry.changed += 1;
    previous = value;
    return fn(value, prev);
  };
  const wrapped = typeof effect === "function" ? wrap(effect) : effect && typeof effect.effect === "function" ? { ...effect, effect: wrap(effect.effect) } : effect;
  return solidCreateEffect(compute, wrapped, options);
}`;
    },
  };
}
const EFFECTS = process.argv.includes("--effects");
declare global {
  interface Window {
    /** The mock host's controls, from `web-client-stress-harness.tsx`. */
    openbotStress?: {
      stream(channelId: string, flushes: number, gapMs: number): Promise<void>;
      drop(holdMs: number): void;
      post(channelId: string, text: string): Promise<void>;
      postDm(agentId: string, text: string): Promise<void>;
      calls: Record<string, number>;
      resetCalls(): void;
    };
    __effectRuns?: Record<string, { equal: number; changed: number }>;
    __longTasks?: number[];
  }
}
/** The effect runs since the last call, by call site; the counts start again from zero. */
const takeEffectRuns = (page: Page): Promise<Record<string, { equal: number; changed: number }>> =>
  page.evaluate(() => {
    const runs = window.__effectRuns;
    if (!runs) return {};
    const taken = structuredClone(runs);
    for (const key of Object.keys(runs)) delete runs[key];
    return taken;
  });
/** The call sites whose effect ran with an unchanged value, most first. */
const repeatedEffects = (runs: Record<string, { equal: number; changed: number }>) =>
  Object.fromEntries(
    Object.entries(runs)
      .filter(([, entry]) => entry.equal > 0)
      .sort(([, a], [, b]) => b.equal - a.equal)
      .slice(0, 25)
      .map(([site, entry]) => [site, `${entry.equal} equal / ${entry.changed} changed`]),
  );

interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}
type Metric = number | string | boolean | null | Metric[] | { [key: string]: Metric };
const report: {
  metrics: Record<string, Metric>;
  checks: Check[];
  pageErrors: string[];
  consoleErrors: string[];
  passed: boolean;
} = { metrics: {}, checks: [], pageErrors: [], consoleErrors: [], passed: false };

function check(name: string, passed: boolean, detail?: string) {
  report.checks.push({ name, passed, ...(detail ? { detail } : {}) });
  logger.info(`${passed ? "ok" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

type Calls = Record<string, number>;
const calls = (page: Page): Promise<Calls> => page.evaluate(() => ({ ...(window.openbotStress?.calls ?? {}) }));
const resetCalls = (page: Page) => page.evaluate(() => window.openbotStress?.resetCalls());

/** Long tasks since the observer started, in ms. */
async function observeLongTasks(page: Page) {
  await page.evaluate(() => {
    const tasks: number[] = [];
    window.__longTasks = tasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
  });
}
const takeLongTasks = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const tasks = window.__longTasks ?? [];
    const taken = [...tasks];
    tasks.length = 0;
    return taken;
  });

async function listenerCounts(cdp: CDPSession): Promise<{ window: number; document: number }> {
  const count = async (expression: string) => {
    const { result } = await cdp.send("Runtime.evaluate", { expression });
    if (!result.objectId) return -1;
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
    await cdp.send("Runtime.releaseObject", { objectId: result.objectId });
    return listeners.length;
  };
  return { window: await count("window"), document: await count("document") };
}

async function heapAfterGc(cdp: CDPSession): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? -1;
}
async function domNodes(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((metric) => metric.name === "Nodes")?.value ?? -1;
}

/** How many elements of each tag and first class the page holds, to name what a growing DOM adds. */
const elementKinds = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(() => {
    const kinds: Record<string, number> = {};
    for (const element of document.querySelectorAll("*")) {
      const kind = `${element.tagName.toLowerCase()}.${element.classList[0] ?? ""}`;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    return kinds;
  });
/** The nodes that JS still holds after they left the document, by tag and first class. */
async function detachedKinds(cdp: CDPSession): Promise<Record<string, number>> {
  await cdp.send("HeapProfiler.collectGarbage");
  // One object group, released at the end: an array the console holds would keep every node it lists.
  const objectGroup = "web-perf-stress-detached";
  const { result: prototype } = await cdp.send("Runtime.evaluate", { expression: "Node.prototype", objectGroup });
  if (!prototype.objectId) return {};
  const { objects } = await cdp.send("Runtime.queryObjects", { prototypeObjectId: prototype.objectId, objectGroup });
  const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
    objectId: objects.objectId ?? "",
    functionDeclaration: `function () {
      const kinds = {};
      for (const node of this) {
        try { if (node.isConnected) continue; } catch { continue; }
        let top = node;
        while (top.parentNode) top = top.parentNode;
        if (top !== node) continue;
        const kind = node.nodeType === 1 ? node.tagName.toLowerCase() + "." + (node.classList[0] || "") + "|" + (node.textContent || "").slice(0, 40) : "#" + node.nodeName;
        kinds[kind] = (kinds[kind] || 0) + 1;
      }
      return kinds;
    }`,
    returnByValue: true,
    objectGroup,
  });
  await cdp.send("Runtime.releaseObjectGroup", { objectGroup });
  if (exceptionDetails) logger.warn(JSON.stringify(exceptionDetails).slice(0, 600));
  const kinds: Record<string, number> = {};
  if (result.value && typeof result.value === "object")
    for (const [kind, count] of Object.entries(result.value)) if (typeof count === "number") kinds[kind] = count;
  return kinds;
}
function grown(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(after)
      .map(([kind, count]): [string, number] => [kind, count - (before[kind] ?? 0)])
      .filter(([, change]) => change !== 0)
      .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
      .slice(0, 20),
  );
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** Loads the workspace (Today) and returns the time until the sidebar lists the last channel. */
async function loadWorkspace(page: Page, origin: string): Promise<number> {
  const started = Date.now();
  const lastRow = page.getByText("load-149", { exact: true }).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${origin}/app${LATENCY ? `?latency=${LATENCY}` : ""}`, { waitUntil: "commit" });
    if (
      await lastRow.waitFor({ state: "attached", timeout: UI_WAIT_MS / 2 }).then(
        () => true,
        () => false,
      )
    )
      break;
  }
  return Date.now() - started;
}

/** Opens #general from the sidebar and waits for its transcript. */
async function openGeneral(page: Page): Promise<void> {
  await page.getByText("general", { exact: true }).first().click();
  await page.getByText("Morning! Who looks at the pricing page today?").first().waitFor({ timeout: UI_WAIT_MS });
}

async function desktop(browser: Browser, origin: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 400));
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  // Warm Vite once, so the measured load does not include the dependency optimisation.
  await loadWorkspace(page, origin);
  const loadMs = await loadWorkspace(page, origin);
  report.metrics.desktopLoadMs = loadMs;
  await openGeneral(page);
  await page.waitForTimeout(1_500);
  await observeLongTasks(page);
  report.metrics.desktopNodesAfterLoad = await domNodes(cdp);

  if (runs("stream")) {
    await resetCalls(page);
    await takeLongTasks(page);
    await takeEffectRuns(page);
    await page.evaluate(() => window.openbotStress?.stream("load-5", 50, 100));
    await page.waitForTimeout(1_000);
    const background = await calls(page);
    const backgroundTasks = await takeLongTasks(page);
    report.metrics.backgroundStream = {
      calls: background,
      longTasks: backgroundTasks.length,
      longTaskMs: Math.round(sum(backgroundTasks)),
      ...(EFFECTS ? { repeatedEffects: repeatedEffects(await takeEffectRuns(page)) } : {}),
    };
    // A flush in a channel that is not open changes the list, not the open page.
    check(
      "a reply streaming in a closed channel does not read the open channel again",
      (background["channels.readChannel"] ?? 0) <= 1,
      `readChannel ${background["channels.readChannel"] ?? 0}, listChannels ${background["channels.listChannels"] ?? 0}`,
    );

    // The sidebar follows the stream, but its list is not read again for each flush.
    check(
      "a 5 s stream reads the channel list at most 8 times",
      (background["channels.listChannels"] ?? 0) <= 8,
      `listChannels ${background["channels.listChannels"] ?? 0}`,
    );

    await resetCalls(page);
    await page.evaluate(() => window.openbotStress?.stream("general", 50, 100));
    await page.waitForTimeout(1_000);
    const open = await calls(page);
    const openTasks = await takeLongTasks(page);
    const openEffects = await takeEffectRuns(page);
    report.metrics.openStream = {
      calls: open,
      longTasks: openTasks.length,
      longTaskMs: Math.round(sum(openTasks)),
      ...(EFFECTS ? { repeatedEffects: repeatedEffects(openEffects) } : {}),
    };
    check(
      "a reply streaming in the open channel does not read its page again",
      (open["channels.readChannel"] ?? 0) <= 1,
      `readChannel ${open["channels.readChannel"] ?? 0}, listChannels ${open["channels.listChannels"] ?? 0}`,
    );
    if (EFFECTS) {
      // An effect that runs for each flush with an unchanged value repeats its work: the avatars
      // loaded a failed picture again, and the steps poll started over. One run per flush is 50.
      const repeated = Object.entries(openEffects).filter(([, entry]) => entry.equal > 60);
      check(
        "no effect runs more than 60 times with an unchanged value during a 5 s stream",
        repeated.length === 0,
        repeated.map(([site, entry]) => `${site}: ${entry.equal}`).join("; "),
      );
    }
    // The working agent's steps are read every 2 s, not on each flush.
    check(
      "a 5 s stream in the open channel reads the agent's steps at most 4 times",
      (open["channels.workspaceSteps"] ?? 0) <= 4,
      `workspaceSteps ${open["channels.workspaceSteps"] ?? 0}`,
    );
  }

  if (runs("typing")) {
    // Typing in #general's box with a 4x slower CPU while a reply streams in another channel: the time
    // from each key to the next frame, and the effects that each key runs with an unchanged value.
    const surface = page.locator(".ws-composer .composer-editor-surface").filter({ visible: true }).last();
    await surface.click();
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await takeEffectRuns(page);
    await takeLongTasks(page);
    const streaming = page.evaluate(() => window.openbotStress?.stream("load-9", 40, 100));
    const delays: number[] = [];
    for (const character of "the numbers for this week look fine") {
      const started = Date.now();
      await page.keyboard.type(character);
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
      delays.push(Date.now() - started);
    }
    await streaming;
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const typingTasks = await takeLongTasks(page);
    const sorted = [...delays].sort((a, b) => a - b);
    report.metrics.typing = {
      keys: delays.length,
      medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
      worstMs: sorted.at(-1) ?? 0,
      longTasks: typingTasks.length,
      longTaskMs: Math.round(sum(typingTasks)),
      ...(EFFECTS ? { repeatedEffects: repeatedEffects(await takeEffectRuns(page)) } : {}),
    };
    check(
      "a key shows within 100 ms (median) on a 4x slower CPU while a reply streams",
      (sorted[Math.floor(sorted.length / 2)] ?? 0) <= 100,
      `median ${sorted[Math.floor(sorted.length / 2)]} ms, worst ${sorted.at(-1)} ms`,
    );
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
  }

  if (runs("resync")) {
    // Messages that came while the connection was down show once each after the reconnect: in the
    // open channel, and in a channel that is not open (its unread count).
    const missed = ["Missed while offline: one", "Missed while offline: two"];
    await page.evaluate(() => window.openbotStress?.drop(1_500));
    await page.waitForTimeout(200);
    for (const text of missed) await page.evaluate((body) => window.openbotStress?.post("general", body), text);
    await page.evaluate(() => window.openbotStress?.post("load-7", "Missed in a closed channel"));
    let shown: number[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      shown = await Promise.all(missed.map((text) => page.getByText(text, { exact: true }).count()));
      if (shown.every((count) => count >= 1)) break;
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1_500);
    shown = await Promise.all(missed.map((text) => page.getByText(text, { exact: true }).count()));
    report.metrics.resync = { shown };
    check(
      "messages from the time offline show once each in the open channel after the reconnect",
      shown.every((count) => count === 1),
      JSON.stringify(shown),
    );
  }

  if (runs("reconnect")) {
    const reconnectOnce = async () => {
      await page.evaluate(() => window.openbotStress?.drop(300));
      // Online again: the connecting notice is gone and the channel is there.
      await page.waitForFunction(
        (text) => !document.body.innerText.includes(text),
        english("webClient.notice.connecting"),
        { timeout: 30_000 },
      );
      await page.waitForTimeout(2_500);
    };
    await reconnectOnce();
    const listenersBefore = await listenerCounts(cdp);
    const heapBefore = await heapAfterGc(cdp);
    const nodesBefore = await domNodes(cdp);
    const kindsBefore = await elementKinds(page);
    const detachedBefore = await detachedKinds(cdp);
    await resetCalls(page);
    await takeEffectRuns(page);
    const cycles = Number(option("cycles") ?? 10);
    const started = Date.now();
    for (let index = 0; index < cycles; index++) await reconnectOnce();
    const reconnectCalls = await calls(page);
    const reconnectEffects = EFFECTS ? repeatedEffects(await takeEffectRuns(page)) : null;
    // The last toasts end, so what stays is what nothing lets go.
    await page.waitForTimeout(8_000);
    const listenersAfter = await listenerCounts(cdp);
    const heapAfter = await heapAfterGc(cdp);
    const nodesAfter = await domNodes(cdp);
    const kindsAfter = await elementKinds(page);
    const snapshotPath = option("snapshot");
    if (snapshotPath) {
      const { createWriteStream } = await import("node:fs");
      const out = createWriteStream(snapshotPath);
      cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => out.write(chunk));
      await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
      await new Promise((done) => out.end(done));
    }
    report.metrics.reconnect = {
      ...(reconnectEffects ? { repeatedEffects: reconnectEffects } : {}),
      grownElements: grown(kindsBefore, kindsAfter),
      grownDetached: grown(detachedBefore, await detachedKinds(cdp)),
      cycles,
      elapsedMs: Date.now() - started,
      callsPerCycle: Object.fromEntries(
        Object.entries(reconnectCalls)
          .sort(([, a], [, b]) => b - a)
          .map(([name, count]) => [name, count / cycles]),
      ),
      listenersBefore,
      listenersAfter,
      heapBefore,
      heapAfter,
      nodesBefore,
      nodesAfter,
    };
    check(
      "reconnects add no window or document listeners",
      listenersAfter.window <= listenersBefore.window && listenersAfter.document <= listenersBefore.document,
      `${JSON.stringify(listenersBefore)} -> ${JSON.stringify(listenersAfter)}`,
    );
    // Blink keeps some removed SVG elements until a later collection, so the node count is a hint;
    // the elements in the document must stay.
    const elementsBefore = sum(Object.values(kindsBefore));
    const elementsAfter = sum(Object.values(kindsAfter));
    check(
      "reconnects keep the number of elements in the document",
      elementsAfter <= elementsBefore * 1.02 + 20,
      `${elementsBefore} -> ${elementsAfter} (all nodes ${nodesBefore} -> ${nodesAfter})`,
    );
    check(
      "reconnects grow the heap by less than 5 MB",
      heapAfter - heapBefore < 5_000_000,
      `${Math.round(heapBefore / 1e5) / 10} MB -> ${Math.round(heapAfter / 1e5) / 10} MB`,
    );
  }

  if (runs("idle")) {
    // The first minute ends the bounded retries of a load, such as the artifacts' three reads for their
    // images; the second minute is the steady state.
    await page.waitForTimeout(60_000);
    await resetCalls(page);
    await takeLongTasks(page);
    await page.waitForTimeout(60_000);
    const idle = await calls(page);
    const idleTasks = await takeLongTasks(page);
    report.metrics.idleMinute = { calls: idle, longTasks: idleTasks.length };
    check("a steady idle minute makes at most 2 host calls", sum(Object.values(idle)) <= 2, JSON.stringify(idle));
  }
  await context.close();
}

async function phone(browser: Browser, origin: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  const cdp = await context.newCDPSession(page);
  // A slow phone: 4x CPU throttle and a "Fast 3G"-like link do not change the mock host's answers, but
  // they show the client's own work.
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const started = Date.now();
  await page.goto(`${origin}/app`, { waitUntil: "commit" });
  await page
    .getByRole("navigation", { name: english("workspace.phone.tabs") })
    .waitFor({ timeout: UI_WAIT_MS })
    .catch(() => undefined);
  report.metrics.phoneLoadMs = Date.now() - started;
  await context.close();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// The production builds of Solid: the development build keeps every disposed scope for its cost
// attribution, which reads as a leak in a long run.
const server = await createServer({
  root: ROOT,
  mode: "production",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  configFile: false,
  appType: "custom",
  logLevel: "error",
  plugins: [
    webClientPages(),
    ...(EFFECTS ? [effectCounter()] : []),
    tailwindcss({ optimize: false }),
    solidPlugin({ dev: false }),
  ],
  resolve: {
    dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"],
    conditions: ["module", "browser", "production"],
  },
  optimizeDeps: {
    entries: ["src/renderer/stories/web-client-stress-harness.tsx"],
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
  if (runs("phone")) await phone(browser, origin);
  report.passed = report.checks.every((item) => item.passed) && report.pageErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.checks.filter((item) => item.passed).length} of ${report.checks.length} checks. Report: ${resolve(OUT, "report.json")}`,
);
process.exit(report.passed ? 0 : 1);
