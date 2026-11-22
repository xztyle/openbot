// The orders, plan mode and wide research of the review flow on the real agent service, with a fake
// Codex app-server that calls the tools each step names (`STEP:<name>` in a turn's input):
//
// - send_message with card makes the Motion card through the order port before the message goes,
//   names it in the message, and starts a big order in plan mode; the plan goes to the agent who gave
//   the order with submit_plan, and its verdict comes back with review_plan.
// - An fyi note that reads like an order is held, and the sender hears that it reads like one.
// - wide_research answers at once, maps the job over the items on toolless generations, writes the
//   CSV table in the shared folder, and wakes the agent with a note when it is done.
// - The grader's judge (generateReviewText) answers in a fresh toolless generation.
//
// `bun scripts/order-cards-e2e.ts`. Writes .openbot-build/order-cards-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { z } from "zod";
import type { OrderCardsPort } from "../src/backend/agent/order-tools";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/order-cards-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-order-cards-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");
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

const PERSON = { id: "local", name: "Alex" };
const submitted = z.object({ planId: z.string() });

const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
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
const finish = (threadId, turnId) => {
  const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
const answerWith = (threadId, turnId, text) => {
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
      if (text.includes("You are one researcher")) {
        const item = (/Find the price of ([^.]+)./.exec(text) || [])[1] || "?";
        return setTimeout(() => answerWith(params.threadId, turnId, JSON.stringify({ price: "9 " + item, sources: ["https://shop.test/" + item] })), 10);
      }
      if (text.includes("You are an independent grader"))
        return setTimeout(() => answerWith(params.threadId, turnId, '{"verdict":"reopen","notes":"No FAQ page.","missing":["10 questions"]}'), 10);
      const step = [...text.matchAll(/STEP:([a-z0-9-]+)/g)].at(-1)?.[1];
      const call = step ? JSON.parse(readFileSync(PLAN, "utf8"))[step] : undefined;
      if (!call) return setTimeout(() => finish(params.threadId, turnId), 20);
      const id = "tool-" + turnId;
      waiting.set(id, { threadId: params.threadId, turnId, step });
      return write({
        id,
        method: "item/tool/call",
        params: {
          threadId: params.threadId,
          turnId,
          callId: "call-" + turnId,
          namespace: "openbot",
          tool: "tool_call",
          arguments: { name: "openbot." + call.tool, arguments: call.args },
        },
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
        appendFileSync(LOG, JSON.stringify({ step: turn.step, result: message.result ?? null, error: message.error ?? null }) + "\\n");
        finish(turn.threadId, turn.turnId);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

interface ToolLog {
  step: string;
  result: { success: boolean; contentItems: { type: string; text: string }[] } | null;
  error: unknown;
}

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

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function toolLogs(): ToolLog[] {
  let text = "";
  try {
    text = readFileSync(fakeLog, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const report: {
  calls: { step: string; success: boolean; text: string }[];
  checks: { name: string; passed: boolean }[];
  passed: boolean;
  error?: string;
} = { calls: [], checks: [], passed: false };

function pass(name: string, condition: boolean, detail?: string) {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail ? `${name}: ${detail}` : name);
}

async function stepResult(step: string) {
  const entry = await waitFor(`the ${step} tool result`, () => toolLogs().find((item) => item.step === step));
  const text = entry.result?.contentItems.map((item) => item.text).join("\n") ?? JSON.stringify(entry.error);
  const result = { step, success: entry.result?.success === true, text };
  report.calls.push(result);
  return result;
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
  timezone: () => "UTC",
  approvalAutomation: {
    autoApproves: () => true,
    set: () => Effect.succeed({ defaultAutoApprove: true, autoApproveOverrides: {} }),
  },
});
const made: Parameters<OrderCardsPort["create"]>[0][] = [];
agents.setOrderCards({
  available: () => true,
  create: async (input) => {
    made.push(input);
    return { key: "UO-9", title: input.card.title, url: "https://motion.test/w/p/9", existing: false };
  },
});

function idle(agentId: string) {
  return waitFor("the agent to finish", () =>
    agents
      .listQueue(agentId)
      .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
  );
}

async function create(name: string) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: `${name} helps with tests.`,
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await idle(agent.id);
  return agent;
}

// A teammate's message waits two minutes for others of its burst; a person's message starts the turn
// at once and takes it along.
const poke = (agentId: string) => runCauseEffect(agents.sendMessage({ agentId, text: "Please continue." }, PERSON));

const received = (agentId: string, part: string) =>
  agents.listQueue(agentId).deliveries.find((delivery) => delivery.text.includes(part));

try {
  await runCauseEffect(agents.initialize());
  const lead = await create("Lead");
  const dev = await create("Dev");
  const plan: Record<string, { tool: string; args: unknown }> = {
    "lead-order": {
      tool: "send_message",
      args: {
        recipientAgentIds: [dev.id],
        text: "Write the FAQ for the course page, ten questions. STEP:dev-plan",
        summary: "Write the course FAQ",
        card: { title: "Write the course FAQ", criteria: "10 questions", dedupeKey: "faq-v1", estimateHours: 6 },
      },
    },
    "dev-plan": {
      tool: "submit_plan",
      args: { card: "UO-9", plan: "1. Read the course page\n2. Draft ten questions" },
    },
    "lead-fyi": {
      tool: "send_message",
      args: {
        recipientAgentIds: [dev.id],
        text: "Can you also check the pricing table of the course page?",
        fyi: true,
      },
    },
    "lead-research": {
      tool: "wide_research",
      args: {
        title: "Price scan",
        job: "Find the price of {item}.",
        items: ["mats", "blocks", "straps"],
        columns: ["price"],
      },
    },
  };
  writeFileSync(planFile, JSON.stringify(plan));

  await runCauseEffect(agents.sendMessage({ agentId: lead.id, text: "STEP:lead-order" }, PERSON));
  const order = await stepResult("lead-order");
  pass("send_message with card answers the card", order.success && order.text.includes("UO-9"), order.text);
  pass(
    "The card is made as the sender for the one recipient, with its criteria and dedupe key",
    made.length === 1 &&
      made[0]?.senderAgentId === lead.id &&
      made[0]?.recipientAgentId === dev.id &&
      made[0]?.card.criteria === "10 questions" &&
      made[0]?.card.dedupeKey === "faq-v1",
    JSON.stringify(made),
  );
  const delivered = await waitFor("the order at Dev", () => received(dev.id, "Motion card: UO-9"));
  pass(
    "The message names the card and starts the big order in plan mode",
    delivered.text.includes("Plan first") && delivered.text.includes("submit_plan"),
    delivered.text,
  );
  await poke(dev.id);
  const submittedPlan = await stepResult("dev-plan");
  pass("submit_plan sends the plan", submittedPlan.success, submittedPlan.text);
  const planId = submitted.parse(JSON.parse(submittedPlan.text)).planId;
  const atLead = await waitFor("the plan at Lead", () => received(lead.id, "Plan to approve for UO-9"));
  pass("The plan reaches the agent who gave the order", atLead.text.includes("review_plan"), atLead.text);
  await poke(lead.id);
  await idle(dev.id);
  await idle(lead.id);

  plan["lead-review"] = { tool: "review_plan", args: { planId, approve: true, notes: "Keep it short." } };
  writeFileSync(planFile, JSON.stringify(plan));
  await runCauseEffect(agents.sendMessage({ agentId: lead.id, text: "STEP:lead-review" }, PERSON));
  const review = await stepResult("lead-review");
  pass("review_plan approves it", review.success && review.text.includes("approved"), review.text);
  const verdict = await waitFor("the verdict at Dev", () => received(dev.id, "is approved"));
  pass("The approval wakes the assignee", verdict.text.includes("Go ahead"), verdict.text);
  await poke(dev.id);
  await idle(dev.id);
  await idle(lead.id);

  await runCauseEffect(agents.sendMessage({ agentId: lead.id, text: "STEP:lead-fyi" }, PERSON));
  const held = await stepResult("lead-fyi");
  pass(
    "An fyi note that reads like an order is held, with a warning",
    held.success && held.text.includes("reads like an order"),
    held.text,
  );
  await idle(lead.id);

  await runCauseEffect(agents.sendMessage({ agentId: lead.id, text: "STEP:lead-research" }, PERSON));
  const research = await stepResult("lead-research");
  pass("wide_research answers at once", research.success && research.text.includes("started"), research.text);
  const note = await waitFor(
    "the research note",
    () => received(lead.id, "Wide research “Price scan” is done"),
    60_000,
  );
  const table = /Table: (\S+\.csv)/u.exec(note.text)?.[1] ?? "";
  const csv = readFileSync(table, "utf8");
  pass(
    "The table holds one row per item, in the shared folder",
    note.text.includes("3 of 3 rows") && csv.includes("9 mats") && csv.includes("https://shop.test/straps"),
    `${note.text}\n${csv}`,
  );
  await idle(lead.id);

  const judged = await runCauseEffect(
    agents.generateReviewText({ agentId: dev.id, important: true, prompt: "You are an independent grader. Grade it." }),
  );
  pass("The grader's judge answers in a fresh generation", judged.text.includes('"verdict":"reopen"'), judged.text);

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
