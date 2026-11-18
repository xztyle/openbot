// Checks two things the owner sees in an agent's chat. Runs the real agent service on a temporary profile
// with a fake Codex app-server that records what each turn got, and the operator routes of the control
// socket (`server-agent-operations.ts`) wired as `application-services.ts` wires them.
// (a) The restart note goes to the agent as a note from OpenBot: the agent gets the text and runs a turn,
//     the chat stores a `system-notice:restart-resume` row with no sender, not a message from the owner,
//     it adds nothing to the unread count, and a second send with the same `restart-resume:<id>` key
//     returns the first receipt.
// (b) An operator message is the owner's by default, and a note from OpenBot with `system: true`.
// (c) The steps of a turn keep an email address that the agent wrote, in its narration, the label of a
//     tool step and the trace; a credential in the same text is still removed.
// `bun scripts/agent-chat-notice-e2e.ts`. Writes .openbot-build/agent-chat-notice-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type ConversationMessage, type ConversationMessageSender } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-chat-notice-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-chat-notice-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const inputLog = join(root, "inputs.jsonl");
const ADDRESS = "gta6pulsefeed@gmail.com";
const TOKEN = `ghp_${"Ab1".repeat(12)}`;

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { createServerAgentOperations, RESUME_NOTE } = await import("../src/main/server-agent-operations");

