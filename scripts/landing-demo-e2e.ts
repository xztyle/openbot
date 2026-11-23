// End-to-end check of the home page and of the app demo (the `/app-preview` page).
//   bun scripts/landing-demo-e2e.ts [--origin=http://127.0.0.1:3100] [--browser-executable=<path>]
// 1. Starts the site's development server on a free port, or uses `--origin`.
// 2. Opens `/` in Chrome at 1440 px and at 390 px with touch, and checks the Atelier landing: the
//    heading, the workspace example, every call to action opens `/app`, the section links reach
//    their sections, a question of the FAQ opens, no horizontal scroll, and no page error. At 390 px
//    the bottom bar hides at the hero, shows below it and hides again at the last call to action.
// 3. Opens the demo in a same-origin frame that sends the start message, as a page that embeds the
//    demo does, in the Europe/Warsaw time zone, and checks:
//    - desktop 1440 px: exactly the four agents, no foreign helper agent, no update card and no time
//      zone toast; the visitor answers the channel question and the launch plan uses that answer;
//      reactions, unread replies and a fuller context meter at the end; a click on each teammate
//      plays its scene with its own model; a typed message gets the agent's scripted reply; the
//      sidebar groups the chats in sections with no People section, and the launch channel opens with
//      its history.
//    - mobile 390 px: the lead's chat takes the full width; the scene plays to the end with no visitor
//      and uses the automatic answer; Back shows the four agents in the workspace list.
//    - reduced motion: the end state shows at once, with no question to answer.
// Writes .openbot-build/landing-demo/report.json and the screenshots beside it.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import {
  LANDING_PREVIEW_READY_MESSAGE,
  LANDING_PREVIEW_START_MESSAGE,
} from "@openbot/contracts/landing-preview-messages";
import { createOpenBotLogger } from "@openbot/logging";
import { type Browser, chromium, type FrameLocator, type Locator, type Page } from "playwright-core";

const logger = createOpenBotLogger("landing-demo-e2e");

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/landing-demo");
const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const browserExecutable = option("browser-executable");
const givenOrigin = option("origin");

const TIME_ZONE = "Europe/Warsaw";
const IFRAME_TITLE = "Interactive OpenBot application preview";
const IFRAME = `iframe[title="${IFRAME_TITLE}"]`;
const AGENTS = ["Atlas", "Scout", "Forge", "Pulse"] as const;
const QUESTION = "Which channels should the launch use?";
const AUTO_ANSWER = "Blog and changelog, X, Newsletter";
const SCENE_PROMPTS: Record<string, string> = {
  Scout: "Could anything steal our news on Friday?",
  Forge: "Show me the launch banner before it ships.",
  Pulse: "How did people react to the teaser?",
};
// The first line of each scene's answer shows while it streams; the last shows when it is complete.
const SCENE_ANSWERS: Record<string, string> = {
  Scout: "Only one event is close, and it does not clash.",
  Forge: "Here is the banner from PR #418:",
  Pulse: "The teaser is doing well. Most replies ask about offline mode.",
};
const CHANNEL_LAST_LINE = "Nobody else launches on Friday morning. I will post here if that changes.";
const SCENE_ENDINGS: Record<string, string> = {
  Scout: "I will check again on Thursday evening and tell Atlas if anything moves.",
  Forge: "Approve the PR and I will merge it on Friday at 9:45.",
  Pulse: "I suggest that the X thread answers the offline question in the first post.",
};
const TYPED_MESSAGE = "Watch the replies about pricing too.";
const TYPED_REPLY = "Good call. I will watch the reactions to this and tell you if anything changes before Friday.";
// A scene waits for the visitor's answer for about 3 s; the whole autoplay takes about 15 s.
const SCENE_TIMEOUT_MS = 40_000;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close(() => done(address.port));
    });
  });

/** Resolves once Vite prints the address it listens on, or rejects when the server exits first. */
function waitForSite(child: ChildProcess, address: string): Promise<void> {
  return new Promise((done, fail) => {
    let output = "";
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(address)) done();
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("exit", () => fail(new Error("The site's development server stopped before it listened.")));
  });
}

