// The files that an agent names to the owner reach the owner, and every file chip opens.
// Host (real agent service on a temporary profile, fake Codex app-server):
// (a) An answer to the owner that names `copy-x.txt` and copy-y.txt (both in its space's Shared folder)
//     arrives with both files attached; a hidden `.env` and a file outside the agent's folders that it
//     also names are not attached.
// (b) A `message_owner` message that names `resumen.md` (in the agent's workspace) and passes no paths
//     arrives with the file attached.
// (c) `openFileReference`: a bare name opens as an attachment, a folder as its listing, a path outside
//     the agent's folders and a hidden file are refused; a member who sees only the agents of the
//     `general` space cannot open a file of the `ventas` space, and opens one of `general`.
// Web client (the workspace file viewer of `src/renderer/stories/owner-file-links-harness.tsx`, whose
// port calls the same agent service), at desktop width and at phone width with touch:
// (d) the answer of (a) shows copy-x.txt as a file and its viewer shows the text; its chip in the text
//     opens the same file; a bare-name chip that the message does not carry opens the file the host
//     finds; a folder chip opens a listing whose file opens; a path outside the allowed folders shows a
//     plain sentence and no file;
// (e) as a member without the `ventas` space: the same chip shows the plain sentence, and a file of
//     `general` opens.
//
// `bun scripts/owner-file-links-e2e.ts [--browser-executable=<path>] [--headed]`
// Writes .openbot-build/owner-file-links-e2e/report.json and a screenshot of each viewer.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_PROVIDERS,
  type AgentEvent,
  type AttachmentSummary,
  type ConversationMessageSender,
  GENERAL_SPACE_ID,
} from "@openbot/contracts/ipc";
import { OWNER_MESSAGE_ITEM_TYPE } from "@openbot/contracts/owner-conversation";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { Effect } from "effect";
import { type Browser, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/owner-file-links-e2e");
const ENTRY = "/src/renderer/stories/owner-file-links-harness.tsx";
const WAIT = 20_000;
const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

const root = await mkdtemp(join(tmpdir(), "openbot-owner-files-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const planFile = join(root, "plan.json");
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

/**
 * Answers each turn with the text after REPLY: (base64) or "Hecho."; a turn whose text names STEP:<name>
 * first calls the planned tool.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const PLAN = ${JSON.stringify(planFile)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
const waiting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (threadId, turnId, text) => {
  const item = { type: "agentMessage", id: "message-" + turnId, text, phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + process.pid + "-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const reply = /REPLY:([A-Za-z0-9+/=]+)/.exec(text)?.[1];
      const words = reply ? Buffer.from(reply, "base64").toString("utf8") : "Hecho.";
      const step = [...text.matchAll(/STEP:([a-z0-9-]+)/g)].at(-1)?.[1];
      const call = step ? JSON.parse(readFileSync(PLAN, "utf8"))[step] : undefined;
      if (!call) return setTimeout(() => finish(params.threadId, turnId, words), 20);
      const id = "tool-" + turnId;
      waiting.set(id, { threadId: params.threadId, turnId, words });
      return write({
        id,
        method: "item/tool/call",
        params: { threadId: params.threadId, turnId, callId: "call-" + turnId, namespace: "openbot", tool: "tool_call", arguments: { name: "openbot." + call.tool, arguments: call.args } },
      });
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
      else if (!message.method && waiting.has(message.id)) {
        const turn = waiting.get(message.id);
        waiting.delete(message.id);
        finish(turn.threadId, turn.turnId, turn.words);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const unused = () => Effect.die(new Error("Not used by this check."));
const browserHost: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = WAIT): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const report: {
  passed: boolean;
  host: { answer?: string[]; messageOwner?: string[]; references?: string };
  steps: { name: string; passed: boolean; detail?: string }[];
  pageErrors: string[];
  error?: string;
} = { passed: false, host: {}, steps: [], pageErrors: [] };

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database, store.spaces);
const agents = new AgentService({
  store,
  mailbox,
  browser: browserHost,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  timezone: () => "UTC",
  approvalAutomation: {
    autoApproves: () => true,
    set: () => Effect.succeed({ defaultAutoApprove: true, autoApproveOverrides: {} }),
  },
});
const owner: ConversationMessageSender = { id: "local-user:owner", name: "Alejandro" };
const events: AgentEvent[] = [];
agents.on("event", (event: AgentEvent) => events.push(event));
const completions = (agentId: string) =>
  events.filter((event) => event.type === "turn-completed" && event.agentId === agentId).length;
const idle = (agentId: string) =>
  waitFor("the agent to finish", () =>
    agents
      .listQueue(agentId)
      .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
  );
async function create(name: string) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: `${name} writes the campaign copy.`,
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hola.",
    }),
  );
  await waitFor("the first turn", () => completions(agent.id) === 1);
  await idle(agent.id);
  return agent;
}
const names = (attachments: AttachmentSummary[] | undefined) => (attachments ?? []).map(({ name }) => name).sort();

/** The messages that the harness shows, and the readers it asks for. */
const harness: { messages: { id: string; agentId: string; text: string; attachments: AttachmentSummary[] }[] } = {
  messages: [],
};
let canSeeForMember: (agentId: string) => boolean = () => false;

function harnessPage(): Plugin {
  const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Atelier</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${ENTRY}"></script>
  </body>
</html>`;
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(value));
  };
  const body = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  return {
    name: "openbot-owner-file-links-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://harness");
        try {
          if (url.pathname === "/__owner-files/messages") return json(response, 200, harness.messages);
          if (url.pathname === "/__owner-files/reference" && request.method === "POST") {
            const input = await body(request);
            const member = url.searchParams.get("reader") === "member";
            // The same call and the same check as the Team API route of a member, and the owner's IPC.
            const result = await runCauseEffect(
              agents.openFileReference(
                { agentId: input.agentId ?? null, path: String(input.path) },
                member ? canSeeForMember : undefined,
              ),
            ).then(
              (value) => ({ status: 200, value }),
              (error: unknown) => ({ status: 404, value: { error: error instanceof Error ? error.message : "" } }),
            );
            return json(response, result.status, result.value);
          }
          const attachment = /^\/__owner-files\/attachment\/(.+)$/u.exec(url.pathname)?.[1];
          if (attachment) {
            const file = await runCauseEffect(mailbox.resolveAttachment(decodeURIComponent(attachment)));
            if (!file) return json(response, 404, { error: "missing" });
            response.setHeader("Content-Type", "application/octet-stream");
            return response.end(await readFile(file.path));
          }
          if (url.pathname !== "/files") return next();
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(await server.transformIndexHtml(url.pathname, html));
        } catch (error) {
          json(response, 500, { error: String(error) });
        }
      });
    },
  };
}

async function host() {
  await runCauseEffect(agents.initialize());
  const copy = await create("Copy");
  const helper = await create("Ayuda");
  const made = await runCauseEffect(agents.spaces.apply({ kind: "create", name: "Ventas" }));
  const ventas = made.createdSpaceId;
  assert.ok(ventas, "The space was not made.");
  await runCauseEffect(agents.spaces.apply({ kind: "move", spaceId: ventas, agentIds: [copy.id] }));
  const shared = store.spaces.agentSharedDirectory(copy.id);
  const generalShared = store.spaces.agentSharedDirectory(helper.id);
  assert.match(shared, /OpenBot\/Spaces\/ventas\/Shared$/u);
  mkdirSync(join(shared, "landing-review"), { recursive: true });
  mkdirSync(generalShared, { recursive: true });
  mkdirSync(join(root, "outside"), { recursive: true });
  writeFileSync(join(shared, "copy-x.txt"), "Copia A: Reserva tu clase hoy.\n");
  writeFileSync(join(shared, "copy-y.txt"), "Copia B: Tu primera clase es gratis.\n");
  writeFileSync(join(shared, "brief.md"), "# Brief de la campaña\n\nPúblico: madres jóvenes.\n");
  writeFileSync(join(shared, "landing-review", "textos.md"), "# Textos de la landing\n\nTítulo y botón.\n");
  writeFileSync(join(shared, "landing-review", "index.html"), "<h1>Landing</h1>\n");
  writeFileSync(join(copy.workspacePath, "resumen.md"), "# Resumen\n\nDos copias listas.\n");
  writeFileSync(join(copy.workspacePath, ".env"), "META_TOKEN=secret\n");
  writeFileSync(join(generalShared, "aviso.txt"), "Aviso para todo el equipo.\n");
  const outside = join(root, "outside", "plan.txt");
  writeFileSync(outside, "Fuera de las carpetas del agente.\n");

  // (a) An answer of the owner's conversation.
  const answerText = `Listo. Quedaron en la carpeta compartida como \`copy-x.txt\` y copy-y.txt. No adjunto \`.env\` ni ${outside}.`;
  const before = completions(copy.id);
  await runCauseEffect(
    agents.sendMessage(
      { agentId: copy.id, text: `Escribe dos copias. REPLY:${Buffer.from(answerText).toString("base64")}` },
      owner,
    ),
  );
  await waitFor("the answer", () => completions(copy.id) > before);
  await idle(copy.id);
  let snapshot = await runCauseEffect(agents.readConversation(copy.id));
  const answer = snapshot.messages.findLast((message) => message.author === "assistant" && message.text === answerText);
  assert.ok(answer, "The answer is not in the chat.");
  report.host.answer = names(answer.attachments);
  assert.deepEqual(
    names(answer.attachments),
    ["copy-x.txt", "copy-y.txt"],
    "The answer's named files are not attached.",
  );
  const attachedX = answer.attachments?.find(({ name }) => name === "copy-x.txt");
  assert.ok(attachedX);
  const file = await runCauseEffect(mailbox.resolveAttachment(attachedX.id));
  assert.equal(await readFile(file?.path ?? "", "utf8"), "Copia A: Reserva tu clase hoy.\n");

  // (b) A message to the owner on purpose, with no paths.
  writeFileSync(
    planFile,
    JSON.stringify({
      tell: { tool: "message_owner", args: { text: "El resumen para ti está en `resumen.md`." } },
    }),
  );
  const told = completions(copy.id);
  await runCauseEffect(agents.sendMessage({ agentId: copy.id, text: "Avisa al dueño. STEP:tell" }, owner));
  await waitFor("the message to the owner", () => completions(copy.id) > told);
  await idle(copy.id);
  snapshot = await runCauseEffect(agents.readConversation(copy.id));
  const ownerMessage = snapshot.messages.find((message) => message.itemType === OWNER_MESSAGE_ITEM_TYPE);
  report.host.messageOwner = names(ownerMessage?.attachments);
  assert.deepEqual(names(ownerMessage?.attachments), ["resumen.md"], "message_owner did not attach the named file.");

  // (c) The chip route of the host, as the owner and as a member.
  const open = (path: string, agentId: string | null, member = false) =>
    runCauseEffect(agents.openFileReference({ agentId, path }, member ? canSeeForMember : undefined)).then(
      (target) => target,
      (error: unknown) => ({ kind: "refused" as const, message: error instanceof Error ? error.message : "" }),
    );
  canSeeForMember = (agentId) => agentId === helper.id;
  const bare = await open("brief.md", copy.id);
  assert.equal(bare.kind === "file" && bare.attachment.name, "brief.md", "A bare name did not open.");
  const folder = await open("landing-review/", copy.id);
  assert.ok(folder.kind === "folder", "A folder did not open as a listing.");
  assert.deepEqual(folder.entries.map(({ name }) => name).sort(), ["index.html", "textos.md"]);
  assert.equal((await open(outside, copy.id)).kind, "refused", "A path outside the agent's folders opened.");
  assert.equal((await open(".env", copy.id)).kind, "refused", "A hidden file opened.");
  assert.equal((await open("/etc/passwd", null)).kind, "refused", "A system file opened.");
  const ventasPath = join(shared, "copy-x.txt");
  assert.equal((await open(ventasPath, copy.id)).kind, "file", "The owner could not open a space's file.");
  assert.equal((await open(ventasPath, null, true)).kind, "refused", "A member opened a space they are not in.");
  assert.equal((await open("copy-x.txt", copy.id, true)).kind, "refused", "A member opened a hidden agent's file.");
  const memberFile = await open("aviso.txt", helper.id, true);
  assert.equal(memberFile.kind, "file", "A member could not open a file of their own space.");
  report.host.references = "ok";

  harness.messages = [
    { id: "answer", agentId: copy.id, text: answer.text, attachments: answer.attachments ?? [] },
    {
      id: "named",
      agentId: copy.id,
      text: `Revisa \`brief.md\`, la carpeta \`landing-review/\`, el plan \`${outside}\` y \`${ventasPath}\`.`,
      attachments: [],
    },
    { id: "general", agentId: helper.id, text: "El aviso está en `aviso.txt`.", attachments: [] },
  ];
  assert.equal(GENERAL_SPACE_ID, store.spaces.agentSpaceId(helper.id));
}

async function web(page: Page, device: "desktop" | "phone") {
  const step = async (name: string, check: () => Promise<void>) => {
    try {
      await check();
      report.steps.push({ name: `${device}: ${name}`, passed: true });
    } catch (error) {
      report.steps.push({ name: `${device}: ${name}`, passed: false, detail: String(error).slice(0, 800) });
      await page.screenshot({ path: resolve(OUT, `${device}-failed-${report.steps.length}.png`) }).catch(() => {});
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  };
  const dialog = page.getByRole("dialog");
  const message = (id: string) => page.locator(`[data-message="${id}"]`);
  const chip = (id: string, label: string) =>
    message(id).locator(".message-file-reference", { hasText: label }).first();
  const close = async () => {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: WAIT });
  };
  const shot = (name: string) => page.screenshot({ path: resolve(OUT, `${device}-${name}.png`) });
  const unavailable = /no se puede abrir aquí/iu;

  await page.goto(`${origin}/files`);
  await message("answer").waitFor({ timeout: WAIT });

  await step("the answer carries the named file, which previews", async () => {
    const card = message("answer").locator(".message-attachment", { hasText: "copy-x.txt" }).first();
    await card.waitFor({ timeout: WAIT });
    await card.locator(".attachment-preview-button, [data-attachment-id], button").first().click();
    await dialog.getByText("Copia A: Reserva tu clase hoy.").waitFor({ timeout: WAIT });
    await shot("attached");
    await close();
  });

  await step("the chip of an attached file opens it", async () => {
    await chip("answer", "copy-x.txt").click();
    await dialog.getByText("Copia A: Reserva tu clase hoy.").waitFor({ timeout: WAIT });
    await close();
  });

  await step("a bare-name chip opens the file the host finds", async () => {
    await chip("named", "brief.md").click();
    await dialog.getByRole("heading", { name: "Brief de la campaña" }).waitFor({ timeout: WAIT });
    await shot("bare-name");
    await close();
  });

  await step("a folder chip opens a listing whose file opens", async () => {
    await chip("named", "landing-review").click();
    await dialog.getByRole("button", { name: /textos\.md/u }).waitFor({ timeout: WAIT });
    await dialog.getByRole("button", { name: /index\.html/u }).waitFor({ timeout: WAIT });
    await shot("folder");
    await dialog.getByRole("button", { name: /textos\.md/u }).click();
    await dialog.getByRole("heading", { name: "Textos de la landing" }).waitFor({ timeout: WAIT });
    await close();
  });

  await step("a path outside the allowed folders shows a plain sentence", async () => {
    await chip("named", "plan.txt").click();
    await dialog.getByText(unavailable).waitFor({ timeout: WAIT });
    assert.equal(await dialog.getByText("Fuera de las carpetas").count(), 0, "the outside file shows");
    await shot("outside");
    await close();
  });

  await page.goto(`${origin}/files?reader=member`);
  await message("named").waitFor({ timeout: WAIT });

  await step("a member without the space cannot open its file", async () => {
    await chip("named", "copy-x.txt").click();
    await dialog.getByText(unavailable).waitFor({ timeout: WAIT });
    assert.equal(await dialog.getByText("Copia A").count(), 0, "the member sees the file");
    await shot("member-refused");
    await close();
  });

  await step("a member opens a file of their own space", async () => {
    await chip("general", "aviso.txt").click();
    await dialog.getByText("Aviso para todo el equipo.").waitFor({ timeout: WAIT });
    await close();
  });
}

mkdirSync(OUT, { recursive: true });
let browser: Browser | null = null;
let origin = "";
const server = await createServer({
  root: ROOT,
  configFile: false,
  cacheDir: "node_modules/.vite-e2e/owner-file-links-e2e",
  appType: "custom",
  logLevel: "error",
  plugins: [harnessPage(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: { entries: [ENTRY.slice(1)], include: ["@norbert_bodziony/bloub"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
try {
  await host();
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object", "The harness server has no port.");
  origin = `http://127.0.0.1:${address.port}`;
  const executablePath = option("browser-executable");
  browser = await chromium.launch({ headless: !flag("headed"), ...(executablePath ? { executablePath } : {}) });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const page = await desktop.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await web(page, "desktop");
  await desktop.close();
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  const phone = await browser.newContext({
    ...iphone,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme: "dark",
  });
  const phonePage = await phone.newPage();
  phonePage.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await web(phonePage, "phone");
  await phone.close();
  report.passed =
    report.steps.length > 0 && report.steps.every((item) => item.passed) && report.pageErrors.length === 0;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await browser?.close();
  await server.close();
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (!report.passed) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}