/**
 * A Codex app-server with the methods that the service calls. Each turn records its input, narrates a
 * step that names an email address and a token, runs a shell step whose command names them, and answers.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      appendFileSync(${JSON.stringify(inputLog)}, JSON.stringify(params.input) + "\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      setTimeout(() => {
        const threadId = params.threadId;
        const narration = { type: "agentMessage", id: "narration-" + turnId, phase: "commentary", text: "The name was free, so the address is ${ADDRESS}. Token ${TOKEN}." };
        write({ method: "item/completed", params: { threadId, turnId, item: narration } });
        const command = { type: "commandExecution", id: "command-" + turnId, command: "echo ${ADDRESS} ${TOKEN}", status: "inProgress" };
        write({ method: "item/started", params: { threadId, turnId, item: command } });
        write({ method: "item/completed", params: { threadId, turnId, item: { ...command, status: "completed", exitCode: 0, aggregatedOutput: "" } } });
        const item = { type: "agentMessage", id: "answer-" + turnId, text: "Done.", phase: "final_answer" };
        write({ method: "item/completed", params: { threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      }, 30);
      return;
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
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

interface CaseReport {
  name: string;
  details: unknown;
  passed: boolean;
}

const report: { cases: CaseReport[]; passed: boolean; error?: string } = { cases: [], passed: false };

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
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

/** Waits for a state of the service. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function turnInputs(): string[] {
  try {
    return readFileSync(inputLog, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
});
const owner: ConversationMessageSender = { id: "local-user:owner", name: "delynith" };

try {
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Publisher",
      description: "Checks the chat notices.",
      avatarSeed: "notice",
      avatarHue: null,
      initialMessage: "Start.",
    }),
  );
  const operations = createServerAgentOperations({
    restartInterrupted: () => new Set(),
    database: () => database.connection,
    agentIds: () => agents.listAgents().map((candidate) => candidate.id),
    send: (input, notice) =>
      agents
        .sendMessage(input, notice ? undefined : owner, undefined, notice)
        .pipe(Effect.mapError((error) => ({ cause: error }))),
    markerFile: join(root, "resumes.json"),
    log: () => {},
  });
  const idle = () => agents.listQueue(agent.id).deliveries.every((delivery) => delivery.status === "completed");
  const messages = async (): Promise<ConversationMessage[]> =>
    (await runCauseEffect(agents.readConversation(agent.id))).messages;
  await waitFor("the first turn to end", () => turnInputs().length === 1 && idle());

  // (a) The restart note, as the resume route sends it.
  const send = () =>
    runCauseEffect(
      agents.sendMessage(
        { agentId: agent.id, text: RESUME_NOTE, clientMessageId: "restart-resume:delivery-1" },
        undefined,
        undefined,
        "restart-resume",
      ),
    );
  const first = await send();
  await waitFor("the resume turn to end", () => turnInputs().length === 2 && idle());
  const again = await send();
  assert.equal(again.messageId, first.messageId, "The same key returns the first receipt.");
  assert.ok(turnInputs()[1]?.includes(RESUME_NOTE), "The agent gets the note as its turn input.");
  const notice = (await messages()).find((message) => message.text === RESUME_NOTE);
  assert.ok(notice, "The chat keeps the note.");
  assert.equal(notice.author, "system", "The note is not a message from the owner.");
  assert.equal(notice.source, "system");
  assert.equal(notice.itemType, "system-notice:restart-resume");
  assert.equal(notice.senderMember, undefined, "The note names no person.");
  const reads = agents.listConversationReads(owner.id)[agent.id];
  const answers = (await messages()).filter(
    (message) => message.author === "assistant" && message.itemType !== "commentary",
  );
  assert.equal(reads?.unreadCount, answers.length, "Only the agent's answer is unread, not the note.");
  assert.equal(
    agents
      .listAgents()
      .find((candidate) => candidate.id === agent.id)
      ?.preview.includes("restarted"),
    false,
  );
  report.cases.push({
    name: "the restart note reaches the agent as a note from OpenBot, once",
    details: { notice, unread: reads?.unreadCount, answers: answers.length, turns: turnInputs().length },
    passed: true,
  });

  // (b) The operator message: the owner's by default, OpenBot's with `system`.
  const plain = await operations.route(
    "POST",
    `/v1/agents/${agent.id}/message`,
    JSON.stringify({ text: "Owner check." }),
  );
  assert.equal(plain?.status, 200);
  await waitFor("the owner's turn to end", () => turnInputs().length === 3 && idle());
  const system = await operations.route("POST", `/v1/agents/${agent.id}/message`, "text=Operator+check.&system=1");
  assert.equal(system?.status, 200);
  await waitFor("the operator turn to end", () => turnInputs().length === 4 && idle());
  const all = await messages();
  const ownerMessage = all.find((message) => message.text === "Owner check.");
  const operatorNote = all.find((message) => message.text === "Operator check.");
  assert.equal(ownerMessage?.author, "user");
  assert.deepEqual(ownerMessage?.senderMember, owner, "A plain operator message is the owner's.");
  assert.equal(operatorNote?.author, "system");
  assert.equal(operatorNote?.itemType, "system-notice:operator-note");
  assert.equal(operatorNote?.senderMember, undefined);
  report.cases.push({
    name: "an operator message is the owner's unless it asks to be a note from OpenBot",
    details: { ownerMessage, operatorNote },
    passed: true,
  });

  // (c) What the owner reads of the steps keeps the address and loses the token.
  const narration = all.find((message) => message.itemType === "commentary" && message.text.includes("address"));
  assert.ok(narration, "The narration is stored.");
  assert.ok(narration.text.includes(ADDRESS), `The narration keeps the address: ${narration.text}`);
  assert.ok(!narration.text.includes(TOKEN), "The narration loses the token.");
  const steps = all.flatMap((message) => message.trace?.steps ?? []).filter((step) => step.kind === "tool");
  const shell = steps.find((step) => step.command !== undefined);
  assert.ok(shell, "The trace has the shell step.");
  assert.ok(shell.command?.includes(ADDRESS), `The trace command keeps the address: ${shell.command}`);
  assert.ok(!shell.command?.includes(TOKEN), "The trace command loses the token.");
  assert.ok(shell.label?.includes(ADDRESS), `The step label keeps the address: ${shell.label}`);
  assert.ok(!shell.label?.includes(TOKEN), "The step label loses the token.");
  report.cases.push({
    name: "the steps keep an email address and lose a credential",
    details: { narration: narration.text, command: shell.command, label: shell.label },
    passed: true,
  });
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
