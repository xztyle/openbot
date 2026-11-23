// Checks that Schedule opens from the More menu of the page rail and shows the calendar of the host
// that the app runs on, with its routines. It drives the real app against the preview mock in a
// running Storybook. Read-only. Pass the Storybook URL that `bun run storybook` reports:
// `bun scripts/schedule-open-e2e.ts --storybook=http://localhost:6006`.
// `--browser-executable=<path>` picks a Chromium build; Playwright's own is the default.
// The calendar of the host names its routine after the host, so a routine with another name is not
// the host's data. Writes .openbot-build/schedule-open-e2e/report.json and a screenshot.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { chromium, type Page } from "playwright-core";

declare global {
  interface Window {
    scheduleCalendarRequests?: string[];
  }
}

const OUT = resolve(import.meta.dirname, "../.openbot-build/schedule-open-e2e");
const t = translateFor("en");
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const browserExecutable = process.argv
  .find((arg) => arg.startsWith("--browser-executable="))
  ?.slice("--browser-executable=".length);

interface Report {
  host?: string;
  scheduleInMoreMenu?: boolean;
  requests?: string[];
  routines?: string[];
  passed: boolean;
}

const report: Report = { passed: false };

const rail = (page: Page) => page.getByRole("navigation", { name: t("app.rail.label") });

/** Opens Schedule from the rail's More menu. Schedule is not a rail button until the user pins it. */
async function openScheduleFromMoreMenu(page: Page): Promise<void> {
  const pinned = rail(page).getByRole("button", { name: t("app.rail.schedule"), exact: true });
  report.scheduleInMoreMenu = !(await pinned.isVisible());
  assert.ok(report.scheduleInMoreMenu, "Schedule is a rail button. It must start in the More menu.");
  await rail(page)
    .getByRole("button", { name: t("app.rail.more"), exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: new RegExp(`^${t("app.rail.schedule")}`, "u") })
    .first()
    .click();
  await page.getByRole("menu").waitFor({ state: "detached" });
}

/** Waits until the calendar is no longer loading, then fails on the load error. */
async function calendarReady(page: Page): Promise<void> {
  const schedule = page.getByRole("region", { name: t("routine.calendar.title") });
  await schedule.waitFor();
  await schedule
    .getByRole("status")
    .filter({ hasText: t("routine.calendar.loading") })
    .waitFor({ state: "detached" });
  assert.equal(await schedule.getByText(t("routine.calendar.loadFailed")).count(), 0, "The calendar shows its error.");
}

/** The routine names in the calendar's open view, from the run buttons ("<name>, <time>, <status>"). */
async function visibleRoutines(page: Page): Promise<string[]> {
  const runs = page
    .getByRole("region", { name: t("routine.calendar.title") })
    .getByRole("button", { name: /^Routine@/ });
  const labels = await runs.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
  return [...new Set(labels.map((label) => label.split(",")[0] ?? ""))];
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), args: ["--no-sandbox"] } : {},
);
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // No saved pins: the rail shows its default pages, and Schedule is in the More menu.
  await page.addInitScript(() => window.localStorage.removeItem("openbot:rail-pins"));
  await page.goto(`${storybook}/iframe.html?id=app--playground&viewMode=story`);
  await rail(page)
    .getByRole("button", { name: t("app.rail.more"), exact: true })
    .waitFor();
  // The host has one routine named after it, with a run in the next hour. Each request is recorded
  // with the server it asked.
  await page.evaluate(() => {
    const agent = window.openbot.agent;
    window.scheduleCalendarRequests = [];
    agent.routineCalendar = async (_input, server) => {
      const serverId = typeof server === "string" ? server : "local";
      window.scheduleCalendarRequests?.push(serverId);
      const at = new Date(Date.now() + 3_600_000).toISOString();
      return {
        routines: [
          {
            id: `routine-${serverId}`,
            name: `Routine@${serverId}`,
            owner: { kind: "agent", agentId: `agent-${serverId}` },
            active: true,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            schedule: { kind: "daily", time: "09:00" },
          },
        ],
        runs: [{ id: `run-${serverId}`, routineId: `routine-${serverId}`, at, status: "scheduled" }],
      };
    };
  });

  const host = (await page.evaluate(() => window.openbot.servers.list())).find((server) => server.active);
  assert.ok(host, "The preview has no active host.");
  report.host = host.id;

  await openScheduleFromMoreMenu(page);
  await page.waitForFunction(() => (window.scheduleCalendarRequests?.length ?? 0) > 0);
  await calendarReady(page);

  report.requests = await page.evaluate(() => window.scheduleCalendarRequests ?? []);
  report.routines = await visibleRoutines(page);
  assert.ok(
    report.requests.every((serverId) => serverId === host.id),
    "The calendar asked a server that is not the host.",
  );
  assert.deepEqual(report.routines, [`Routine@${host.id}`], "The calendar does not show the host's routine.");
  await page.screenshot({ path: resolve(OUT, "schedule.png") });
  report.passed = true;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
