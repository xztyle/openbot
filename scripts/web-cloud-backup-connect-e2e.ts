// Checks the owner's "Connect Proton Drive" flow of Server settings > Backups at phone width with touch:
// a wrong password, then the account's 2FA code, then the once-only password of the copies, which must
// be confirmed as saved. It drives the real panel in a running Storybook against a stubbed Proton
// backend (the story's calls), so no Proton account is used:
// `bun scripts/web-cloud-backup-connect-e2e.ts --storybook=http://localhost:6006`.
// `--browser-executable=<path>` picks a Chromium build; Playwright's own is the default.
// It also checks, at desktop and phone width, that the half-filled form survives a click outside it (a
// password manager's autofill popup) and the panel's status polling: nothing it typed is lost, the
// focus stays, polling waits while the form is open and starts again when it closes.
// Writes .openbot-build/web-cloud-backup-connect-e2e/report.json and a screenshot of each step.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { chromium } from "playwright-core";

declare global {
  interface Window {
    cloudBackupCalls?: string[];
    cloudBackupReads?: number;
  }
}

const OUT = resolve(import.meta.dirname, "../.openbot-build/web-cloud-backup-connect-e2e");
const t = translateFor("en");
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const browserExecutable = process.argv
  .find((arg) => arg.startsWith("--browser-executable="))
  ?.slice("--browser-executable=".length);

interface Report {
  steps: string[];
  keeps?: {
    width: number;
    open: boolean;
    email: string;
    password: string;
    mailbox: string;
    code: string;
    focused: boolean;
    readsWhileOpen: number;
  }[];
  calls?: string[];
  passed: boolean;
}
const report: Report = { steps: [], passed: false };