interface OpenedDemo {
  page: Page;
  app: FrameLocator;
  errors: string[];
}

async function openDemo(
  browser: Browser,
  origin: string,
  viewport: { width: number; height: number },
  reducedMotion: "reduce" | "no-preference",
): Promise<OpenedDemo> {
  const context = await browser.newContext({ viewport, timezoneId: TIME_ZONE, reducedMotion, colorScheme: "dark" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // The home page no longer embeds the demo. A same-origin page hosts it as an embedding page does:
  // it waits for the demo's ready message and answers with the start message.
  await page.goto(`${origin}/terms`);
  await page.evaluate(
    ({ title, ready, start }) => {
      document.body.innerHTML = "";
      const host = document.createElement("section");
      host.className = "landing-app-preview";
      host.dataset.previewState = "loading";
      host.style.cssText = "position:fixed;inset:0;margin:0";
      const frame = document.createElement("iframe");
      frame.title = title;
      frame.style.cssText = "width:100%;height:100%;border:0";
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || event.data?.type !== ready) return;
        if (host.dataset.previewState === "shown") return;
        host.dataset.previewState = "shown";
        frame.contentWindow?.postMessage({ type: start }, window.location.origin);
      });
      frame.src = "/app-preview";
      host.append(frame);
      document.body.append(host);
    },
    { title: IFRAME_TITLE, ready: LANDING_PREVIEW_READY_MESSAGE, start: LANDING_PREVIEW_START_MESSAGE },
  );
  await page.locator('.landing-app-preview[data-preview-state="shown"]').waitFor({ timeout: SCENE_TIMEOUT_MS });
  lastDemoPage = page;
  return { page, app: page.frameLocator(IFRAME), errors };
}
/** The demo opened last: on a failure, its accessibility tree and a screenshot show what it drew. */
let lastDemoPage: Page | undefined;

/** The phone's bottom bar: shown or hidden. */
const barShown = (page: Page) => page.locator(".al-bar").getAttribute("data-shown");

