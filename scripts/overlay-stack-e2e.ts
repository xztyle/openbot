// Checks the overlay stack in a running Storybook: a dialog that opens from a menu, a select, a
// menu and a popover inside it, a dialog and a confirmation that open from it, and a toast over it.
// Each surface must be the one under the pointer and take the press, with a mouse on a desktop
// window and with taps on a phone. Pass the URL that `bun run storybook` reports:
// `bun scripts/overlay-stack-e2e.ts --storybook=http://localhost:6006`.
// `--browser-executable=<path>` picks a Chromium build; Playwright's own is the default.
// Writes .openbot-build/overlay-stack-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, chromium, devices, type Locator } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/overlay-stack-e2e");
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
const browserExecutable = process.argv
  .find((arg) => arg.startsWith("--browser-executable="))
  ?.slice("--browser-executable=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

const STORY = "foundations-overlay-stack--nested-surfaces";

interface RunResult {
  /** Surfaces whose control was not the element under its own center. */
  covered: string[];
  log: string[];
  /** The body's pointer-events after every surface closed. */
  bodyPointerEvents: string;
}

const report: { desktop?: RunResult; phone?: RunResult; passed: boolean } = { passed: false };

async function run(browser: Browser, options: BrowserContextOptions, touch: boolean): Promise<RunResult> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story`, { waitUntil: "load", timeout: 180_000 });
  // A cold Storybook bundles its dependencies on the first load.
  await page.getByRole("button", { name: "Agent actions" }).waitFor({ timeout: 120_000 });
  const covered: string[] = [];

  /** Presses a control after checking that nothing covers it, as a person would see it. */
  async function press(name: string, control: Locator): Promise<void> {
    await control.waitFor({ timeout: 10_000 });
    // A surface that is still sliding in may sit beside its final place for a frame or two.
    const onTop = await control
      .evaluate(
        (element) =>
          new Promise<boolean>((resolveOnTop) => {
            const deadline = performance.now() + 1_000;
            const check = () => {
              const box = element.getBoundingClientRect();
              const top = element.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
              if (top !== null && (top === element || element.contains(top))) resolveOnTop(true);
              else if (performance.now() > deadline) resolveOnTop(false);
              else requestAnimationFrame(check);
            };
            check();
          }),
      )
      .catch(() => false);
    if (!onTop) covered.push(name);
    await (touch ? control.tap({ timeout: 5_000 }) : control.click({ timeout: 5_000 }));
  }
  const dialog = (name: string) => page.getByRole("dialog", { name });

  await press("menu trigger", page.getByRole("button", { name: "Agent actions" }));
  await press("menu item opens a dialog", page.getByRole("menuitem", { name: "Edit details" }));
  await dialog("Edit details").waitFor();

  const name = page.getByRole("textbox", { name: "Agent name" });
  await press("dialog input", name);
  await page.keyboard.press("End");
  await page.keyboard.type(" 2");

  await press("select in dialog", page.getByRole("button", { name: /Role/ }));
  await press("select option", page.getByRole("option", { name: "Viewer" }));

  await press("menu in dialog", page.getByRole("button", { name: "More actions" }));
  await press("menu item in dialog", page.getByRole("menuitem", { name: "Duplicate" }));

  await press("popover in dialog", page.getByRole("button", { name: "Help" }));
  await press("popover input", page.getByRole("textbox", { name: "Search names" }));
  await page.keyboard.type("re");
  await press("popover button", page.getByRole("button", { name: "Idea 3", exact: true }));
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Names" }).waitFor({ state: "detached" });

  await press("button that shows a toast", page.getByRole("button", { name: "Save draft" }));
  await press("toast action over a dialog", page.getByRole("button", { name: "Undo" }));
  assert.equal(await dialog("Edit details").count(), 1, "A press on a toast must leave the dialog open.");

  await press("button that opens a dialog", page.getByRole("button", { name: "Open avatar dialog" }));
  await dialog("Change avatar").waitFor();
  await press("input in the second dialog", page.getByRole("textbox", { name: "Avatar letter" }));
  await page.keyboard.type("S");
  await press("button in the second dialog", page.getByRole("button", { name: "Use avatar" }));
  await dialog("Change avatar").waitFor({ state: "detached" });

  await press("menu in dialog, again", page.getByRole("button", { name: "More actions" }));
  await press("menu item opens a second dialog", page.getByRole("menuitem", { name: "Change avatar" }));
  await dialog("Change avatar").waitFor();
  await press("second dialog from a menu", page.getByRole("button", { name: "Use avatar" }));
  await dialog("Change avatar").waitFor({ state: "detached" });

  await press("button that confirms", page.getByRole("button", { name: "Delete", exact: true }));
  await page.getByRole("alertdialog").waitFor();
  await press("confirmation", page.getByRole("alertdialog").getByRole("button", { name: "Delete" }));
  await page.getByRole("alertdialog").waitFor({ state: "detached" });

  await press("dialog after its children closed", page.getByRole("button", { name: "Save", exact: true }));
  await dialog("Edit details").waitFor({ state: "detached" });

  await press("menu item that confirms after the menu closes", page.getByRole("button", { name: "Agent actions" }));
  await press("confirmation from a menu", page.getByRole("menuitem", { name: "Delete agent" }));
  await page.getByRole("alertdialog").waitFor();
  await press("confirmation cancel", page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }));
  await page.getByRole("alertdialog").waitFor({ state: "detached" });

  const result: RunResult = {
    covered,
    log: await page.getByRole("list", { name: "Overlay log" }).getByRole("listitem").allInnerTexts(),
    bodyPointerEvents: await page.evaluate(() => document.body.style.pointerEvents),
  };
  await context.close();
  return result;
}

const expectedLog = [
  "role Viewer",
  "duplicated",
  "search r",
  "search re",
  "idea Idea 3",
  "undo",
  "avatar changed",
  "avatar changed",
  "deleted",
  "saved Research 2 Viewer",
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), args: ["--no-sandbox"] } : {},
);
try {
  report.desktop = await run(browser, { viewport: { width: 1280, height: 800 } }, false);
  report.phone = await run(browser, { ...devices["iPhone 13"] }, true);
  for (const [label, result] of [
    ["desktop", report.desktop],
    ["phone", report.phone],
  ] as const) {
    assert.deepEqual(result.covered, [], `${label}: a surface was covered by another one.`);
    assert.deepEqual(result.log, expectedLog, `${label}: a press did not reach its surface.`);
    assert.equal(result.bodyPointerEvents, "", `${label}: the page must take presses after every surface closed.`);
  }
  report.passed = true;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
