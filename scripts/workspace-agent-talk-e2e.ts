// Checks that the people of a channel read the answers for them, not the agents' talk: in the
// #nicho-cocina thread of the AgentTalk story, the lead's handoffs and a subtask answer show as one
// line each that opens the full text, the lead's answer to the person shows whole, no step trail
// shows, and the three working agents share one line that opens their lines with Stop. A long report
// in the channel folds to its first lines with "Show more", and "Show less" keeps the button where it
// was, and the text is gone where "Show more" lies over the fold. Ad mockups never fold, alone or
// under a short line, and the subtask results that speak to the person ("Alejandro, rehice…", or
// marked `audience: "people"`) show whole, once, not as a line between agents. Debug mode
// (⌘⇧D / Ctrl+Shift+D) shows everything whole, with a "Debug" badge. It runs on a
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
  /** The darkest letter pixel left under "Show more" on a folded message: 0 means the text is gone. */
  inkUnderToggle: number;
  /** "Show more" on the messages of images: none, alone or under a short line. */
  imageFolds: number;
  /** Images that show on the messages of images. */
  imagesShown: number;
  /** Subtask results for the person: lines between agents in the channel, and their texts shown once. */
  channelNotes: number;
  personResultsShown: number;
  personResultCopies: number;
  /** A note opened shows its text once: the line hides its summary. */
  openNoteSummaryHidden: boolean;
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
  // A cold Storybook bundles its dependencies on the first load. A phone opens on Today; its channel
  // list is on the Chat tab.
  const channel = page.getByText("nicho-cocina", { exact: true }).first();
  const chat = page.getByRole("navigation", { name: "Workspace sections" }).getByRole("button", { name: /^Chat/u });
  await channel.or(chat).first().waitFor({ timeout: 120_000 });
  if (await chat.isVisible()) await chat.click();
  await channel.waitFor({ timeout: 30_000 });
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
  await fold.scrollIntoViewIfNeeded();
  const reportFolds = (await fold.getAttribute("data-folded")) !== null;
  const inkUnderToggle = await inkUnder(page, fold);
  await page.screenshot({ path: resolve(OUT, `${name}-1-channel.png`) });
  const toggle = fold.locator(".ws-fold-toggle");
  await press(toggle);
  await fold.and(page.locator(":not([data-folded])")).waitFor({ timeout: 10_000 });
  const reportOpens = await channel.getByText("Pendiente de Alejandro").isVisible();
  await page.screenshot({ path: resolve(OUT, `${name}-2-report-open.png`) });
  const before = (await toggle.boundingBox())?.y ?? 0;
  await press(toggle);
  await fold.and(page.locator("[data-folded]")).waitFor({ timeout: 10_000 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const toggleMovedPx = Math.abs(((await toggle.boundingBox())?.y ?? 0) - before);

  // The ad mockups: no "Show more" on images, alone or under a short line.
  const images = channel.locator(".ws-message").filter({ has: page.locator("[data-attachment-id]") });
  await images.first().scrollIntoViewIfNeeded();
  for (let tries = 0; tries < 60 && (await images.locator("img").count()) < 5; tries += 1)
    await page.waitForTimeout(500);
  const imageFolds = await images.locator(".ws-fold-toggle").count();
  const imagesShown = await images.locator("img").count();
  // The subtask results that speak to the person show whole, each once, not as a line between agents.
  const copyResult = channel.getByText("Alejandro, rehice el copy de A1 y A3", { exact: false });
  await copyResult.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(OUT, `${name}-2b-channel-results.png`) });
  const channelNotes = await channel.locator(".ws-note-line").count();
  const campaign = channel.getByText("La campaña quedó en borrador", { exact: false });
  const personResultsShown = Number(await copyResult.first().isVisible()) + Number(await campaign.first().isVisible());
  const personResultCopies = (await copyResult.count()) + (await campaign.count());

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
  const openNoteSummaryHidden = !(await notes.first().locator(".ws-note-summary").isVisible());
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
    inkUnderToggle,
    imageFolds,
    imagesShown,
    channelNotes,
    personResultsShown,
    personResultCopies,
    openNoteSummaryHidden,
    debugBadge,
    debugNotes,
    debugFolds,
    debugStepTrails,
  } satisfies SurfaceResult;
}

/**
 * How much of the text still shows on the line of "Show more" of a folded message: the share of
 * the pixels of that line, beside the button, that differ from the background. The page is drawn
 * once with the text and once with the fold body hidden; 0 means the line is blank.
 */
async function inkUnder(page: Page, fold: Locator): Promise<number> {
  const toggle = await fold.locator(".ws-fold-actions").boundingBox();
  const body = await fold.locator(".ws-fold-body").boundingBox();
  if (!toggle || !body) return 1;
  const clip = { x: body.x, y: toggle.y, width: body.width, height: toggle.height };
  const shown = await page.screenshot({ clip });
  const parts = fold.locator(".ws-fold-body, .ws-fold-actions");
  const hide = (hidden: boolean) =>
    parts.evaluateAll(
      (elements, value) => {
        for (const element of elements) if (element instanceof HTMLElement) element.style.visibility = value;
      },
      hidden ? "hidden" : "",
    );
  await hide(true);
  const blank = await page.screenshot({ clip });
  await hide(false);
  // The button itself is drawn in both: compare only the part of the line right of it.
  return page.evaluate(
    async ({ shown, blank, from, width }) => {
      const read = async (data: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("No canvas.");
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [a, b] = await Promise.all([read(shown), read(blank)]);
      const start = Math.round(from * (a.width / width));
      let differ = 0;
      let total = 0;
      for (let y = 0; y < a.height; y += 1)
        for (let x = start; x < a.width; x += 1) {
          const i = (y * a.width + x) * 4;
          total += 1;
          const delta =
            Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) +
            Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) +
            Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
          if (delta > 24) differ += 1;
        }
      return total ? differ / total : 0;
    },
    {
      shown: shown.toString("base64"),
      blank: blank.toString("base64"),
      from: Math.ceil(toggle.x + toggle.width - body.x) + 4,
      width: clip.width,
    },
  );
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
    assert.ok(result.inkUnderToggle <= 0.02, "The text must be gone where Show more lies.");
    assert.equal(result.imageFolds, 0, "Images must never fold.");
    assert.equal(result.imagesShown, 5, "Every mockup must show.");
    assert.equal(result.channelNotes, 0, "A result for the person must not fold as a line between agents.");
    assert.equal(result.personResultsShown, 2, "Both results for the person must show.");
    assert.equal(result.personResultCopies, 2, "Each result for the person must show once.");
    assert.equal(result.openNoteSummaryHidden, true, "An open note must not repeat its text in the line.");
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
