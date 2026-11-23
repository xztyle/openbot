// Checks that the workspace keeps the reader's place as Slack does, with a mouse on a desktop and
// with touch on an iPhone: the thread panel opens at its first unread reply, follows new replies only at the end, shows "N new
// replies" above it and jumps down on a press, comes back to the same place when it opens again,
// and goes to the end when the reader sends a reply; a channel opens at the place the reader left
// when they come back to it. It runs against a running Storybook that renders the real web
// workspace, where an agent posts a reply in a thread every 2 s. Pass the URL that
// `bun run storybook` reports: `bun scripts/workspace-thread-scroll-e2e.ts --storybook=http://localhost:6006`.
// `--browser-executable=<path>` picks a Chromium build; Playwright's own is the default.
// Writes .openbot-build/workspace-thread-scroll-e2e/report.json and screenshots.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, chromium, devices, type Locator, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/workspace-thread-scroll-e2e");
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
const browserExecutable = process.argv
  .find((arg) => arg.startsWith("--browser-executable="))
  ?.slice("--browser-executable=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

const STORY = "web-workspace--agent-working";
const PHONE: BrowserContextOptions = { ...devices["iPhone 13"] };
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
/** As in the panel: this close to the end counts as the end. */
const FOLLOW_DISTANCE = 80;

interface Place {
  top: number;
  /** Pixels from the end of the list. */
  fromEnd: number;
  replies: number;
}

interface SurfaceResult {
  /** The thread had unread replies: it opened with the "New" divider in view, as a channel does. */
  openedAtNew: boolean;
  /** At the end after the reader went down. */
  openedAtEnd: Place;
  /** A new reply came while the reader was at the end: the panel followed it. */
  followedAtEnd: Place;
  /** A new reply came while the reader read the top: the place stayed, and the pill counted it. */
  keptPlace: { before: Place; after: Place; pill: string };
  /** The pill took the reader to the newest reply and went away. */
  jumped: Place & { pillGone: boolean };
  /** The thread opened again at the place the reader left. */
  reopened: { left: Place; back: Place };
  /** Desktop only: the reader's own reply took them to the end. */
  ownReply?: Place;
  /** Desktop only: a channel opened again at the row the reader left at the top of the view. */
  channelPlace?: { left: string; back: string };
}

interface Report {
  desktop?: SurfaceResult;
  phone?: SurfaceResult;
  passed: boolean;
}

const report: Report = { passed: false };

/** Waits for the channel list. A phone opens on Today; its channels are on the Chat tab. */
async function showChannels(page: Page): Promise<void> {
  const general = page.getByText("general", { exact: true }).first();
  const chat = page.getByRole("navigation", { name: "Workspace sections" }).getByRole("button", { name: /^Chat/u });
  // A cold Storybook bundles its dependencies on the first load.
  await general.or(chat).first().waitFor({ timeout: 120_000 });
  if (await chat.isVisible()) await chat.click();
  await general.waitFor({ timeout: 30_000 });
}

async function openStory(browser: Browser, options: BrowserContextOptions): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story`, { waitUntil: "load", timeout: 180_000 });
  // A cold Storybook bundles its dependencies on the first load.
  await showChannels(page);
  return page;
}

function threadScroll(page: Page): Locator {
  return page.locator("section.ws-thread-panel .ws-thread-scroll");
}

async function place(page: Page): Promise<Place> {
  return threadScroll(page).evaluate((element) => ({
    top: Math.round(element.scrollTop),
    fromEnd: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
    replies: element.querySelectorAll(".ws-thread-replies .ws-message").length,
  }));
}

/** Waits until the agent posted another reply in the open thread. */
async function nextReply(page: Page, after: number): Promise<void> {
  await page.waitForFunction(
    (count) => document.querySelectorAll("section.ws-thread-panel .ws-thread-replies .ws-message").length > count,
    after,
    { timeout: 15_000 },
  );
  // The panel moves on the next frame after the reply renders.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function scrollThreadTo(page: Page, top: number): Promise<void> {
  await threadScroll(page).evaluate((element, value) => {
    element.scrollTop = value;
    element.dispatchEvent(new Event("scroll"));
  }, top);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
}

async function openThread(page: Page, touch: boolean): Promise<void> {
  const button = page.locator("section.ws-channel-pane").getByRole("button", { name: /repl/i }).first();
  if (touch) await button.tap();
  else await button.click();
  await threadScroll(page).waitFor({ timeout: 30_000 });
  await page.locator("section.ws-thread-panel .ws-thread-replies .ws-message").first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** The text of the first message row whose bottom is below the top of the channel's list. */
async function topChannelRow(page: Page): Promise<string> {
  return page.locator("section.ws-channel-pane .ws-message-scroll").evaluate((scroller) => {
    const top = scroller.getBoundingClientRect().top;
    for (const row of scroller.querySelectorAll(".ws-message")) {
      if (row.getBoundingClientRect().bottom > top + 4) return row.textContent?.trim().slice(0, 80) ?? "";
    }
    return "";
  });
}

async function run(browser: Browser, options: BrowserContextOptions, touch: boolean, name: string) {
  const page = await openStory(browser, options);
  const press = (locator: Locator) => (touch ? locator.tap() : locator.click());
  await press(page.getByText("general", { exact: true }).first());
  await page.locator("section.ws-channel-pane").waitFor({ timeout: 30_000 });
  await openThread(page, touch);

  const openedAtNew = await threadScroll(page).evaluate((element) => {
    const divider = element.querySelector(".ws-new-divider");
    if (!divider) return false;
    const top = divider.getBoundingClientRect().top - element.getBoundingClientRect().top;
    return top >= -4 && top < element.clientHeight;
  });
  await scrollThreadTo(page, 1_000_000);
  const openedAtEnd = await place(page);
  await nextReply(page, openedAtEnd.replies);
  const followedAtEnd = await place(page);

  // An agent's progress replies fold into one row, so the thread can fit in a tall panel. The reader
  // opens the earlier updates, and the replies fill more than the panel: now they can leave the end.
  await press(
    page
      .locator("section.ws-thread-panel")
      .getByRole("button", { name: /more updates/i })
      .first(),
  );
  await page.waitForFunction(
    (limit) => {
      const element = document.querySelector("section.ws-thread-panel .ws-thread-scroll");
      return element ? element.scrollHeight - element.clientHeight > limit * 2 : false;
    },
    FOLLOW_DISTANCE,
    { timeout: 10_000 },
  );
  await scrollThreadTo(page, 0);
  const before = await place(page);
  await nextReply(page, before.replies);
  const pill = page.locator("section.ws-thread-panel").getByRole("button", { name: /new repl/i });
  await pill.waitFor({ timeout: 10_000 });
  const after = await place(page);
  const pillText = (await pill.textContent())?.trim() ?? "";
  await page.screenshot({ path: resolve(OUT, `${name}-thread-new-replies.png`) });

  await press(pill);
  await page.waitForFunction(
    (limit) => {
      const element = document.querySelector("section.ws-thread-panel .ws-thread-scroll");
      return element ? element.scrollHeight - element.scrollTop - element.clientHeight <= limit : false;
    },
    FOLLOW_DISTANCE,
    { timeout: 5_000 },
  );
  const jumpedPlace = await place(page);
  const pillGone = (await page.locator("section.ws-thread-panel .ws-thread-jump").count()) === 0;

  // Leave the thread in the middle, open it again: the place stays.
  await scrollThreadTo(page, 300);
  const left = await place(page);
  const panel = page.locator("section.ws-thread-panel");
  if (touch) await panel.getByRole("button", { name: "Back" }).first().tap();
  else await panel.getByRole("button", { name: "Close" }).click();
  await panel.waitFor({ state: "detached", timeout: 10_000 });
  await openThread(page, touch);
  const back = await place(page);
  await page.screenshot({ path: resolve(OUT, `${name}-thread-reopened.png`) });

  const result: SurfaceResult = {
    openedAtNew,
    openedAtEnd,
    followedAtEnd,
    keptPlace: { before, after, pill: pillText },
    jumped: { ...jumpedPlace, pillGone },
    reopened: { left, back },
  };

  if (!touch) {
    // The reader's own reply goes to the end, also from above.
    await scrollThreadTo(page, 0);
    const editor = page.getByRole("textbox", { name: /Reply in the thread/ });
    await editor.click();
    await page.keyboard.type("Thanks, keep going.");
    const count = (await place(page)).replies;
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      ({ count: replies, limit }) => {
        const element = document.querySelector("section.ws-thread-panel .ws-thread-scroll");
        if (!element) return false;
        const rows = element.querySelectorAll(".ws-thread-replies .ws-message").length;
        return rows > replies && element.scrollHeight - element.scrollTop - element.clientHeight <= limit;
      },
      { count, limit: FOLLOW_DISTANCE },
      { timeout: 10_000 },
    );
    result.ownReply = await place(page);

    // A channel keeps the place the reader left in it: #cakemaker, then #general, then back.
    await page.getByText("cakemaker", { exact: true }).first().click();
    const list = page.locator("section.ws-channel-pane .ws-message-scroll");
    await page.getByText("Build log line 2000").waitFor({ timeout: 30_000 });
    await list.evaluate((element) => {
      element.scrollTop = Math.max(0, element.scrollTop - 900);
      element.dispatchEvent(new Event("scroll"));
    });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const leftRow = await topChannelRow(page);
    await page.getByText("general", { exact: true }).first().click();
    await page.locator("section.ws-channel-pane[aria-label='general']").waitFor({ timeout: 30_000 });
    await page.getByText("cakemaker", { exact: true }).first().click();
    await page
      .locator("section.ws-channel-pane[aria-label='cakemaker'] .ws-message")
      .first()
      .waitFor({ timeout: 30_000 });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    result.channelPlace = { left: leftRow, back: await topChannelRow(page) };
    await page.screenshot({ path: resolve(OUT, `${name}-channel-place.png`) });
  }
  await page.context().close();
  return result;
}

function check(result: SurfaceResult) {
  assert.equal(result.openedAtNew, true, "A thread with unread replies must open at the first one.");
  assert.ok(result.openedAtEnd.fromEnd <= FOLLOW_DISTANCE, "The reader must reach the newest reply.");
  assert.ok(result.followedAtEnd.fromEnd <= FOLLOW_DISTANCE, "At the end, the panel must follow a new reply.");
  assert.ok(result.keptPlace.after.replies > result.keptPlace.before.replies, "A reply must arrive while reading up.");
  assert.ok(
    Math.abs(result.keptPlace.after.top - result.keptPlace.before.top) <= 2,
    "A new reply must not move a reader who reads up.",
  );
  assert.match(result.keptPlace.pill, /new repl/i, "The pill must count the new replies.");
  assert.ok(
    result.jumped.fromEnd <= FOLLOW_DISTANCE && result.jumped.pillGone,
    "The pill must take the reader to the end.",
  );
  assert.ok(
    Math.abs(result.reopened.back.top - result.reopened.left.top) <= 2,
    "The thread must open where the reader left it.",
  );
  if (result.ownReply) assert.ok(result.ownReply.fromEnd <= FOLLOW_DISTANCE, "An own reply must go to the end.");
  if (result.channelPlace)
    assert.equal(result.channelPlace.back, result.channelPlace.left, "A channel must open where the reader left it.");
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), args: ["--no-sandbox"] } : {},
);
try {
  report.desktop = await run(browser, DESKTOP, false, "desktop");
  report.phone = await run(browser, PHONE, true, "phone");
  check(report.desktop);
  check(report.phone);
  report.passed = true;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
