// Checks the reader's marks on workspace messages, as in Slack, in a running Storybook that renders
// the real web workspace: pin and unpin (the "Pinned by" mark and the Pins tab of the details, which
// opens the message), "Save for later", "Mark unread" in a channel and in a thread (the "New"
// divider moves to the message), the thread's follow bell and its unread dot, and the header bell's
// notification level. A desktop uses the right-click menu and a mouse; an iPhone uses the long-press
// sheet and taps. Pass the URL that `bun run storybook` reports:
// `bun scripts/workspace-message-marks-e2e.ts --storybook=http://localhost:6006`.
// `--browser-executable=<path>` picks a Chromium build; Playwright's own is the default.
// Writes .openbot-build/workspace-message-marks-e2e/report.json and screenshots.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, chromium, devices, type Locator, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/workspace-message-marks-e2e");
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
const browserExecutable = process.argv
  .find((arg) => arg.startsWith("--browser-executable="))
  ?.slice("--browser-executable=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

const STORY = "web-workspace--slack-workspace";
const PHONE: BrowserContextOptions = { ...devices["iPhone 13"] };
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
/** Messages of #general in the story, written by another member. */
const FIRST = "Who looks at the pricing page";
const LAST = "the site looks great";
const ROOT = "compare our prices";
const REPLY = "I compare the plans";

interface SurfaceResult {
  menuItems: string[];
  /** The steps that passed, each waited for in the page: pin, Pins tab, open pin, save, unpin, thread dot, read. */
  steps: string[];
  channelDividerAtMessage: boolean;
  threadDividerAtReply: boolean;
  followBefore: string;
  followAfter: string;
  bellLevel: string;
}

interface Report {
  desktop?: SurfaceResult;
  phone?: SurfaceResult;
  passed: boolean;
}

const report: Report = { passed: false };

async function openStory(browser: Browser, options: BrowserContextOptions): Promise<Page> {
  const page = await (await browser.newContext(options)).newPage();
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story`, { waitUntil: "load", timeout: 180_000 });
  // A cold Storybook bundles its dependencies on the first load.
  await page.getByText("general", { exact: true }).first().waitFor({ timeout: 120_000 });
  return page;
}

function message(scope: Page | Locator, text: string): Locator {
  return scope.locator("article.ws-message", { hasText: text }).first();
}

/** Holds a finger on the element until the action sheet opens, then lifts it. */
async function longPress(page: Page, target: Locator): Promise<Locator> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert.ok(box, "The message has no box to press.");
  const point = [{ x: box.x + box.width / 2, y: box.y + Math.min(24, box.height / 2), id: 1 }];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
  const sheet = page.getByRole("dialog", { name: "Message actions" });
  await sheet.waitFor({ timeout: 5_000 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  return sheet;
}

/** Picks a message action: the right-click menu on a desktop, the long-press sheet on a phone. */
async function messageAction(page: Page, target: Locator, action: string | RegExp, touch: boolean): Promise<void> {
  if (touch) {
    const sheet = await longPress(page, target);
    await sheet.getByRole("button", { name: action }).tap();
    await sheet.waitFor({ state: "detached", timeout: 5_000 });
    return;
  }
  await target.scrollIntoViewIfNeeded();
  await target.click({ button: "right", position: { x: 220, y: 16 } });
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitem", { name: action }).click();
  await menu.waitFor({ state: "detached", timeout: 5_000 });
}

async function actionNames(page: Page, target: Locator, touch: boolean): Promise<string[]> {
  if (touch) {
    const sheet = await longPress(page, target);
    const names = await sheet.locator(".ui-sheet-items").getByRole("button").allInnerTexts();
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    return names;
  }
  await target.click({ button: "right", position: { x: 220, y: 16 } });
  const menu = page.getByRole("menu");
  const names = await menu.getByRole("menuitem").allInnerTexts();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  return names;
}

/** Whether the "New" divider is in the same row as the message, right above it. */
async function dividerAbove(target: Locator): Promise<boolean> {
  return target.evaluate((article) => {
    let node: Element | null = article;
    while (node && !node.previousElementSibling) node = node.parentElement;
    for (let previous = node?.previousElementSibling ?? null; previous; previous = previous.previousElementSibling) {
      if (previous.classList.contains("ws-new-divider")) return true;
      if (previous.querySelector("article.ws-message")) return false;
    }
    return false;
  });
}

async function run(browser: Browser, options: BrowserContextOptions, touch: boolean, name: string) {
  const page = await openStory(browser, options);
  const press = (locator: Locator) => (touch ? locator.tap() : locator.click());
  await press(page.getByText("general", { exact: true }).first());
  const pane = page.locator("section.ws-channel-pane");
  const first = message(pane, FIRST);
  await first.waitFor({ timeout: 30_000 });
  const menuItems = await actionNames(page, message(pane, ROOT), touch);

  // Pin: the mark shows on the message, and the Pins tab lists it and opens it.
  await messageAction(page, first, "Pin to channel", touch);
  await first.locator('.ws-message-mark[data-mark="pinned"]').waitFor({ timeout: 10_000 });
  await press(pane.getByRole("button", { name: "Details", exact: true }));
  const details = page.locator("section.ws-details");
  await press(details.getByRole("tab", { name: "Pins" }));
  const pin = details.getByRole("button", { name: new RegExp(FIRST) });
  await pin.waitFor({ timeout: 10_000 });
  await page.screenshot({ path: resolve(OUT, `${name}-pins-tab.png`) });
  await press(pin);
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll("article.ws-message[data-highlighted]")].some((item) =>
        item.textContent?.includes(text),
      ),
    FIRST,
    { timeout: 10_000 },
  );
  if (await details.isVisible()) await press(details.getByRole("button", { name: "Close" }));

  // Save for later.
  await messageAction(page, first, "Save for later", touch);
  await first.locator('.ws-message-mark[data-mark="saved"]').waitFor({ timeout: 10_000 });
  await page.screenshot({ path: resolve(OUT, `${name}-marks.png`) });
  await messageAction(page, first, "Unpin from channel", touch);
  await first.locator('.ws-message-mark[data-mark="pinned"]').waitFor({ state: "detached", timeout: 10_000 });

  // Mark unread in the channel: the "New" divider moves to the message.
  const last = message(pane, LAST);
  await messageAction(page, last, "Mark unread", touch);
  await pane.locator(".ws-new-divider").first().waitFor({ timeout: 10_000 });
  const channelDividerAtMessage = await dividerAbove(last);

  // The thread: its unread dot, the read when it opens, the follow bell, and Mark unread in it.
  const summary = message(pane, ROOT).locator(".ws-thread-summary");
  await page.waitForFunction(
    () => document.querySelector(".ws-channel-pane .ws-thread-summary[data-unread]") !== null,
    undefined,
    { timeout: 10_000 },
  );
  await press(summary);
  const thread = page.locator("section.ws-thread-panel");
  const reply = message(thread, REPLY);
  await reply.waitFor({ timeout: 30_000 });
  const follow = thread.getByRole("button", { name: /notif/i });
  await follow.waitFor({ timeout: 10_000 });
  const followBefore = (await follow.getAttribute("aria-label")) ?? "";
  await press(follow);
  await page.waitForFunction(
    (before) =>
      [...document.querySelectorAll("section.ws-thread-panel .ws-pane-header button")].some(
        (button) =>
          /notif/i.test(button.getAttribute("aria-label") ?? "") && button.getAttribute("aria-label") !== before,
      ),
    followBefore,
    { timeout: 10_000 },
  );
  const followAfter =
    (await thread.locator(".ws-pane-header").getByRole("button", { name: /notif/i }).getAttribute("aria-label")) ?? "";
  await messageAction(page, reply, "Mark unread", touch);
  await thread.locator(".ws-new-divider").waitFor({ timeout: 10_000 });
  const threadDividerAtReply = await dividerAbove(reply);
  await page.screenshot({ path: resolve(OUT, `${name}-thread-unread.png`) });
  // Closing the thread lets it be read again; the reader read it when it opened, so before the mark
  // the dot had gone. Open it again: it reads through the newest reply and the dot goes.
  if (touch) await thread.getByRole("button", { name: "Back" }).first().tap();
  else await thread.getByRole("button", { name: "Close" }).click();
  await thread.waitFor({ state: "detached", timeout: 10_000 });
  await press(summary);
  await message(page.locator("section.ws-thread-panel"), REPLY).waitFor({ timeout: 30_000 });
  if (touch) await page.locator("section.ws-thread-panel").getByRole("button", { name: "Back" }).first().tap();
  else await page.locator("section.ws-thread-panel").getByRole("button", { name: "Close" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".ws-channel-pane .ws-thread-summary") !== null &&
      document.querySelector(".ws-channel-pane .ws-thread-summary[data-unread]") === null,
    undefined,
    { timeout: 10_000 },
  );

  // The header bell: "Just mentions" stays chosen.
  const bell = pane.getByRole("button", { name: /Notifications for/ });
  await press(bell);
  await press(page.getByRole("menuitemradio", { name: "Just mentions" }));
  await page.getByRole("menu").waitFor({ state: "detached", timeout: 5_000 });
  await press(bell);
  const checked = page.getByRole("menuitemradio", { checked: true });
  await checked.waitFor({ timeout: 5_000 });
  const bellLevel = (await checked.innerText()).trim();
  await page.screenshot({ path: resolve(OUT, `${name}-bell-menu.png`) });
  await page.keyboard.press("Escape");

  await page.context().close();
  return {
    menuItems,
    steps: [
      "pinned mark",
      "listed in Pins tab",
      "Pins tab opened the message",
      "saved mark",
      "unpinned",
      "thread dot while unread",
      "thread dot gone after the read",
    ],
    channelDividerAtMessage,
    threadDividerAtReply,
    followBefore,
    followAfter,
    bellLevel,
  };
}

function check(result: SurfaceResult) {
  assert.equal(result.menuItems[0], "Reply in thread");
  for (const item of ["Mark unread", "Save for later", "Copy text", "Copy link", "Pin to channel"])
    assert.ok(result.menuItems.includes(item), `The message actions must offer "${item}".`);
  assert.equal(result.channelDividerAtMessage, true, "Mark unread must put the divider right above the message.");
  assert.equal(result.threadDividerAtReply, true, "Mark unread in a thread must put the divider above the reply.");
  assert.notEqual(result.followBefore, result.followAfter, "The thread bell must change the follow.");
  assert.equal(result.bellLevel, "Just mentions", "The header bell must keep the level the reader chose.");
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
