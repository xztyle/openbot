// Electron smoke of the agent browser helpers that save turns and takeovers: the cookie banner
// refusal of an agent tab, `run_steps`, and the one checkbox click before a takeover. It serves its
// own pages on loopback. Build it with `bun build --target=node --format=esm --external=electron` and
// run the bundle with Electron (`--no-sandbox`, under xvfb-run on a Linux server).

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { app, BrowserWindow } from "electron";
import { BrowserHost } from "../src/backend/browser-host";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { DynamicToolResult } from "../src/backend/protocol";

const html = (body: string) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;

const PAGES: Record<string, string> = {
  "/banner": html(`<h1>Shop</h1>
    <div id="banner" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:12px">
      <p>We use cookies to improve your visit.</p>
      <button onclick="window.accepted = true; banner.remove()">Accept all</button>
      <button onclick="window.rejected = true; banner.remove()">Reject all</button>
    </div>`),
  "/search":
    html(`<label>Search <input id="q" onkeydown="if (event.key === 'Enter') setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Result: ' + this.value; document.body.append(p); }, 300)"></label>
    <button id="more" onclick="this.dataset.count = String(Number(this.dataset.count || 0) + 1); this.textContent = 'More ' + this.dataset.count">More</button>`),
  // The checkbox widget of a reCAPTCHA check, at its normal size. A click on its checkbox gives the
  // page a token, as a check that passes does.
  "/captcha": html(`<form method="post"><textarea name="g-recaptcha-response" style="display:none"></textarea>
    <iframe src="/recaptcha/api2/anchor?k=test" style="width:304px;height:78px;border:0;margin:40px"></iframe></form>
    <script>addEventListener('message', (event) => { if (event.data === 'pass') document.querySelector('textarea').value = 'token'; });</script>`),
  "/recaptcha/api2/anchor":
    html(`<div style="margin:0"><input type="checkbox" id="box" style="position:absolute;left:16px;top:27px;width:24px;height:24px;margin:0"
    onclick="parent.postMessage('pass', '*')"> I'm not a robot</div>`),
};

const server = createServer((request, response) => {
  const page = PAGES[new URL(request.url ?? "/", "http://127.0.0.1").pathname];
  if (!page) return void response.writeHead(404).end();
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(page);
});

function parseRecord(text: string): DynamicRecord {
  const value = JSON.parse(text);
  if (!isDynamicRecord(value)) throw new Error("The tool returned no JSON object.");
  return value;
}

function payload(result: DynamicToolResult): DynamicRecord {
  const item = result.contentItems[0];
  if (item?.type !== "inputText") throw new Error("The tool returned no text.");
  return parseRecord(item.text);
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  process.stdout.write(`ok: ${message}\n`);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openbot-agent-assist-"));
  app.setPath("userData", join(root, "user-data"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || isString(address)) throw new Error("Local server did not start.");
  const origin = `http://127.0.0.1:${address.port}`;
  await app.whenReady();
  const window = new BrowserWindow({ show: false });
  const browser = new BrowserHost(window, join(root, "downloads"), join(root, "tabs.json"));
  await runCauseEffect(browser.setVisible({ visible: true, bounds: { x: 0, y: 0, width: 1000, height: 700 } }));
  let call = 0;
  const tool = (name: string, args: DynamicRecord) =>
    runCauseEffect(
      browser.handleDynamicTool({
        threadId: "assist-thread",
        turnId: "assist-turn",
        callId: `assist-call-${++call}`,
        ownerAgentId: "assist-bot",
        namespace: "openbot_browser",
        tool: name,
        arguments: args,
      }),
    );
  const evaluate = async (tabId: string, expression: string) =>
    payload(await tool("evaluate", { tabId, expression: `({ value: ${expression} })` })).value;

  // An agent tab refuses the banner and never accepts it.
  const bannerTab = await runCauseEffect(browser.open(`${origin}/banner`, "assist-thread", "assist-bot"));
  await tool("wait_for", { tabId: bannerTab.id, state: "load" });
  let rejected = false;
  for (let attempt = 0; attempt < 20 && !rejected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    rejected = (await evaluate(bannerTab.id, "window.rejected === true")) === true;
  }
  check(rejected, "an agent tab clicked Reject all on a cookie banner");
  check((await evaluate(bannerTab.id, "window.accepted === true")) === false, "the banner was not accepted");

  // run_steps types, presses Enter and waits, then gives one snapshot.
  const searchTab = await runCauseEffect(browser.open(`${origin}/search`, "assist-thread", "assist-bot"));
  await tool("wait_for", { tabId: searchTab.id, state: "load" });
  const steps = await tool("run_steps", {
    tabId: searchTab.id,
    steps: [
      { action: "type", target: { kind: "css", selector: "#q" }, text: "kettle" },
      { action: "press", key: "Enter", target: { kind: "css", selector: "#q" } },
      { action: "wait_for", text: "Result: kettle" },
      { action: "click", target: { kind: "role", role: "button", name: "More" } },
      { action: "click", target: { kind: "css", selector: "#more" } },
    ],
  });
  const ran = payload(steps);
  const snapshot = ran.snapshot;
  check(steps.success && ran.completed === 5, "run_steps ran five steps");
  check(
    isDynamicRecord(snapshot) && isString(snapshot.text) && snapshot.text.includes("Result: kettle"),
    "run_steps returned one final snapshot with the result",
  );
  check(
    (await evaluate(searchTab.id, "document.querySelector('#more').dataset.count")) === "2",
    "run_steps clicked twice",
  );
  const failed = await tool("run_steps", {
    tabId: searchTab.id,
    steps: [
      { action: "click", target: { kind: "css", selector: "#more" } },
      { action: "click", target: { kind: "css", selector: "#missing" }, button: "left" },
      { action: "click", target: { kind: "css", selector: "#more" } },
    ],
    timeoutMs: 1_500,
  });
  const stopped = payload(failed);
  check(
    !failed.success &&
      stopped.completed === 1 &&
      isDynamicRecord(stopped.failed) &&
      stopped.failed.step === 1 &&
      isDynamicRecord(stopped.snapshot),
    "run_steps stopped at the failed step and kept the snapshot",
  );

  // The checkbox of a check gets one click before a takeover, and the check passes.
  const captchaTab = await runCauseEffect(browser.open(`${origin}/captcha`, "assist-thread", "assist-bot"));
  await tool("wait_for", { tabId: captchaTab.id, state: "load" });
  const outcome = await runCauseEffect(browser.tryChallengeCheckbox(captchaTab.id));
  check(outcome === "passed", "the checkbox click passed");
  check(
    (await runCauseEffect(browser.tryChallengeCheckbox(captchaTab.id))) === "none",
    "a passed check gets no second click",
  );

  server.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

void main()
  .then(() => app.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  });
