// Checks that the people of a channel read the answers for them, not the agents' talk: in the
// #nicho-cocina thread of the AgentTalk story, the lead's handoffs and a subtask answer show as one
// line each that opens the full text, the lead's answer to the person shows whole, no step trail
// shows, and the three working agents share one line that opens their lines with Stop. A long report
// in the channel folds to its first lines with "Show more", and "Show less" keeps the button where it
// was. Debug mode (⌘⇧D / Ctrl+Shift+D) shows everything whole, with a "Debug" badge. It runs on a
// computer and on an iPhone against a running Storybook:
// `bun scripts/workspace-agent-talk-e2e.ts --storybook=http://localhost:6006`.
// `--browser-executable=<path>` picks a Chromium build; Playwright's own is the default.
// Writes .openbot-build/workspace-agent-talk-e2e/report.json and a screenshot of each step.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, chromium, devices, type Locator, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/workspace-agent-talk-e2e");
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
const browserExecutable = process.argv
  .find((arg) => arg.startsWith("--browser-executable="))
  ?.slice("--browser-executable=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

const STORY = "web-workspace--agent-talk";
const PHONE: BrowserContextOptions = { ...devices["iPhone 13"] };
// Short enough that the channel scrolls with the report open, so "Show less" can keep its place.
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 620 } };

interface SurfaceResult {
  /** One line for each message between agents in the thread. */
  foldedNotes: number;
  /** The lead's answer to the person shows whole. */
  answerShown: boolean;
  /** Step trails in the thread: none. */
  stepTrails: number;
  /** A note opened to its full text. */
  noteOpens: boolean;
  /** "3 agents working" on one line, and its Stop buttons once opened. */
  workingLine: string;
  stopButtons: number;
  /** The long report in the channel folds, opens, and folds again with the button in place. */
  reportFolds: boolean;
  reportOpens: boolean;
  toggleMovedPx: number;
  /** Debug mode: the badge shows, and nothing folds. */
  debugBadge: boolean;
  debugNotes: number;
  debugFolds: number;
  debugStepTrails: number;
}

const report: { desktop?: SurfaceResult; phone?: SurfaceResult; passed: boolean } = { passed: false };

async function openStory(browser: Browser, options: BrowserContextOptions): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story`, { waitUntil: "load", timeout: 180_000 });
  // A cold Storybook bundles its dependencies on the first load.
  await page.getByText("nicho-cocina", { exact: true }).first().waitFor({ timeout: 120_000 });
  return page;
}

async function run(browser: Browser, options: BrowserContextOptions, touch: boolean, name: string) {
  const page = await openStory(browser, options);
  const press = (locator: Locator) => (touch ? locator.tap() : locator.click());
  await press(page.getByText("nicho-cocina", { exact: true }).first());
  const channel = page.locator("section.ws-channel-pane");
  await channel.waitFor({ timeout: 30_000 });

  // The long report folds; "Show more" opens it, "Show less" folds it with the button in place.
  const fold = channel.locator(".ws-fold").last();
  await fold.locator(".ws-fold-toggle").waitFor({ timeout: 30_000 });
  const reportFolds = (await fold.getAttribute("data-folded")) !== null;
  await page.screenshot({ path: resolve(OUT, `${name}-1-channel.png`) });
  const toggle = fold.locator(".ws-fold-toggle");
  await press(toggle);
  await page.waitForFunction(() => !document.querySelector(".ws-channel-pane .ws-fold[data-folded]"));
  const reportOpens = await channel.getByText("Pendiente de Alejandro").isVisible();
  await page.screenshot({ path: resolve(OUT, `${name}-2-report-open.png`) });
  const before = (await toggle.boundingBox())?.y ?? 0;
  await press(toggle);
  await page.waitForFunction(() => Boolean(document.querySelector(".ws-channel-pane .ws-fold[data-folded]")));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const toggleMovedPx = Math.abs(((await toggle.boundingBox())?.y ?? 0) - before);

  // The thread: handoffs and a subtask answer as one line each, the answer whole, no steps.
  await press(channel.locator(".ws-thread-summary").first());
  const thread = page.locator("section.ws-thread-panel");
  await thread.getByText("Será", { exact: false }).first().waitFor({ timeout: 30_000 });
  const notes = thread.locator(".ws-note-line");
  const foldedNotes = await notes.count();
  const answerShown = await thread.getByText("con link directo a la landing").isVisible();
  const stepTrails = await thread.locator(".ws-steps").count();
  await page.screenshot({ path: resolve(OUT, `${name}-3-thread.png`) });
  await press(notes.first());
  const noteOpens = await thread.getByText("No publicas ni creas nada en Meta").isVisible();
  const group = thread.locator(".ws-typing-group");
  await group.waitFor({ timeout: 30_000 });
  const workingLine = (await group.innerText()).trim();
  await press(group);
  const stopButtons = await thread.locator(".ws-typing-stop").count();
  await page.screenshot({ path: resolve(OUT, `${name}-4-thread-open.png`) });

  // Debug mode shows everything; a second toggle hides it again.
  const toggleDebug = async () => {
    if (touch) {
      await page.evaluate(() =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true, bubbles: true })),
      );
    } else await page.keyboard.press("Control+Shift+D");
  };
  await toggleDebug();
  await page.locator(".ws-debug-badge").waitFor({ timeout: 10_000 });
  const debugBadge = await page.locator(".ws-debug-badge").isVisible();
  await page.waitForFunction(() => document.querySelectorAll(".ws-thread-panel .ws-note-line").length === 0);
  const debugNotes = await thread.locator(".ws-note-line").count();
  const debugFolds = await page.locator(".ws-fold[data-folded]").count();
  const debugStepTrails = await page.locator(".ws-steps").count();
  await page.screenshot({ path: resolve(OUT, `${name}-5-debug.png`) });
  await toggleDebug();
  await page.locator(".ws-debug-badge").waitFor({ state: "detached", timeout: 10_000 });
  await page.context().close();
  return {
    foldedNotes,
    answerShown,
    stepTrails,
    noteOpens,
    workingLine,
    stopButtons,
    reportFolds,
    reportOpens,
    toggleMovedPx,
    debugBadge,
    debugNotes,
    debugFolds,
    debugStepTrails,
  } satisfies SurfaceResult;
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), args: ["--no-sandbox"] } : {},
);
try {
  report.desktop = await run(browser, DESKTOP, false, "desktop");
  report.phone = await run(browser, PHONE, true, "phone");
  for (const result of [report.desktop, report.phone]) {
    assert.equal(result.foldedNotes, 4, "Each handoff and the subtask answer must fold to one line.");
    assert.equal(result.answerShown, true, "The lead's answer to the person must show whole.");
    assert.equal(result.stepTrails, 0, "A thread must show no step trail.");
    assert.equal(result.noteOpens, true, "A folded line must open the full text.");
    assert.match(result.workingLine, /3/u, "The working agents must share one line.");
    assert.equal(result.stopButtons, 3, "The working line must open a Stop for each agent.");
    assert.equal(result.reportFolds, true, "A long report must fold.");
    assert.equal(result.reportOpens, true, "Show more must open the report.");
    assert.ok(result.toggleMovedPx <= 2, "Show less must keep the button in place.");
    assert.equal(result.debugBadge, true, "Debug mode must show its badge.");
    assert.equal(result.debugNotes, 0, "Debug mode must show messages between agents whole.");
    assert.equal(result.debugFolds, 0, "Debug mode must fold no message.");
    assert.ok(result.debugStepTrails >= 1, "Debug mode must show the steps of a turn.");
  }
  report.passed = true;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
