// Checks the owner's "Connect Proton Drive" flow of Server settings > Backups at phone width with touch:
// a wrong password, then the account's 2FA code, then the once-only password of the copies, which must
// be confirmed as saved. It drives the real panel in a running Storybook against a stubbed Proton
// backend (the story's calls), so no Proton account is used:
// `bun scripts/web-cloud-backup-connect-e2e.ts --storybook=http://localhost:6006`.
// `--browser-executable=<path>` picks a Chromium build; Playwright's own is the default.
// Writes .openbot-build/web-cloud-backup-connect-e2e/report.json and a screenshot of each step.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { chromium } from "playwright-core";

declare global {
  interface Window {
    cloudBackupCalls?: string[];
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
  report.passed = true;
} finally {
  if (!report.passed) await failurePage?.screenshot({ path: resolve(OUT, "failure.png"), fullPage: true });
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
