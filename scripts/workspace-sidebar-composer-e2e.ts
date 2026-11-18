// Walks the Slack sidebar and the message box of the web workspace on a computer and on an iPhone:
// sections (new, move a conversation in, Starred, rename, delete with Undo), the sort and the filter
// of a section, all kept across a reload; the draft pencil and the Drafts & sent view (open and
// delete a draft, open a sent message); the edit of a message in place (Enter saves, Escape cancels,
// "(edited)") and in the box on a phone; and emoji by short code. It serves the web client on a mock
// host (`src/renderer/stories/web-client-harness.tsx`, the "Spaces workspace" story) and drives it in
// Chromium. Then it checks the host side without a browser: the sidebar store keeps the new fields,
// the wire codec of an older host drops them, and the message search lists a member's sent messages.
//
// `bun scripts/workspace-sidebar-composer-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/workspace-sidebar-composer-e2e/report.json and a screenshot of each step.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  decodeWorkspaceSidebarPrefs,
  rebaseWorkspaceSidebar,
  type WorkspaceSidebarPrefs,
} from "@openbot/contracts/ipc";
import {
  WORKSPACE_SIDEBAR_CODECS,
  WORKSPACE_SIDEBAR_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-sidebar-v1";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { Effect } from "effect";
import { type Browser, type BrowserContextOptions, chromium, type Locator, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";
import { WorkspaceSidebarStore } from "../src/main/workspace-sidebar-store";

const logger = createOpenBotLogger("workspace-sidebar-composer-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/workspace-sidebar-composer-e2e");
const UI_WAIT_MS = 60_000;
const english = translateFor("en");
const COMMIT = { waitUntil: "commit" } as const;

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const satisfies Record<string, BrowserContextOptions>;
type ViewportName = keyof typeof VIEWPORTS;
const VIEWPORT_NAMES: readonly ViewportName[] = ["desktop", "phone"];

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-harness.tsx"></script>
  </body>
</html>`;

/** Serves the harness page at `/app` and every address under it, as the site's `/app/$` route does. */
function webClientPages(): Plugin {
  return {
    name: "openbot-sidebar-composer-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        if (!/^\/app(?:[/?]|$)/u.test(url)) return next();
        const html = await server.transformIndexHtml(url, HARNESS);
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      });
    },
  };
}

interface Step {
  viewport: ViewportName | "host";
  name: string;
  passed: boolean;
  detail?: string;
}

const report: {
  steps: Step[];
  pageErrors: string[];
  consoleErrors: string[];
  screenshots: string[];
  passed: boolean;
} = { steps: [], pageErrors: [], consoleErrors: [], screenshots: [], passed: false };

async function step(
  page: Page | null,
  viewport: ViewportName | "host",
  name: string,
  check: () => Promise<void>,
): Promise<void> {
  try {
    await check();
    report.steps.push({ viewport, name, passed: true });
  } catch (error) {
    report.steps.push({ viewport, name, passed: false, detail: String(error).slice(0, 800) });
    if (page) {
      const shot = resolve(OUT, `${viewport}-${report.steps.length}-failed.png`);
      await page.screenshot({ path: shot }).catch(() => undefined);
      report.screenshots.push(shot);
    }
    throw error;
  }
}

async function shot(page: Page, label: string): Promise<void> {
  const file = resolve(OUT, `${label}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(file);
}

const sidebarOf = (page: Page) =>
  page.getByRole("navigation", { name: english("workspace.sidebar.label"), exact: true });
const sectionNamed = (page: Page, name: string) => sidebarOf(page).getByRole("region", { name, exact: true });
const channelRow = (scope: Locator, name: string) =>
  scope.getByRole("button", { name: new RegExp(`^${english("workspace.sidebar.publicChannel", { name })}`, "u") });
const anaRow = (scope: Locator) => scope.getByRole("button", { name: /^Ana, / });

/** On a phone the workspace shows one pane: Back shows the sidebar. */
async function showSidebar(page: Page, viewport: ViewportName): Promise<void> {
  if (viewport !== "phone") return;
  const sidebar = sidebarOf(page);
  if (await sidebar.isVisible()) return;
  const back = page.getByRole("button", { name: english("workspace.layout.back"), exact: true }).first();
  if (await back.isVisible()) await back.click();
  // Back shows the tab the conversation came from; the list is the Home tab.
  if (!(await sidebar.isVisible()))
    await page
      .getByRole("navigation", { name: english("workspace.phone.tabs") })
      .getByRole("button", { name: new RegExp(`^${english("workspace.phone.home")}`, "u") })
      .click();
  await sidebar.waitFor({ timeout: UI_WAIT_MS });
}

/** Drafts & sent: a top row of the sidebar on a computer, a shortcut of Home on a phone. */
function draftsEntry(page: Page, viewport: ViewportName): Locator {
  const name = new RegExp(`^${english("workspace.view.drafts")}`, "u");
  return viewport === "phone"
    ? page
        .getByRole("list", { name: english("workspace.phone.shortcuts") })
        .getByRole("button", { name })
        .first()
    : sidebarOf(page).getByRole("button", { name }).first();
}

/** Closes the toasts: a pointer that rests on one keeps it, and it covers the header on a phone. */
async function dismissToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const close of document.querySelectorAll<HTMLElement>("[data-sonner-toast] [data-close-button]"))
      close.click();
  });
  await page.locator("[data-sonner-toast]").first().waitFor({ state: "detached", timeout: UI_WAIT_MS });
}

