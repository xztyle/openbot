// Checks that the composer's @ mention picker takes a tap on a phone, a click and the keys, in a
// running Storybook that renders the real web workspace, and that Return adds a line on a phone
// while Enter sends on a desktop. Pass the URL that `bun run storybook`
// reports: `bun scripts/mention-picker-touch-e2e.ts --storybook=http://localhost:6006`.
// `--browser-executable=<path>` picks a Chromium build; Playwright's own is the default.
// Writes .openbot-build/mention-picker-touch-e2e/report.json and a screenshot of the phone thread.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, chromium, devices, type Locator, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/mention-picker-touch-e2e");
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
const browserExecutable = process.argv
  .find((arg) => arg.startsWith("--browser-executable="))
  ?.slice("--browser-executable=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

const STORY = "web-workspace--slack-workspace";
const PHONE: BrowserContextOptions = { ...devices["iPhone 13"] };

interface IosTapGuards {
  /** iOS sends a synthetic mousedown at the end of a tap. The picker must cancel it to keep focus. */
  mousedownCancelled: boolean;
  /** Clicks that reached the page from the tap. A tap selects at touchend and cancels the click. */
  clicksAfterTap: number;
}

interface CaseResult {
  mentions: string[];
  /** Times the editor lost the focus during the press. A phone keyboard closes on each one. */
  editorBlurs: number;
  editorFocused: boolean;
  pickerClosed: boolean;
}

interface Report {
  phoneTap?: CaseResult & IosTapGuards;
  phoneDragSelectsNothing?: { mentions: string[]; pickerOpen: boolean };
  phoneFilteredTap?: CaseResult;
  desktopClick?: CaseResult;
  desktopKeyboard?: CaseResult;
  /** On a phone Return adds a line and the draft stays; on a desktop Enter sends it. */
  phoneReturn?: { text: string; sent: boolean };
  desktopEnter?: { text: string; sent: boolean };
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

/** Opens the first thread of #general and returns its reply editor. */
async function openThreadEditor(page: Page, touch: boolean): Promise<Locator> {
  const press = (locator: Locator) => (touch ? locator.tap() : locator.click());
  await press(page.getByText("general", { exact: true }).first());
  await press(page.getByRole("button", { name: /repl/i }).first());
  const editor = page.getByRole("textbox", { name: /Reply in the thread/ });
  await editor.waitFor({ timeout: 30_000 });
  await press(editor);
  await editor.evaluate((element) => {
    element.addEventListener("blur", () => {
      element.dataset.e2eBlurs = String(Number(element.dataset.e2eBlurs ?? "0") + 1);
    });
  });
  return editor;
}

async function result(page: Page, editor: Locator): Promise<CaseResult> {
  return {
    mentions: await editor
      .locator("[data-mention-name]")
      .evaluateAll((tokens) => tokens.map((token) => token.getAttribute("data-mention-name") ?? "")),
    editorBlurs: Number((await editor.getAttribute("data-e2e-blurs")) ?? "0"),
    editorFocused: await editor.evaluate((element) => element.ownerDocument.activeElement === element),
    pickerClosed: (await page.getByRole("listbox").count()) === 0,
  };
}

/** A finger that moves across an option: the list may scroll, and nothing is picked. */
async function touchDrag(page: Page, target: Locator, dx: number): Promise<void> {
  const box = await target.boundingBox();
  assert.ok(box, "The option has no box to drag across.");
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number) => [{ x, y: box.y + box.height / 2, id: 1 }];
  const startX = box.x + 20;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(startX) });
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(startX + (dx * step) / 8) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), args: ["--no-sandbox"] } : {},
);
try {
  const phone = await openStory(browser, PHONE);
  const phoneEditor = await openThreadEditor(phone, true);
  await phone.keyboard.type("@");
  const research = phone.getByRole("option", { name: /Research/ });
  await research.waitFor({ timeout: 10_000 });

  await touchDrag(phone, research, 120);
  report.phoneDragSelectsNothing = {
    mentions: (await result(phone, phoneEditor)).mentions,
    pickerOpen: (await phone.getByRole("listbox").count()) > 0,
  };
  assert.deepEqual(report.phoneDragSelectsNothing.mentions, [], "A drag across an option must not pick it.");
  assert.equal(report.phoneDragSelectsNothing.pickerOpen, true, "A drag must leave the picker open.");

  const mousedownCancelled = await research.evaluate(
    (element) => !element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })),
  );
  await phone.evaluate(() => {
    document.documentElement.dataset.e2eClicks = "0";
    document.addEventListener(
      "click",
      () => {
        const root = document.documentElement;
        root.dataset.e2eClicks = String(Number(root.dataset.e2eClicks) + 1);
      },
      true,
    );
  });
  await research.tap();
  await phoneEditor.locator('[data-mention-name="Research"]').waitFor({ timeout: 5_000 });
  report.phoneTap = {
    ...(await result(phone, phoneEditor)),
    mousedownCancelled,
    clicksAfterTap: Number(await phone.evaluate(() => document.documentElement.dataset.e2eClicks)),
  };
  assert.equal(report.phoneTap.mousedownCancelled, true, "The picker must cancel mousedown to keep the keyboard.");
  assert.equal(report.phoneTap.clicksAfterTap, 0, "The tap must select at touchend, before a click can land.");
  assert.deepEqual(report.phoneTap.mentions, ["Research"]);
  assert.equal(report.phoneTap.editorBlurs, 0, "A tap on an option must keep the editor focused.");
  assert.equal(report.phoneTap.editorFocused, true);
  assert.equal(report.phoneTap.pickerClosed, true);

  await phone.keyboard.type("@chi");
  const chief = phone.getByRole("option", { name: /Chief/ });
  await chief.waitFor({ timeout: 10_000 });
  // The layout height: the panel's entrance animation scales the box for a moment.
  const optionHeight = await chief.evaluate((element) => (element instanceof HTMLElement ? element.offsetHeight : 0));
  assert.ok(optionHeight >= 44, `An option on a phone must be at least 44px high, not ${optionHeight}px.`);
  await chief.tap();
  await phoneEditor.locator('[data-mention-name="Chief"]').waitFor({ timeout: 5_000 });
  report.phoneFilteredTap = await result(phone, phoneEditor);
  assert.deepEqual(report.phoneFilteredTap.mentions, ["Research", "Chief"]);
  assert.equal(report.phoneFilteredTap.editorBlurs, 0);
  await phone.screenshot({ path: resolve(OUT, "phone-thread.png") });

  await phone.keyboard.type("hi");
  await phone.keyboard.press("Enter");
  await phone.keyboard.type("there");
  const phoneText = await phoneEditor.innerText();
  report.phoneReturn = { text: phoneText, sent: phoneText.trim() === "" };
  assert.equal(report.phoneReturn.sent, false, "Return on a phone must not send.");
  assert.match(phoneText, /hi\s*\nthere/u, "Return on a phone must add a line.");

  const desktop = await openStory(browser, { viewport: { width: 1280, height: 800 } });
  const desktopEditor = await openThreadEditor(desktop, false);
  await desktop.keyboard.type("@");
  await desktop.getByRole("option", { name: /Research/ }).click();
  await desktopEditor.locator('[data-mention-name="Research"]').waitFor({ timeout: 5_000 });
  report.desktopClick = await result(desktop, desktopEditor);
  assert.deepEqual(report.desktopClick.mentions, ["Research"]);
  assert.equal(report.desktopClick.editorBlurs, 0, "A click on an option must keep the editor focused.");

  await desktop.keyboard.type("@chi");
  await desktop.getByRole("option", { name: /Chief/ }).waitFor({ timeout: 10_000 });
  await desktop.keyboard.press("Enter");
  await desktopEditor.locator('[data-mention-name="Chief"]').waitFor({ timeout: 5_000 });
  report.desktopKeyboard = await result(desktop, desktopEditor);
  assert.deepEqual(report.desktopKeyboard.mentions, ["Research", "Chief"]);
  assert.equal(report.desktopKeyboard.pickerClosed, true);

  await desktop.keyboard.type("hello");
  await desktop.keyboard.press("Enter");
  await desktop.waitForFunction((element) => element?.textContent?.trim() === "", await desktopEditor.elementHandle(), {
    timeout: 10_000,
  });
  report.desktopEnter = { text: await desktopEditor.innerText(), sent: true };

  report.passed = true;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