/** Checks the Atelier home page at one width. Answers what it found. */
async function checkLanding(browser: Browser, width: number, height: number, touch: boolean) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/`);
    const heading = page.getByRole("heading", { level: 1 });
    await heading.waitFor();
    assert.match((await heading.textContent()) ?? "", /equipo de IA/u);
    const example = page.getByRole("figure", { name: /^Ejemplo del espacio de trabajo/u });
    assert.equal(await example.isVisible(), true, "The workspace example must show.");
    // Every call to action opens the app.
    const calls = page.getByRole("link", { name: /^(Abrir mi espacio|Abrir Atelier|Entrar)$/u });
    const targets = await calls.evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    assert.ok(targets.length >= 4, JSON.stringify(targets));
    assert.ok(
      targets.every((target) => target === "/app"),
      JSON.stringify(targets),
    );
    // Each in-page link reaches a section of the page. The section menu shows from 720 px; a phone
    // keeps the hero's "Ver cómo funciona".
    const anchors = await page.locator('a[href^="#"]').evaluateAll((links) =>
      links
        .filter((link) => link.getClientRects().length > 0)
        .map((link) => {
          const id = link.getAttribute("href")?.replace(/^#/u, "") ?? "";
          return { id, found: document.getElementById(id) !== null };
        }),
    );
    assert.ok(
      anchors.length >= (width >= 720 ? 4 : 1) && anchors.every((anchor) => anchor.found),
      JSON.stringify(anchors),
    );
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `The page scrolls sideways by ${overflow} px at ${width} px.`);
    await page.screenshot({ path: resolve(OUT, `landing-${width}.png`) });

    // A question of the FAQ opens its answer.
    const question = page.locator("#al-preguntas details").first();
    await question.locator("summary").scrollIntoViewIfNeeded();
    await (touch ? question.locator("summary").tap() : question.locator("summary").click());
    assert.equal(await question.evaluate((element) => element instanceof HTMLDetailsElement && element.open), true);

    let bar: { atHero: string | null; belowHero: string | null; atEnd: string | null } | undefined;
    if (touch) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForFunction(() => document.querySelector(".al-bar")?.getAttribute("data-shown") === "false");
      const atHero = await barShown(page);
      await page.locator("#al-como").scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector(".al-bar")?.getAttribute("data-shown") === "true");
      const belowHero = await barShown(page);
      await page.screenshot({ path: resolve(OUT, `landing-${width}-bar.png`) });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForFunction(() => document.querySelector(".al-bar")?.getAttribute("data-shown") === "false");
      bar = { atHero, belowHero, atEnd: await barShown(page) };
    }
    assert.deepEqual(errors, []);
    return { width, callsToAction: targets.length, sections: anchors.map((anchor) => anchor.id), bar };
  } finally {
    await context.close();
  }
}

const contextMeter = (app: FrameLocator) => app.locator('[aria-label^="Context "]').first();
const modelLabel = async (app: FrameLocator) =>
  (await app.getByRole("button", { name: /^Agent model: / }).getAttribute("aria-label")) ??
  (await app.getByRole("button", { name: /^Agent model: / }).textContent()) ??
  "";
/** The workspace sidebar: a DM row per agent, named "<agent>, AI agent[, <state>]". */
const chatList = (app: FrameLocator) => app.getByRole("navigation", { name: "Workspace" });
const agentRow = (app: FrameLocator, name: string) =>
  chatList(app).getByRole("button", { name: new RegExp(`^${name}, AI agent`, "u") });
/** The unread count in an agent's DM row: its replies to the person mention them. */
const unreadLabel = async (app: FrameLocator, name: string) =>
  (await agentRow(app, name).getAttribute("aria-label"))?.match(/\d+ mentions?/u)?.[0] ?? "none";
const CHANNEL_ROW = /^Channel launch/u;
const SECTIONS = ["Channels", "Direct messages"] as const;
const agentHeading = (app: FrameLocator, name: string) =>
  app.getByRole("heading", { name: new RegExp(`^${name}, open details`, "u"), level: 1 });
/** A text in the open chat or channel. The chat's live region also announces a new message; it is left out. */
const chatText = (app: FrameLocator, text: string | RegExp) =>
  app.getByRole("main").getByText(text).and(app.locator(":not([aria-live])"));
/** The teammates' reactions on a message: one button each, "<name> reacted with <emoji>". */
const reactions = (message: Locator) => message.getByRole("button", { name: / reacted with / });
const launchPlan = (app: FrameLocator) =>
  app.getByRole("article", { name: /^Atlas at / }).filter({
    has: app.getByRole("heading", { name: "Friday's launch plan" }),
  });

/** Checks what every view shows: the four agents, the channel, and none of the old noise or people. */
async function checkRoster(app: FrameLocator): Promise<string[]> {
  const rows = chatList(app).getByRole("button");
  await rows.first().waitFor({ timeout: SCENE_TIMEOUT_MS });
  const names = (await rows.allTextContents()).map((text) => text.trim());
  for (const agent of AGENTS) assert.equal(await agentRow(app, agent).count(), 1, `${agent}: ${names}`);
  assert.equal(await chatList(app).getByRole("button", { name: CHANNEL_ROW }).count(), 1, names.join(" | "));
  for (const section of SECTIONS) {
    assert.equal(await chatList(app).getByRole("region", { name: section }).count(), 1, section);
  }
  assert.equal(await chatList(app).getByRole("region", { name: "People" }).count(), 0, names.join(" | "));
  assert.equal(await app.getByText("Oh My Pi").count(), 0);
  assert.equal(await app.getByText("New update available").count(), 0);
  assert.equal(await app.getByText(/^Your time zone is now/u).count(), 0);
  return names;
}

const port = givenOrigin ? 0 : await freePort();
const origin = givenOrigin ?? `http://127.0.0.1:${port}`;
const site = givenOrigin
  ? null
  : spawn(
      process.execPath,
      [
        resolve(ROOT, "scripts/run-development.ts"),
        "api",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
let siteOutput = "";
site?.stdout?.on("data", (chunk: Buffer) => {
  siteOutput += chunk.toString();
});
site?.stderr?.on("data", (chunk: Buffer) => {
  siteOutput += chunk.toString();
});

try {
  if (site) await waitForSite(site, origin);
  const browser = await chromium.launch(
    browserExecutable ? { executablePath: browserExecutable } : { channel: "chrome" },
  );
  try {
    // The Atelier home page, on a computer and on a phone.
    const landing = [await checkLanding(browser, 1440, 900, false), await checkLanding(browser, 390, 844, true)];

    // Desktop: the visitor answers the question and clicks through the team.
    const desktop = await openDemo(browser, origin, { width: 1440, height: 900 }, "no-preference");
    const { app } = desktop;
    const roster = await checkRoster(app);
    const contextBefore = (await contextMeter(app).getAttribute("aria-label")) ?? "";

    const choices = app.getByRole("group", { name: QUESTION });
    await choices.waitFor({ timeout: SCENE_TIMEOUT_MS });
    await desktop.page.locator(".landing-app-preview").screenshot({ path: resolve(OUT, "desktop-question.png") });
    for (const channel of ["LinkedIn", "Product Hunt"]) {
      await choices.locator(`input[value="${channel}"]`).check();
    }
    await app.getByRole("button", { name: "Submit answer" }).click();
    const sent = app.getByRole("region", { name: "Answers sent" });
    await sent.getByText("LinkedIn, Product Hunt").waitFor();

    const plan = launchPlan(app);
    await plan.waitFor({ timeout: SCENE_TIMEOUT_MS });
    await reactions(plan).first().waitFor({ timeout: SCENE_TIMEOUT_MS });
    const reactionLabel = (
      await reactions(plan).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))
    ).join(", ");
    // The reactions come after the stream, so the table is complete.
    const channels = await plan.getByRole("row").allTextContents();
    assert.ok(
      channels.some((row) => row.startsWith("LinkedIn")),
      channels.join(" | "),
    );
    assert.ok(
      channels.some((row) => row.startsWith("Product Hunt") && row.includes("—")),
      channels.join(" | "),
    );
    assert.ok(!channels.some((row) => row.startsWith("Newsletter")), channels.join(" | "));
    await app.getByRole("button", { name: "Send message" }).waitFor();
    await app.locator(`[aria-label^="Context "]:not([aria-label="${contextBefore}"])`).waitFor();
    const contextAfter = (await contextMeter(app).getAttribute("aria-label")) ?? "";
    const unread: Record<string, boolean> = {};
    for (const agent of AGENTS.slice(1)) {
      unread[agent] = (await unreadLabel(app, agent)) === "1 mention";
    }
    assert.deepEqual(unread, { Scout: true, Forge: true, Pulse: true });
    const models: Record<string, string> = { Atlas: await modelLabel(app) };
    assert.ok(models.Atlas?.includes("Claude Opus 5.5"), models.Atlas);
    await desktop.page.locator(".landing-app-preview").screenshot({ path: resolve(OUT, "desktop-autoplay-end.png") });

    // A click on a teammate plays its scene, with the teammate's own model. The next click comes
    // while the answer streams, so each scene also ends at once when the visitor leaves.
    for (const agent of AGENTS.slice(1)) {
      await agentRow(app, agent).click();
      await agentHeading(app, agent).waitFor();
      const prompt = SCENE_PROMPTS[agent];
      const answer = SCENE_ANSWERS[agent];
      assert.ok(prompt && answer);
      await app.getByRole("article").filter({ hasText: prompt }).first().waitFor();
      await chatText(app, answer).waitFor({ timeout: SCENE_TIMEOUT_MS });
      models[agent] = await modelLabel(app);
      await desktop.page
        .locator(".landing-app-preview")
        .screenshot({ path: resolve(OUT, `desktop-${agent.toLowerCase()}.png`) });
    }
    assert.equal(new Set(Object.values(models)).size, AGENTS.length, JSON.stringify(models));

    // A typed message gets the agent's scripted reply, not the generic mock reply.
    await app.getByRole("button", { name: "Send message" }).waitFor();
    const composer = app.getByRole("textbox", { name: "Message Pulse" });
    await composer.fill(TYPED_MESSAGE);
    await composer.press("Enter");
    await chatText(app, TYPED_REPLY).waitFor({ timeout: SCENE_TIMEOUT_MS });
    await app.getByRole("button", { name: "Send message" }).waitFor();
    assert.equal(await chatText(app, /Mock reply/u).count(), 0);
    await desktop.page.locator(".landing-app-preview").screenshot({ path: resolve(OUT, "desktop-typed-reply.png") });

    // A scene that the visitor left while it streamed is complete, once, on return.
    const leftUnread: Record<string, string> = {};
    for (const agent of ["Scout", "Forge"]) {
      leftUnread[agent] = await unreadLabel(app, agent);
      await agentRow(app, agent).click();
      await agentHeading(app, agent).waitFor();
      const ending = SCENE_ENDINGS[agent];
      assert.ok(ending);
      await chatText(app, ending).waitFor();
      assert.equal(await chatText(app, ending).count(), 1, agent);
      assert.equal(await app.getByRole("button", { name: "Stop agent" }).count(), 0, agent);
    }

    // The launch channel opens with its history.
    await chatList(app).getByRole("button", { name: CHANNEL_ROW }).click();
    await chatText(app, CHANNEL_LAST_LINE).waitFor();
    await desktop.page.locator(".landing-app-preview").screenshot({ path: resolve(OUT, "desktop-channel.png") });
    assert.deepEqual(desktop.errors, []);
    await desktop.page.context().close();

    // The visitor leaves Atlas mid-scene: the scene ends at once with the automatic answer.
    const early = await openDemo(browser, origin, { width: 1440, height: 900 }, "no-preference");
    await early.app.getByRole("button", { name: /^Friday's launch, split across the team\./u }).waitFor({
      timeout: SCENE_TIMEOUT_MS,
    });
    await agentRow(early.app, "Scout").click();
    await agentHeading(early.app, "Scout").waitFor();
    await early.app.getByRole("button", { name: /^Atlas, AI agent, \d+ mentions?/u }).waitFor();
    await chatText(early.app, SCENE_ANSWERS.Scout ?? "").waitFor({ timeout: SCENE_TIMEOUT_MS });
    await agentRow(early.app, "Atlas").click();
    await launchPlan(early.app)
      .getByRole("button", { name: / reacted with / })
      .first()
      .waitFor();
    await early.app.getByRole("region", { name: "Answers sent" }).getByText(AUTO_ANSWER).waitFor();
    assert.equal(await early.app.getByRole("button", { name: "Submit answer" }).count(), 0);
    assert.equal(await early.app.getByRole("button", { name: "Stop agent" }).count(), 0);
    await early.page.locator(".landing-app-preview").screenshot({ path: resolve(OUT, "desktop-left-mid-scene.png") });
    assert.deepEqual(early.errors, []);
    await early.page.context().close();

    // Mobile: the demo opens on the lead's chat at the full width, and nobody answers, so the scene
    // uses the automatic answer. Back shows the workspace list with the four agents, one under the other.
    const mobile = await openDemo(browser, origin, { width: 390, height: 844 }, "no-preference");
    await agentHeading(mobile.app, "Atlas").waitFor({ timeout: SCENE_TIMEOUT_MS });
    await mobile.app
      .getByRole("region", { name: "Answers sent" })
      .getByText(AUTO_ANSWER)
      .waitFor({ timeout: SCENE_TIMEOUT_MS });
    await reactions(launchPlan(mobile.app)).first().waitFor({ timeout: SCENE_TIMEOUT_MS });
    const chatBox = await mobile.app.getByRole("main", { name: "Conversation" }).boundingBox();
    assert.ok(
      chatBox && Math.round(chatBox.width) === 390,
      `The phone chat is not full width: ${JSON.stringify(chatBox)}`,
    );
    await mobile.page.locator(".landing-app-preview").screenshot({ path: resolve(OUT, "mobile-autoplay-end.png") });
    await mobile.app.getByRole("button", { name: "Back" }).click();
    const mobileAvatars: { agent: string; x: number; y: number }[] = [];
    for (const agent of AGENTS) {
      const row = agentRow(mobile.app, agent);
      await row.waitFor();
      const box = await row.boundingBox();
      assert.ok(box, `${agent} has no box on the phone.`);
      assert.ok(
        box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844,
        `${agent} is off the screen.`,
      );
      mobileAvatars.push({ agent, x: Math.round(box.x), y: Math.round(box.y) });
    }
    // One list: the rows share a left edge and go down in order.
    assert.equal(new Set(mobileAvatars.map((avatar) => avatar.x)).size, 1, JSON.stringify(mobileAvatars));
    assert.ok(
      mobileAvatars.every((avatar, index) => index === 0 || avatar.y > (mobileAvatars[index - 1]?.y ?? 0)),
      JSON.stringify(mobileAvatars),
    );
    await mobile.page.locator(".landing-app-preview").screenshot({ path: resolve(OUT, "mobile-autoplay-end.png") });
    await mobile.page.screenshot({ path: resolve(OUT, "mobile-page.png") });
    assert.deepEqual(mobile.errors, []);
    await mobile.page.context().close();

    // Reduced motion: the end state shows at once and nothing waits for an answer.
    const still = await openDemo(browser, origin, { width: 1440, height: 900 }, "reduce");
    const stillRoster = await checkRoster(still.app);
    const stillPlan = launchPlan(still.app);
    await reactions(stillPlan).first().waitFor();
    await still.app.getByRole("region", { name: "Answers sent" }).getByText(AUTO_ANSWER).waitFor();
    assert.equal(await still.app.getByRole("button", { name: "Submit answer" }).count(), 0);
    assert.equal(await still.app.getByRole("button", { name: "Stop agent" }).count(), 0);
    await still.page.locator(".landing-app-preview").screenshot({ path: resolve(OUT, "desktop-reduced-motion.png") });
    assert.deepEqual(still.errors, []);
    await still.page.context().close();

    const report = {
      ok: true,
      landing,
      timeZone: TIME_ZONE,
      roster,
      reducedMotionRoster: stillRoster,
      models,
      visitorAnswer: "LinkedIn, Product Hunt",
      launchPlanRows: channels,
      reactions: reactionLabel,
      context: { before: contextBefore, after: contextAfter },
      unread,
      unreadAfterLeavingMidStream: leftUnread,
      mobileAvatars,
      screenshots: [
        "landing-1440.png",
        "landing-390.png",
        "landing-390-bar.png",
        "desktop-question.png",
        "desktop-autoplay-end.png",
        "desktop-scout.png",
        "desktop-forge.png",
        "desktop-pulse.png",
        "desktop-typed-reply.png",
        "desktop-channel.png",
        "desktop-left-mid-scene.png",
        "mobile-autoplay-end.png",
        "mobile-page.png",
        "desktop-reduced-motion.png",
      ],
    };
    assert.notEqual(contextAfter, contextBefore);
    writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    logger.info(`Passed. Report: ${resolve(OUT, "report.json")}`);
  } catch (error) {
    if (lastDemoPage) {
      writeFileSync(
        resolve(OUT, "failure-aria.yml"),
        await lastDemoPage
          .frameLocator(IFRAME)
          .locator("body")
          .ariaSnapshot()
          .catch(() => ""),
      );
      await lastDemoPage.screenshot({ path: resolve(OUT, "failure.png") }).catch(() => undefined);
    }
    throw error;
  } finally {
    await browser.close();
  }
} catch (error) {
  if (site) writeFileSync(resolve(OUT, "site-output.log"), siteOutput);
  throw error;
} finally {
  if (site) {
    const exited = new Promise<void>((done) => (site.exitCode === null ? site.once("exit", () => done()) : done()));
    site.kill("SIGTERM");
    await exited;
  }
}
