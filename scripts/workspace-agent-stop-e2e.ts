// Checks Stop on a working agent in the workspace, as Slack shows it next to "is working…": in the
// channel and in a thread, with a mouse on a desktop and with taps on an iPhone. It runs against a
// running Storybook that renders the real web workspace with agents at work. Pass the URL that
// `bun run storybook` reports: `bun scripts/workspace-agent-stop-e2e.ts --storybook=http://localhost:6006`.
// `--browser-executable=<path>` picks a Chromium build; Playwright's own is the default.
// Writes .openbot-build/workspace-agent-stop-e2e/report.json and a screenshot of each surface.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, chromium, devices, type Locator, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/workspace-agent-stop-e2e");
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
const browserExecutable = process.argv
  .find((arg) => arg.startsWith("--browser-executable="))
  ?.slice("--browser-executable=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

const STORY = "web-workspace--agent-working";
const PHONE: BrowserContextOptions = { ...devices["iPhone 13"] };
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };

interface StopResult {
  /** The Stop button showed next to "<agent> is working…". */
  shown: boolean;
  /** A press 18 px above the button's middle still lands on it: the hit area of a finger. */
  hitAbove: boolean;
  /** The working line of the agent went away after Stop. */
  stopped: boolean;
}

interface Report {
  desktop?: { channel: StopResult; thread: StopResult };
  phone?: { channel: StopResult; thread: StopResult };
  passed: boolean;
}

const report: Report = { passed: false };

async function openStory(browser: Browser, options: BrowserContextOptions): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story`, { waitUntil: "load", timeout: 180_000 });
  // A cold Storybook bundles its dependencies on the first load.
  await page.getByText("general", { exact: true }).first().waitFor({ timeout: 120_000 });
  return page;
}

/** Whether a press above the middle of the element lands on it. */
async function hitAbove(button: Locator): Promise<boolean> {
  return button.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2 - 18);
    return hit !== null && element.contains(hit);
  });
}

/** Stops the agent from its working line in `scope` and waits until the line goes. */
async function stopAgent(scope: Locator, agent: string, touch: boolean): Promise<StopResult> {
  const line = scope.locator(".ws-typing").getByText(`${agent} is working…`);
  await line.waitFor({ timeout: 30_000 });
  const button = scope.getByRole("button", { name: `Stop ${agent}` });
  await button.waitFor({ timeout: 10_000 });
  const shown = await button.isVisible();
  const above = await hitAbove(button);
  if (touch) await button.tap();
  else await button.click();
  await line.waitFor({ state: "detached", timeout: 15_000 });
  return { shown, hitAbove: above, stopped: true };
}

async function run(browser: Browser, options: BrowserContextOptions, touch: boolean, name: "desktop" | "phone") {
  const page = await openStory(browser, options);
  const press = (locator: Locator) => (touch ? locator.tap() : locator.click());
  await press(page.getByText("general", { exact: true }).first());
  const channel = page.locator("section.ws-channel-pane");
  await channel.waitFor({ timeout: 30_000 });
  await channel.locator(".ws-typing").getByText("Chief is working…").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: resolve(OUT, `${name}-channel-working.png`) });
  const channelResult = await stopAgent(channel, "Chief", touch);
  await page.screenshot({ path: resolve(OUT, `${name}-channel-stopped.png`) });

  await press(channel.getByRole("button", { name: /repl/i }).first());
  const thread = page.locator("section.ws-thread-panel");
  await thread.locator(".ws-typing").getByText("Research is working…").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: resolve(OUT, `${name}-thread-working.png`) });
  const threadResult = await stopAgent(thread, "Research", touch);
  await page.screenshot({ path: resolve(OUT, `${name}-thread-stopped.png`) });
  await page.context().close();
  return { channel: channelResult, thread: threadResult };
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), args: ["--no-sandbox"] } : {},
);
try {
  report.desktop = await run(browser, DESKTOP, false, "desktop");
  report.phone = await run(browser, PHONE, true, "phone");
  for (const surface of [report.desktop, report.phone])
    for (const result of [surface.channel, surface.thread]) {
      assert.equal(result.shown, true, "Stop must show next to a working agent.");
      assert.equal(result.stopped, true, "Stop must end the agent's work.");
    }
  assert.equal(report.phone.channel.hitAbove, true, "On a phone, Stop must take a press 44 px high.");
  assert.equal(report.phone.thread.hitAbove, true, "On a phone, Stop must take a press 44 px high.");
  report.passed = true;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