mkdirSync(OUT, { recursive: true });
let failurePage: import("playwright-core").Page | undefined;
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), args: ["--no-sandbox"] } : {},
);
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  failurePage = page;
  await page.goto(`${storybook}/iframe.html?id=servers-cloud-backups--not-connected&viewMode=story`);
  const connect = page.getByRole("button", { name: t("backups.cloud.connectProton"), exact: true });
  await connect.waitFor();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= 390, `The panel scrolls sideways at phone width (${width}px).`);
  await connect.tap();
  const dialog = page.getByRole("dialog", { name: t("backups.cloud.connect.title") });
  await dialog.waitFor();
  report.steps.push("dialog open");

  await dialog.getByLabel(t("backups.cloud.connect.email"), { exact: true }).fill("owner@proton.me");
  await dialog.getByLabel(t("backups.cloud.connect.password"), { exact: true }).fill("wrong");
  await dialog.getByRole("button", { name: t("backups.cloud.connect.submit") }).tap();
  await dialog.getByText(t("backups.cloud.problem.credentials")).waitFor();
  report.steps.push("wrong password explained");

  await dialog.getByLabel(t("backups.cloud.connect.password"), { exact: true }).fill("correct horse");
  await dialog.getByRole("button", { name: t("backups.cloud.connect.submit") }).tap();
  await dialog.getByText(t("backups.cloud.problem.twoFactor")).waitFor();
  report.steps.push("2FA asked");
  await page.screenshot({ path: resolve(OUT, "two-factor.png") });

  await dialog.getByLabel(t("backups.cloud.connect.twoFactor"), { exact: true }).fill("123456");
  await dialog.getByRole("button", { name: t("backups.cloud.connect.submit") }).tap();
  const saveDialog = page.getByRole("dialog", { name: t("backups.cloud.password.title") });
  await saveDialog.waitFor();
  const shown = await saveDialog.getByLabel(t("backups.cloud.password.title")).inputValue();
  assert.equal(shown, "Abcde-Fghij-Kmnop-Qrstu-Vwxyz-23456", "The copies' password is not shown once.");
  const done = saveDialog.getByRole("button", { name: t("backups.cloud.password.done") });
  assert.ok(await done.isDisabled(), "Done works before the owner confirms that the password is saved.");
  report.steps.push("password shown once");
  await page.screenshot({ path: resolve(OUT, "password.png") });

  await saveDialog.getByText(t("backups.cloud.password.confirm")).tap();
  await done.tap();
  await saveDialog.waitFor({ state: "detached" });
  await page.getByText("owner@proton.me").first().waitFor();
  await page.getByText(t("backups.cloud.warning.passwordNotSaved")).waitFor({ state: "detached" });
  report.steps.push("connected, password confirmed");

  report.calls = await page.evaluate(() => window.cloudBackupCalls ?? []);
  assert.deepEqual(report.calls, ["connect:no-code", "connect:no-code", "connect:code", "password-saved"]);
  await page.screenshot({ path: resolve(OUT, "connected.png"), fullPage: true });
  await context.close();

  // The form keeps what was typed through outside clicks and polls (every 5 s while a copy runs).
  report.keeps = [];
  for (const [width, height, touch] of [
    [1400, 900, false],
    [390, 844, true],
  ] as const) {
    const wide = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    const view = await wide.newPage();
    failurePage = view;
    await view.goto(`${storybook}/iframe.html?id=servers-cloud-backups--sign-in-again-while-copying&viewMode=story`);
    const relogin = view.getByRole("button", { name: t("backups.cloud.relogin") }).first();
    await relogin.waitFor();
    await relogin.click();
    const form = view.getByRole("dialog", { name: t("backups.cloud.connect.title") });
    await form.waitFor();
    await form.getByLabel(t("backups.cloud.connect.password"), { exact: true }).fill("correct horse");
    await form.getByText(t("backups.cloud.connect.twoPasswords")).click();
    await form.getByLabel(t("backups.cloud.connect.mailboxPassword"), { exact: true }).fill("mailbox pass");
    const code = form.getByLabel(t("backups.cloud.connect.twoFactor"), { exact: true });
    await code.fill("12");
    // A click in the page outside the form, as on an autofill popup.
    await view.mouse.click(5, 5);
    await code.focus();
    const readsOpen = await view.evaluate(() => window.cloudBackupReads ?? 0);
    // Three poll intervals: the panel must not read the host, redraw or close the form meanwhile.
    await view.waitForTimeout(16_000);
    const kept = {
      width,
      open: await form.isVisible(),
      email: await form.getByLabel(t("backups.cloud.connect.email"), { exact: true }).inputValue(),
      password: await form.getByLabel(t("backups.cloud.connect.password"), { exact: true }).inputValue(),
      mailbox: await form.getByLabel(t("backups.cloud.connect.mailboxPassword"), { exact: true }).inputValue(),
      code: await code.inputValue(),
      focused: await code.evaluate((element) => element === document.activeElement),
      readsWhileOpen: (await view.evaluate(() => window.cloudBackupReads ?? 0)) - readsOpen,
    };
    report.keeps.push(kept);
    assert.deepEqual(
      kept,
      {
        width,
        open: true,
        email: "owner@proton.me",
        password: "correct horse",
        mailbox: "mailbox pass",
        code: "12",
        focused: true,
        readsWhileOpen: 0,
      },
      `The sign-in form lost what was typed at ${width}px.`,
    );
    await view.keyboard.press("Escape");
    await form.waitFor({ state: "detached" });
    await view.waitForFunction((before) => (window.cloudBackupReads ?? 0) > before, readsOpen);
    await wide.close();
  }
  report.steps.push("form kept through outside clicks and polls, desktop and phone");

  // Folder, restore of some parts, and putting a copy back, at phone width.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const owner = await phone.newPage();
  failurePage = owner;
  await owner.goto(`${storybook}/iframe.html?id=servers-cloud-backups--connected&viewMode=story`);
  await owner.getByText(t("backups.cloud.folder", { folder: "Atelier Backups/Delynith" })).waitFor();
  await owner.getByRole("button", { name: t("backups.cloud.changeFolder") }).tap();
  const folder = owner.getByRole("dialog", { name: t("backups.cloud.folderTitle") });
  await folder.getByRole("button", { name: t("backups.cloud.browsePick", { name: "Atelier Delynith" }) }).tap();
  await folder.getByText(t("backups.cloud.folderHasCopies")).waitFor();
  await folder.getByRole("button", { name: t("backups.cloud.folderUse") }).tap();
  await folder.waitFor({ state: "detached" });
  await owner.getByText(t("backups.cloud.folder", { folder: "Atelier Backups/Atelier Delynith" })).waitFor();
  report.steps.push("folder changed to one with copies");

  await owner.getByRole("button", { name: t("backups.cloud.showCopies") }).tap();
  await owner
    .getByRole("button", { name: t("backups.cloud.restore") })
    .first()
    .tap();
  const restoreForm = owner.getByRole("dialog");
  await restoreForm.getByText(t("backups.cloud.restoreSome")).tap();
  await restoreForm.getByText(t("backups.cloud.group.database"), { exact: true }).tap();
  await restoreForm.getByRole("button", { name: t("backups.cloud.restoreConfirm") }).tap();
  await restoreForm.waitFor({ state: "detached" });
  report.steps.push("some parts of a copy restored");

  await owner
    .getByRole("button", { name: t("backups.cloud.apply") })
    .first()
    .tap();
  const applyForm = owner.getByRole("alertdialog").or(owner.getByRole("dialog"));
  await applyForm.getByText(t("backups.cloud.applyUnderstand")).tap();
  await applyForm.getByRole("button", { name: t("backups.cloud.applyConfirm") }).tap();
  await owner.waitForFunction(() => (window.cloudBackupCalls ?? []).some((call) => call.startsWith("apply:")));
  const ownerCalls = await owner.evaluate(() => window.cloudBackupCalls ?? []);
  assert.ok(ownerCalls.includes("folder:use:Atelier Backups/Atelier Delynith"), ownerCalls.join(" "));
  assert.ok(ownerCalls.includes("restore:7ee1041943923f17:database:"), ownerCalls.join(" "));
  await owner.screenshot({ path: resolve(OUT, "restore.png"), fullPage: true });
  report.steps.push("copy put back after the owner confirmed");
  await phone.close();
  report.passed = true;
} finally {
  if (!report.passed) await failurePage?.screenshot({ path: resolve(OUT, "failure.png"), fullPage: true });
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