async function press(target: Locator, viewport: ViewportName): Promise<void> {
  if (viewport === "phone") await target.tap();
  else await target.click();
}

/** Holds a finger on the element until the sheet of its actions opens, then lifts it. */
async function longPress(page: Page, target: Locator, sheetName: string): Promise<Locator> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert.ok(box, "The row has no box to press.");
  const point = [{ x: box.x + box.width / 2, y: box.y + Math.min(24, box.height / 2), id: 1 }];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
  const sheet = page.getByRole("dialog", { name: sheetName });
  await sheet.waitFor({ timeout: 5_000 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  return sheet;
}

/** The actions of a conversation row: the hover menu on a computer, the long-press sheet on a phone. */
async function rowAction(page: Page, viewport: ViewportName, row: Locator, label: string, item: string) {
  const menuName = english("workspace.sidebar.rowMenu", { name: label });
  if (viewport === "phone") {
    const sheet = await longPress(page, row, menuName);
    await sheet.getByRole("button", { name: item, exact: true }).tap();
    await sheet.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    return;
  }
  await row.hover();
  await row
    .locator("xpath=ancestor::div[contains(@class,'ws-sidebar-item')]")
    .getByRole("button", { name: menuName, exact: true })
    .click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/**
 * Opens the options of a section and picks one item: a sort, a filter, or a section action. A
 * computer shows them in a menu; a phone in a sheet, with Sort and Show as pressed buttons.
 */
async function sectionOption(page: Page, viewport: ViewportName, section: string, item: string, radio = false) {
  const label = english("workspace.sidebar.sectionMenu", { name: section });
  const trigger = sidebarOf(page).getByRole("button", { name: label, exact: true });
  if (viewport === "desktop") await trigger.hover();
  await press(trigger, viewport);
  if (viewport === "phone") {
    const sheet = page.getByRole("dialog", { name: label, exact: true });
    await press(sheet.getByRole("button", { name: item, exact: true }), viewport);
    await sheet.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    return;
  }
  const entry = page.getByRole(radio ? "menuitemradio" : "menuitem", { name: item, exact: true });
  await press(entry, viewport);
  await entry.waitFor({ state: "detached", timeout: UI_WAIT_MS });
}

async function radioChecked(page: Page, viewport: ViewportName, section: string, item: string): Promise<boolean> {
  const label = english("workspace.sidebar.sectionMenu", { name: section });
  const trigger = sidebarOf(page).getByRole("button", { name: label, exact: true });
  if (viewport === "desktop") await trigger.hover();
  await press(trigger, viewport);
  const entry =
    viewport === "phone"
      ? page.getByRole("dialog", { name: label, exact: true }).getByRole("button", { name: item, exact: true })
      : page.getByRole("menuitemradio", { name: item, exact: true });
  await entry.waitFor({ timeout: UI_WAIT_MS });
  const checked = (await entry.getAttribute(viewport === "phone" ? "aria-pressed" : "aria-checked")) === "true";
  if (viewport === "phone") await shot(page, `${viewport}-section-sheet`);
  await page.keyboard.press("Escape");
  await entry.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  return checked;
}

const composerOf = (page: Page, name: string) =>
  page.getByRole("textbox", { name: english("workspace.app.composer.messageChannel", { name }), exact: true });

async function walk(browser: Browser, origin: string, viewport: ViewportName): Promise<void> {
  const context = await browser.newContext(VIEWPORTS[viewport]);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(`${viewport}: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    // The dev server's own socket is no part of the client: a page left during a step drops it.
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource") &&
      !message.text().startsWith("[vite]")
    )
      report.consoleErrors.push(`${viewport}: ${message.text().slice(0, 1_000)}`);
  });
  const sectionName = viewport === "phone" ? "Phone projects" : "Projects";

  await step(page, viewport, "the workspace loads", async () => {
    await page.goto(`${origin}/app/general/activity`, COMMIT);
    await page
      .getByRole("heading", { name: english("workspace.view.activity"), exact: true })
      .waitFor({ timeout: UI_WAIT_MS });
  });

  // 1. A new section from the options of Channels, then #general moved into it from its row menu.
  await step(page, viewport, "New section makes a section, and a channel moves into it", async () => {
    await showSidebar(page, viewport);
    await sectionOption(
      page,
      viewport,
      english("workspace.sidebar.channels"),
      english("workspace.sidebar.section.new"),
    );
    const dialog = page.getByRole("dialog", { name: english("workspace.sidebar.section.createTitle"), exact: true });
    await dialog.waitFor({ timeout: UI_WAIT_MS });
    const create = dialog.getByRole("button", { name: english("workspace.sidebar.section.create"), exact: true });
    assert.equal(await create.isDisabled(), true, "Create section is off without a name");
    await dialog.getByRole("textbox", { name: english("workspace.sidebar.section.name") }).fill(sectionName);
    await shot(page, `${viewport}-new-section`);
    await press(create, viewport);
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    const section = sectionNamed(page, sectionName);
    await section.waitFor({ timeout: UI_WAIT_MS });
    await section.getByText(english("workspace.sidebar.sectionEmpty")).waitFor({ timeout: UI_WAIT_MS });
    await rowAction(
      page,
      viewport,
      channelRow(sidebarOf(page), "general").first(),
      "general",
      english("workspace.sidebar.section.moveTo", { name: sectionName }),
    );
    await channelRow(section, "general").waitFor({ timeout: UI_WAIT_MS });
    assert.equal(
      await channelRow(sectionNamed(page, english("workspace.sidebar.channels")), "general").count(),
      0,
      "#general shows in one section only",
    );
  });

  // 2. Starred: a DM goes to the Starred section, which shows only when it has rows.
  await step(page, viewport, "Star moves a DM to Starred", async () => {
    await rowAction(page, viewport, anaRow(sidebarOf(page)).first(), "Ana", english("workspace.sidebar.star"));
    const starred = sectionNamed(page, english("workspace.sidebar.starred"));
    await anaRow(starred).waitFor({ timeout: UI_WAIT_MS });
    assert.equal(await anaRow(sectionNamed(page, english("workspace.sidebar.directMessages"))).count(), 0);
  });

  // 3. Sort and filter of a section.
  await step(page, viewport, "Sort and Show of a section apply at once", async () => {
    const direct = english("workspace.sidebar.directMessages");
    await sectionOption(page, viewport, direct, english("workspace.sidebar.sort.alpha"), true);
    const labels = await sectionNamed(page, direct)
      .locator(".ws-sidebar-row-label")
      .evaluateAll((items) => items.map((item) => item.textContent?.trim() ?? ""));
    const rows = labels.filter((label) => !/^(New agent|Add teammates)$/u.test(label));
    assert.deepEqual(
      rows,
      [...rows].sort((left, right) => left.toLocaleLowerCase().localeCompare(right.toLocaleLowerCase())),
      "Alphabetical sorts the DMs by name",
    );
    await sectionOption(page, viewport, direct, english("workspace.sidebar.show.unreads"), true);
    const shown = await sectionNamed(page, direct)
      .locator("[data-ws-conversation]")
      .evaluateAll((items) => items.map((item) => item.getAttribute("aria-label") ?? ""));
    for (const label of shown)
      assert.match(
        label,
        new RegExp(`${english("workspace.sidebar.unread")}|mention`, "u"),
        `Unreads only shows a read row: ${label}`,
      );
    await shot(page, `${viewport}-unreads-only`);
  });

  // 4. Everything stays after a reload: the browser keeps the sidebar, the host gets it again.
  await step(page, viewport, "Sections, Starred, sort and filter stay after a reload", async () => {
    await page.reload(COMMIT);
    // The address keeps the place: Activity on a computer; on a phone the Home tab (its list) or a
    // conversation over it.
    await page
      .getByRole("heading", { name: english("workspace.view.activity"), exact: true })
      .or(sidebarOf(page))
      .or(page.getByRole("button", { name: english("workspace.layout.back"), exact: true }))
      .first()
      .waitFor({ timeout: UI_WAIT_MS });
    await showSidebar(page, viewport);
    await channelRow(sectionNamed(page, sectionName), "general").waitFor({ timeout: UI_WAIT_MS });
    await anaRow(sectionNamed(page, english("workspace.sidebar.starred"))).waitFor({ timeout: UI_WAIT_MS });
    const direct = english("workspace.sidebar.directMessages");
    assert.equal(await radioChecked(page, viewport, direct, english("workspace.sidebar.sort.alpha")), true);
    assert.equal(await radioChecked(page, viewport, direct, english("workspace.sidebar.show.unreads")), true);
    await sectionOption(page, viewport, direct, english("workspace.sidebar.show.all"), true);
    await shot(page, `${viewport}-sections`);
  });

  // 5. A draft: the pencil on its row, then the Drafts & sent view opens it and deletes it.
  const draftText = `Draft from the ${viewport}`;
  await step(page, viewport, "A draft shows a pencil on its row", async () => {
    await press(channelRow(sectionNamed(page, sectionName), "general"), viewport);
    const box = composerOf(page, "general");
    await box.waitFor({ timeout: UI_WAIT_MS });
    await press(box, viewport);
    await page.keyboard.type(draftText);
    await showSidebar(page, viewport);
    await press(anaRow(sidebarOf(page)).first(), viewport);
    await showSidebar(page, viewport);
    const general = channelRow(sidebarOf(page), "general").first();
    await page.waitForFunction(
      ({ name, draft }) =>
        [...document.querySelectorAll("[data-ws-conversation]")].some((row) => {
          const label = row.getAttribute("aria-label") ?? "";
          return label.startsWith(name) && label.includes(draft);
        }),
      {
        name: english("workspace.sidebar.publicChannel", { name: "general" }),
        draft: english("workspace.sidebar.hasDraft"),
      },
      { timeout: UI_WAIT_MS },
    );
    assert.ok(await general.isVisible());
    await shot(page, `${viewport}-draft-pencil`);
  });

  await step(page, viewport, "Drafts & sent opens a draft and deletes it", async () => {
    await press(draftsEntry(page, viewport), viewport);
    const view = page.getByRole("region", { name: english("workspace.view.drafts"), exact: true });
    await view.waitFor({ timeout: UI_WAIT_MS });
    const draft = view.getByRole("button", { name: english("workspace.drafts.edit", { name: "#general" }) }).first();
    await draft.waitFor({ timeout: UI_WAIT_MS });
    await view.getByText(draftText).waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-drafts`);
    await press(draft, viewport);
    const box = composerOf(page, "general");
    await box.waitFor({ timeout: UI_WAIT_MS });
    await page.waitForFunction(
      ({ label, text }) => document.querySelector(`[aria-label="${label}"]`)?.textContent?.includes(text) === true,
      { label: english("workspace.app.composer.messageChannel", { name: "general" }), text: draftText },
      { timeout: UI_WAIT_MS },
    );
    await showSidebar(page, viewport);
    await press(draftsEntry(page, viewport), viewport);
    await view.waitFor({ timeout: UI_WAIT_MS });
    await press(view.getByRole("button", { name: english("workspace.drafts.delete"), exact: true }).first(), viewport);
    await view.getByText(english("workspace.drafts.empty"), { exact: true }).waitFor({ timeout: UI_WAIT_MS });
    await dismissToasts(page);
  });

  await step(page, viewport, "Sent lists the reader's messages and opens one", async () => {
    const view = page.getByRole("region", { name: english("workspace.view.drafts"), exact: true });
    await press(view.getByRole("tab", { name: english("workspace.drafts.tab.sent") }), viewport);
    const sent = view.getByRole("button", { name: /standup in 5 minutes/u }).first();
    await sent.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-sent`);
    await press(sent, viewport);
    await composerOf(page, "general").waitFor({ timeout: UI_WAIT_MS });
  });

  // 6. Edit a message: in place on a computer (↑ in the empty box), in the box on a phone.
  if (viewport === "desktop") {
    await step(page, viewport, "Up in the empty box edits the last message in place; Escape cancels", async () => {
      const box = composerOf(page, "general");
      await box.click();
      await page.keyboard.press("ArrowUp");
      const editor = page.getByRole("textbox", { name: english("workspace.app.edit.label"), exact: true });
      await editor.waitFor({ timeout: UI_WAIT_MS });
      await page.locator("article.ws-message").filter({ has: editor }).waitFor({ timeout: UI_WAIT_MS });
      await page.keyboard.press("Escape");
      await editor.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    });
    await step(page, viewport, "Enter saves the edit in place and the message says edited", async () => {
      await composerOf(page, "general").click();
      await page.keyboard.press("ArrowUp");
      const editor = page.getByRole("textbox", { name: english("workspace.app.edit.label"), exact: true });
      await editor.waitFor({ timeout: UI_WAIT_MS });
      await page.keyboard.press("End");
      await page.keyboard.type(" today");
      await shot(page, `${viewport}-inline-edit`);
      await page.keyboard.press("Enter");
      await editor.waitFor({ state: "detached", timeout: UI_WAIT_MS });
      const edited = page.locator("article.ws-message", { hasText: "standup in 5 minutes today" });
      await edited.waitFor({ timeout: UI_WAIT_MS });
      await edited.getByText(english("workspace.message.edited")).waitFor({ timeout: UI_WAIT_MS });
    });
  } else {
    await step(page, viewport, "Edit from the message sheet edits in the box on a phone", async () => {
      const message = page.locator("article.ws-message", { hasText: "standup in 5 minutes" }).first();
      const sheet = await longPress(page, message, english("workspace.message.actions"));
      await sheet.getByRole("button", { name: english("workspace.app.message.edit"), exact: true }).tap();
      await page.getByText(english("workspace.app.composer.editing")).waitFor({ timeout: UI_WAIT_MS });
      const box = composerOf(page, "general");
      await box.tap();
      await page.keyboard.press("End");
      await page.keyboard.type(" now");
      await shot(page, `${viewport}-edit-in-box`);
      await page.getByRole("button", { name: english("workspace.composer.send"), exact: true }).tap();
      const edited = page.locator("article.ws-message", { hasText: "standup in 5 minutes now" });
      await edited.waitFor({ timeout: UI_WAIT_MS });
      await edited.getByText(english("workspace.message.edited")).waitFor({ timeout: UI_WAIT_MS });
    });
  }

  // 7. Emoji by short code, as Slack's `:tada`.
  await step(page, viewport, "A colon and a short code offer emoji", async () => {
    const box = composerOf(page, "general");
    await press(box, viewport);
    await page.keyboard.type("Ship it :tad");
    const list = page.getByRole("listbox", { name: english("composer.picker.emojiLabel") });
    await list.waitFor({ timeout: UI_WAIT_MS });
    await shot(page, `${viewport}-emoji`);
    await page.keyboard.press("Enter");
    await list.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await page.waitForFunction(
      (label) => document.querySelector(`[aria-label="${label}"]`)?.textContent?.includes("🎉") === true,
      english("workspace.app.composer.messageChannel", { name: "general" }),
      { timeout: UI_WAIT_MS },
    );
    // Clear the box, so the draft does not stay.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
  });

  // 8. Rename, then delete with Undo: the conversations go back, then come back with Undo.
  await step(page, viewport, "Rename and delete a section, and Undo brings it back", async () => {
    await showSidebar(page, viewport);
    await sectionOption(page, viewport, sectionName, english("workspace.sidebar.section.rename"));
    const dialog = page.getByRole("dialog", { name: english("workspace.sidebar.section.renameTitle"), exact: true });
    await dialog.waitFor({ timeout: UI_WAIT_MS });
    const renamed = `${sectionName} 2`;
    await dialog.getByRole("textbox", { name: english("workspace.sidebar.section.name") }).fill(renamed);
    await press(dialog.getByRole("button", { name: english("common.save"), exact: true }), viewport);
    await dialog.waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await channelRow(sectionNamed(page, renamed), "general").waitFor({ timeout: UI_WAIT_MS });
    await sectionOption(page, viewport, renamed, english("workspace.sidebar.section.delete"));
    await sectionNamed(page, renamed).waitFor({ state: "detached", timeout: UI_WAIT_MS });
    await channelRow(sectionNamed(page, english("workspace.sidebar.channels")), "general").waitFor({
      timeout: UI_WAIT_MS,
    });
    await press(page.getByRole("button", { name: english("common.undo"), exact: true }), viewport);
    await channelRow(sectionNamed(page, renamed), "general").waitFor({ timeout: UI_WAIT_MS });
    await dismissToasts(page);
    await shot(page, `${viewport}-section-restored`);
  });

  // 9. The keys of the sidebar: Left on a row goes to its section header; Left collapses it.
  if (viewport === "desktop")
    await step(page, viewport, "Left goes to the section header and collapses it; Right opens it", async () => {
      const row = channelRow(sidebarOf(page), "general").first();
      await row.focus();
      await page.keyboard.press("ArrowLeft");
      const header = sidebarOf(page)
        .getByRole("button", { name: new RegExp(`^${sectionName} 2`, "u") })
        .first();
      await page.waitForFunction(
        (name) => document.activeElement?.textContent?.trim().startsWith(name) === true,
        `${sectionName} 2`,
        { timeout: UI_WAIT_MS },
      );
      await page.keyboard.press("ArrowLeft");
      assert.equal(await header.getAttribute("aria-expanded"), "false");
      await page.keyboard.press("ArrowRight");
      assert.equal(await header.getAttribute("aria-expanded"), "true");
    });
  await context.close();
}

/** The host side: the store keeps the new fields; an older host's codec drops them; Sent lists. */
async function hostChecks(): Promise<void> {
  const prefs: WorkspaceSidebarPrefs = {
    order: { channels: ["general"], direct: [] },
    muted: [],
    collapsed: ["direct"],
    starred: ["dm-ana"],
    sections: [{ id: "section-1", name: "Projects", ids: ["general", "general"] }],
    groupOptions: [{ id: "direct", sort: "alpha", show: "unreads" }],
  };
  await step(null, "host", "the host store keeps sections, Starred and the group options", async () => {
    const folder = mkdtempSync(join(tmpdir(), "openbot-sidebar-"));
    try {
      const path = join(folder, "openbot-workspace-sidebar-v1.json");
      const store = new WorkspaceSidebarStore(path);
      await Effect.runPromise(store.load());
      await Effect.runPromise(store.set("member-a", prefs));
      const again = new WorkspaceSidebarStore(path);
      await Effect.runPromise(again.load());
      assert.deepEqual(again.get("member-a"), {
        ...prefs,
        // A repeated id keeps its first place.
        sections: [{ id: "section-1", name: "Projects", ids: ["general"] }],
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  await step(null, "host", "the wire codec carries the fields, and refuses a bad one", async () => {
    const codec = WORKSPACE_SIDEBAR_CODECS.get(WORKSPACE_SIDEBAR_ROUTES.save);
    assert.ok(codec);
    assert.deepEqual(codec.request(prefs), prefs);
    assert.throws(() => codec.request({ ...prefs, sections: [{ id: "s", name: " ", ids: [] }] }));
    assert.throws(() => codec.request({ ...prefs, groupOptions: [{ id: "direct", sort: "newest" }] }));
    assert.throws(() => decodeWorkspaceSidebarPrefs({ ...prefs, starred: [""] }));
    // Two sessions: Starred merges by id, the sections and the group options go whole.
    const theirs: WorkspaceSidebarPrefs = {
      ...prefs,
      starred: ["dm-ana", "dm-bo"],
      groupOptions: [{ id: "channels", sort: "recent" }],
    };
    const mine: WorkspaceSidebarPrefs = {
      ...prefs,
      starred: ["general"],
      sections: [{ id: "section-1", name: "Work", ids: ["dm-ana"] }],
    };
    const merged = rebaseWorkspaceSidebar(prefs, mine, theirs);
    assert.deepEqual(merged.starred, ["dm-bo", "general"], "Starred did not merge by id.");
    assert.deepEqual(merged.sections, [{ id: "section-1", name: "Work", ids: ["dm-ana"] }]);
    assert.deepEqual(merged.groupOptions, [{ id: "channels", sort: "recent" }]);
    // An older host's codec has no such fields: it keeps the rest and drops them.
    const { starred: _starred, sections: _sections, groupOptions: _groupOptions, ...older } = prefs;
    assert.deepEqual(decodeWorkspaceSidebarPrefs(older), older);
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: { entries: ["src/renderer/stories/web-client-harness.tsx"], include: ["@norbert_bodziony/bloub"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${address.port}`;
let browser: Browser | null = null;

try {
  await hostChecks().catch((error: unknown) => logger.warn(`host: ${String(error).slice(0, 300)}`));
  const executablePath = option("browser-executable");
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(executablePath ? { executablePath } : {}),
  });
  const only = option("only");
  for (const viewport of VIEWPORT_NAMES) {
    if (only && only !== viewport) continue;
    try {
      await walk(browser, origin, viewport);
    } catch (error) {
      logger.warn(`${viewport}: ${String(error).slice(0, 300)}`);
    }
  }
  report.passed =
    report.steps.length > 0 &&
    report.steps.every((item) => item.passed) &&
    report.pageErrors.length === 0 &&
    report.consoleErrors.length === 0;
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
logger.info(
  `${report.passed ? "Passed" : "Failed"}: ${report.steps.filter((item) => item.passed).length} of ${report.steps.length} steps. Report: ${resolve(OUT, "report.json")}`,
);
if (!report.passed) process.exitCode = 1;
