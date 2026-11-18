// Checks the message actions of the web workspace in a running Storybook. On a phone a long press
// opens one sheet (quick reactions, then Reply in thread, Mark unread, Save, Copy, Pin, Delete) and no
// action bar shows under the messages; on a desktop the right-click menu and the hover bar stay.
// Pass the URL that `bun run storybook` reports:
// `bun scripts/workspace-message-sheet-e2e.ts --storybook=http://localhost:6006`.
// `--browser-executable=<path>` picks a Chromium build; Playwright's own is the default.
// Writes .openbot-build/workspace-message-sheet-e2e/report.json and a screenshot of the sheet.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type BrowserContextOptions, chromium, devices, type Locator, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/workspace-message-sheet-e2e");
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
const browserExecutable = process.argv
  .find((arg) => arg.startsWith("--browser-executable="))
  ?.slice("--browser-executable=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

const STORY = "web-workspace--slack-workspace";
/** A top-level message of #general in the story, written by another member. */
const MESSAGE_TEXT = "compare our prices";

interface Report {
  phone?: {
    inlineActionBars: number;
    sheetItems: string[];
    openMenus: number;
    reactionAdded: boolean;
    emojiListShown: boolean;
    threadOpened: boolean;
  };
  desktop?: { menuItems: string[]; hoverBar: boolean };
  passed: boolean;
}

const report: Report = { passed: false };

async function openChannel(page: Page, touch: boolean): Promise<Locator> {
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story`, { waitUntil: "load", timeout: 180_000 });
  const general = page.getByText("general", { exact: true }).first();
  // A cold Storybook bundles its dependencies on the first load.
  await general.waitFor({ timeout: 120_000 });
  await (touch ? general.tap() : general.click());
  const message = page.locator("article.ws-message", { hasText: MESSAGE_TEXT });
  await message.waitFor({ timeout: 30_000 });
  await message.scrollIntoViewIfNeeded();
  return message;
}

/** Holds a finger on the element until the long press fires, then lifts it. */
async function longPress(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  assert.ok(box, "The message has no box to press.");
  const point = [{ x: box.x + box.width / 2, y: box.y + Math.min(24, box.height / 2), id: 1 }];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
  await page.getByRole("dialog", { name: "Message actions" }).waitFor({ timeout: 5_000 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), args: ["--no-sandbox"] } : {},
);
try {
  const phoneOptions: BrowserContextOptions = { ...devices["iPhone 13"] };
  const phone = await (await browser.newContext(phoneOptions)).newPage();
  const message = await openChannel(phone, true);
  const inlineActionBars = await phone.locator(".ws-message-actions").count();

  await longPress(phone, message);
  const sheet = phone.getByRole("dialog", { name: "Message actions" });
  const sheetItems = await sheet.locator(".ui-sheet-items").getByRole("button").allInnerTexts();
  const openMenus = await phone.getByRole("menu").count();
  await phone.screenshot({ path: resolve(OUT, "phone-sheet.png") });

  await sheet.getByRole("button", { name: "More emoji" }).tap();
  const emojiListShown =
    (await sheet.getByRole("region", { name: /emoji/i }).count()) === 1 &&
    (await sheet.locator(".ui-sheet-items").count()) === 0;
  await phone.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });

  await longPress(phone, message);
  await phone.getByRole("dialog", { name: "Message actions" }).getByRole("button", { name: /🎉/ }).tap();
  await phone.getByRole("dialog", { name: "Message actions" }).waitFor({ state: "detached" });
  const reactionAdded = (await message.locator(".ws-reaction", { hasText: "🎉" }).count()) === 1;

  await longPress(phone, message);
  await phone.getByRole("dialog", { name: "Message actions" }).getByRole("button", { name: "Reply in thread" }).tap();
  const threadOpened = await phone
    .getByRole("textbox", { name: /Reply in the thread/ })
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  report.phone = { inlineActionBars, sheetItems, openMenus, reactionAdded, emojiListShown, threadOpened };

  assert.equal(inlineActionBars, 0, "A phone must not draw an action bar under each message.");
  assert.equal(openMenus, 0, "A long press must open only the sheet, not a menu as well.");
  assert.equal(sheetItems[0], "Reply in thread");
  for (const item of ["Mark unread", "Save for later", "Copy text", "Copy link"])
    assert.ok(sheetItems.includes(item), `The sheet must offer "${item}".`);
  assert.equal(sheetItems.at(-1), "Delete message", "Delete must be the last action.");
  assert.equal(emojiListShown, true, "More emoji must show every emoji in the sheet.");
  assert.equal(reactionAdded, true, "A quick reaction in the sheet must react to the message.");
  assert.equal(threadOpened, true, "Reply in thread must open the thread.");

  const desktop = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const desktopMessage = await openChannel(desktop, false);
  await desktopMessage.hover();
  const hoverBar = await desktopMessage.locator(".ws-message-actions").isVisible();
  await desktopMessage.click({ button: "right", position: { x: 200, y: 20 } });
  const menu = desktop.getByRole("menu");
  await menu.waitFor({ timeout: 5_000 });
  report.desktop = { menuItems: await menu.getByRole("menuitem").allInnerTexts(), hoverBar };
  assert.equal(hoverBar, true, "A desktop keeps the hover action bar.");
  assert.equal(report.desktop.menuItems[0], "Reply in thread");
  for (const item of ["Mark unread", "Save for later", "Copy text", "Copy link"])
    assert.ok(report.desktop.menuItems.includes(item), `The menu must offer "${item}".`);

  report.passed = true;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
