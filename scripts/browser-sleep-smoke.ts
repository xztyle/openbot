import { createServer } from "node:http";
import { join } from "node:path";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { app, type BrowserWindow, type WebContents, webContents } from "electron";
import { BrowserHost } from "../src/backend/browser-host";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { DynamicToolResult } from "../src/backend/protocol";

const THREAD = "sleep-thread";
const AGENT = "sleep-agent";

/**
 * A sleeping agent tab has no renderer process, and its next use loads the page again with its
 * address, history, scroll position and form values. A restored tab gets no renderer until its first
 * use. The caller writes the report that this answers.
 */
export interface BrowserSleepReport {
  /** The renderer processes of the app before the tabs opened, and with one tab asleep and one live. */
  sleptRenderers: { baseline: number; live: number };
  /** The page that a tool call on the sleeping tab saw. */
  woken: DynamicRecord;
  /** The renderer processes after a restart, before and after the first use of a restored tab. */
  restoredRenderers: { before: number; afterFirstUse: number };
}

export async function runSleepScenario(window: BrowserWindow, root: string): Promise<BrowserSleepReport> {
  const server = createServer((request, response) => {
    const name = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("name") ?? "none";
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><title>Sleep ${name}</title><h1>sleep-page-${name}</h1><input aria-label="Draft"><div style="height:5000px"></div>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The sleep page server did not start.");
  const origin = `http://127.0.0.1:${address.port}`;
  const page = (name: string) => `${origin}/sleep-page?name=${name}`;
  const statePath = join(root, "sleep-tabs.json");
  const downloads = join(root, "sleep-downloads");
  const renderers = () => app.getAppMetrics().filter((metric) => metric.type === "Tab").length;
  const baseline = renderers();
  // Each agent keeps one live tab. A tab that is not active and not used for 3 s goes over that limit.
  const tabSleep = { idleMs: 60 * 60_000, sweepMs: 50, perOwner: 1, total: 24, limitIdleMs: 3_000 };
  let host = new BrowserHost(window, downloads, statePath, { tabSleep });
  try {
    const first = await openTab(host, page("one"));
    await runCauseEffect(host.loadUrl(first.tab.id, page("two")));
    const savedState = () =>
      first.contents.navigationHistory.getEntryAtIndex(first.contents.navigationHistory.getActiveIndex())?.pageState;
    const stateBefore = savedState();
    await first.contents.executeJavaScript(
      "scrollTo(0, 1500); document.querySelector('input').value = 'draft'; document.querySelector('input').dispatchEvent(new Event('input')); true",
    );
    // Chromium sends the scroll position and the form values to the browser process on a timer.
    await waitFor(() => savedState() !== stateBefore, "the page state of the first tab");

    const second = await openTab(host, page("three"));
    await waitFor(() => first.contents.isDestroyed(), "the first tab to sleep");
    await waitFor(() => renderers() === baseline + 1, "the renderer of the first tab to end");
    const sleptTab = host.listTabs().find((tab) => tab.id === first.tab.id);
    if (sleptTab?.url !== page("two") || sleptTab.title !== "Sleep two")
      throw new Error(`A sleeping tab lost its address or title: ${JSON.stringify(sleptTab)}`);
    const sleptRenderers = { baseline, live: renderers() };

    // A tool call on a sleeping tab wakes it with its history, scroll position and draft.
    let last = "";
    const woken = await waitForValue(async () => {
      const result = await tool(host, "evaluate", { tabId: first.tab.id, expression: PAGE_STATE });
      last = text(result);
      const value = payload(result);
      return value?.scroll === 1500 ? value : undefined;
    }, "the woken tab to scroll to its position").catch((error) => {
      throw new Error(`${String(error)} Last answer: ${last}`);
    });
    if (woken.url !== page("two") || woken.draft !== "draft")
      throw new Error(`A woken tab lost its page state: ${JSON.stringify(woken)}`);
    const back = await tool(host, "navigate", { tabId: first.tab.id, direction: "back" });
    if (!back.success) throw new Error(`A woken tab lost its history: ${text(back)}`);
    const previous = payload(await tool(host, "evaluate", { tabId: first.tab.id, expression: PAGE_STATE }));
    if (previous?.url !== page("one")) throw new Error(`Back went to the wrong page: ${JSON.stringify(previous)}`);

    // The person shows the first tab, so the second one is the idle tab above the limit. Then the restart.
    await runCauseEffect(host.activate(first.tab.id));
    await waitFor(() => second.contents.isDestroyed(), "the second tab to sleep");
    await runCauseEffect(host.destroy());
    const before = new Set(webContents.getAllWebContents().map((contents) => contents.id));
    const restoredBaseline = renderers();
    host = new BrowserHost(window, downloads, statePath, { tabSleep: { ...tabSleep, perOwner: 4 } });
    await runCauseEffect(host.restore([{ id: AGENT, threadId: THREAD }]));
    const restored = webContents.getAllWebContents().filter((contents) => !before.has(contents.id));
    if (restored.length !== 2 || restored.some((contents) => contents.getURL() !== ""))
      throw new Error("A restored tab loaded a page before its first use.");
    if (renderers() !== restoredBaseline) throw new Error("A restored tab started a renderer before its first use.");
    const snapshot = await runCauseEffect(host.snapshot(second.tab.id));
    if (!snapshot.text.includes("sleep-page-three")) throw new Error("A restored tab did not load on its first use.");
    await waitFor(() => renderers() === restoredBaseline + 1, "the renderer of the used restored tab");
    return {
      sleptRenderers,
      woken,
      restoredRenderers: { before: restoredBaseline, afterFirstUse: renderers() },
    };
  } finally {
    await runCauseEffect(host.destroy());
    server.close();
  }
}

const PAGE_STATE = "({ url: location.href, scroll: scrollY, draft: document.querySelector('input').value })";

async function openTab(host: BrowserHost, url: string): Promise<{ tab: { id: string }; contents: WebContents }> {
  const before = new Set(webContents.getAllWebContents().map((contents) => contents.id));
  const tab = await runCauseEffect(host.open(url, THREAD, AGENT));
  const contents = webContents.getAllWebContents().find((candidate) => !before.has(candidate.id));
  if (!contents) throw new Error(`No view was created for ${url}.`);
  return { tab, contents };
}

let toolCall = 0;
function tool(host: BrowserHost, name: string, argumentsValue: unknown): Promise<DynamicToolResult> {
  toolCall += 1;
  return runCauseEffect(
    host.handleDynamicTool({
      threadId: THREAD,
      turnId: `sleep-turn-${toolCall}`,
      callId: `sleep-call-${toolCall}`,
      ownerAgentId: AGENT,
      namespace: "openbot_browser",
      tool: name,
      arguments: argumentsValue,
    }),
  );
}

function text(result: DynamicToolResult): string {
  const item = result.contentItems.find((candidate) => candidate.type === "inputText");
  return item?.type === "inputText" ? item.text : "";
}

function payload(result: DynamicToolResult): DynamicRecord | undefined {
  if (!result.success) return undefined;
  const value = JSON.parse(text(result));
  return isDynamicRecord(value) ? value : undefined;
}

async function waitFor(check: () => boolean, waitedFor: string): Promise<void> {
  await waitForValue(async () => (check() ? true : undefined), waitedFor);
}

async function waitForValue<T>(check: () => Promise<T | undefined>, waitedFor: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${waitedFor}.`);
}
