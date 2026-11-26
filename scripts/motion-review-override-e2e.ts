// A review that the grader escalated, then a person's verdict, on the real Motion pieces of a host
// (`startMotionEventsHost`: the grader, the waiting list, the approval router of tier 1) against a fake
// Motion MCP server that keeps each ticket's status and review history the way Motion does: `issues_review`
// grades only an issue in review unless it has `override`, and an assignee cannot grade its own issue.
//
// - The owner's "Accept as is" on an escalated ticket with acceptance criteria closes it (Done) as the
//   owner's Motion member, with the owner's words as the review notes, and starts no new review round:
//   not when its agent marks it Done again, and not when it comes back to review.
// - The owner's "Send back with a note" reopens it with the note.
// - The manager's accept in the tier-1 flow (`answer_approval`) closes it the same way, as the manager.
//
// `bun scripts/motion-review-override-e2e.ts`. Writes .openbot-build/motion-review-override-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_WORKSPACE_MOTION_EVENTS, type McpServerConfig } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { ApprovalRouter } from "../src/backend/approvals/approval-router";
import type { McpAgent } from "../src/backend/mcp-agent-values";
import { decodeMotionEvent } from "../src/main/motion-events/motion-event";
import { startMotionEventsHost, ticketApprovalId } from "../src/main/motion-events/motion-events-host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/motion-review-override-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-review-override-"));

interface Ticket {
  id: string;
  key: string;
  title: string;
  status: "In Progress" | "In Review" | "Done";
  assignee: string;
  criteria: string;
  reviewNotes: string | null;
  comments: { by: string; body: string }[];
  reviews: { by: string; verdict: string; notes: string; override: boolean }[];
  reviewRequests: number;
}

const tickets = new Map<string, Ticket>();
const calls: { tool: string; by: string; args: DynamicRecord }[] = [];

function ticket(id: string, key: string): Ticket {
  const made: Ticket = {
    id,
    key,
    title: `Ad images ${key}`,
    status: "In Progress",
    assignee: "agent-cso",
    criteria: "- 4 image helpers\n- a test image made by Codex",
    reviewNotes: null,
    comments: [],
    reviews: [],
    reviewRequests: 0,
  };
  tickets.set(id, made);
  return made;
}

function find(reference: unknown): Ticket {
  const wanted = String(reference).toUpperCase();
  const found = [...tickets.values()].find((item) => item.id.toUpperCase() === wanted || item.key === wanted);
  if (!found) throw new Error(`not_found: ${String(reference)}`);
  return found;
}

/** Motion's rules for the tools the host calls (application/src/ops/review.rs). */
function motionTool(tool: string, by: string, args: DynamicRecord): DynamicRecord {
  calls.push({ tool, by, args });
  switch (tool) {
    case "rows_get": {
      const item = find(args.id);
      return {
        id: item.id,
        key: item.key,
        title: item.title,
        url: `https://motion.test/p/${item.id}`,
        status: item.status,
        priority: "High",
        criteria: item.criteria,
        review_notes: item.reviewNotes,
      };
    }
    case "comments_list":
      return { items: find(args.page_id).comments.map((comment) => ({ author: comment.by, body: comment.body })) };
    case "comments_create":
      find(args.page_id).comments.push({ by, body: String(args.body) });
      return { ok: true };
    case "issues_request_review": {
      const item = find(args.issue);
      item.status = "In Review";
      item.reviewRequests += 1;
      return { key: item.key, status_name: item.status };
    }
    case "issues_update": {
      const item = find(args.issue);
      if (args.status === "Done") item.status = "Done";
      return { key: item.key };
    }
    case "issues_review": {
      const item = find(args.issue);
      const override = args.override === true;
      if (item.status !== "In Review" && !override) throw new Error(`invalid: ${item.key} is not in review`);
      if (item.assignee === by) throw new Error(`forbidden: ${item.key} is assigned to you`);
      const verdict = String(args.verdict);
      const notes = String(args.notes ?? "").trim();
      if (verdict === "reopen" && !notes) throw new Error("invalid: notes needed");
      if (override && verdict === "pass" && item.status === "Done") return { key: item.key, status_category: "done" };
      item.status = verdict === "pass" ? "Done" : "In Progress";
      if (notes) item.reviewNotes = notes;
      item.reviews.push({ by, verdict, notes, override });
      item.comments.push({ by, body: `**Review: ${verdict === "pass" ? "passed" : "reopened"}**\n\n${notes}` });
      return { key: item.key, status_name: item.status };
    }
    default:
      throw new Error(`unknown tool ${tool}`);
  }
}

/** A `tools/call` result: the tool's JSON, or Motion's refusal as an error. */
function toolResult(tool: string, by: string, args: DynamicRecord) {
  try {
    return { content: [{ type: "text", text: JSON.stringify(motionTool(tool, by, args)) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "failed" }] };
  }
}

function decodeMessage(body: string) {
  const parsed = JSON.parse(body);
  return isDynamicRecord(parsed) ? parsed : null;
}

const motion = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  request.on("end", () => {
    const message = decodeMessage(body);
    const params = isDynamicRecord(message) && isDynamicRecord(message.params) ? message.params : {};
    const id = isDynamicRecord(message) ? message.id : null;
    const by = String(request.headers["x-motion-agent"] ?? "");
    const result = toolResult(String(params.name), by, isDynamicRecord(params.arguments) ? params.arguments : {});
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
});
await new Promise<void>((done) => motion.listen(0, "127.0.0.1", done));
const address = motion.address();
if (!address || typeof address === "string") throw new Error("The fake Motion server has no port.");
const motionUrl = `http://127.0.0.1:${address.port}/mcp`;

const agents = [
  { id: "agent-cso", name: "CSO", reportsToAgentId: "agent-ceo" },
  { id: "agent-ceo", name: "CEO", reportsToAgentId: null },
  { id: "agent-solo", name: "Solo", reportsToAgentId: null },
];
const row: McpServerConfig = {
  id: "motion",
  name: "motion",
  transport: "http",
  enabled: true,
  command: "",
  args: [],
  env: [],
  envPassthrough: [],
  workingDirectory: "",
  url: motionUrl,
  headers: [
    { key: "Authorization", value: "Bearer test" },
    { key: "X-Motion-Agent", value: "{{agent.id}}" },
    { key: "X-Motion-Agent-Name", value: "{{agent.name}}" },
  ],
};
const mcpAgent = (agentId: string): McpAgent | null => {
  const found = agents.find((entry) => entry.id === agentId);
  return found ? { id: found.id, name: found.name, space: { id: "general", name: "General", slug: "general" } } : null;
};
/** The row filled for the calling agent, as the chat app fills `{{agent.id}}` and `{{agent.name}}`. */
const personalMcpServer = (config: McpServerConfig, agent: McpAgent | null): McpServerConfig => ({
  ...config,
  headers: config.headers.map((header) => ({
    key: header.key,
    value: header.value.replace("{{agent.id}}", agent?.id ?? "").replace("{{agent.name}}", agent?.name ?? ""),
  })),
});
const sent: { agentId: string; text: string }[] = [];
const wakes: { agentId: string; text: string }[] = [];
const approvals = new ApprovalRouter({
  agents: () => agents,
  spaceOf: () => "general",
  wake: async (input) => {
    wakes.push(input);
  },
  record: () => undefined,
  stateFile: join(root, "approvals.json"),
  log: () => undefined,
});
const REOPEN = '{"verdict":"reopen","notes":"Missing:\\n- proof that Codex made the image"}';
const host = await startMotionEventsHost({
  userData: root,
  environment: {},
  settings: () => DEFAULT_WORKSPACE_MOTION_EVENTS,
  agents: () => agents,
  secret: () => null,
  send: (input) =>
    Effect.sync(() => {
      sent.push({ agentId: input.agentId, text: input.text });
    }),
  showWaiting: () => undefined,
  notifyOwner: () => undefined,
  timeZone: () => "UTC",
  mcpServers: () => [row],
  mcpAgent,
  personalMcpServer,
  chatPath: () => null,
  ticketsChanged: () => undefined,
  evidence: () => [],
  // The grader's judge reopens every round; the reader of why a ticket waits says it is an escalated review.
  judge: async (input) => ({
    text: input.prompt.includes('"asks"')
      ? '{"asks":"review-escalated","reason":"The grader used up its rounds.","owner_only":"none"}'
      : REOPEN,
    model: "test/judge",
  }),
  observesToolCalls: true,
  approvals: undefined,
});

/** The grader's rounds on a ticket until it hands it over: 3 reviews, the last one escalates. */
async function escalate(item: Ticket): Promise<void> {
  for (let round = 1; round <= 3; round += 1) {
    item.status = "In Review";
    await host.grader.grade(reviewRequested(item));
  }
  assert.equal(item.status, "In Review", "the grader leaves an escalated ticket in review");
  await waitFor(`${item.key} waits`, () =>
    host.events.waiting().find((entry) => entry.issueId === item.id && entry.asks === "review-escalated"),
  );
}

function reviewRequested(item: Ticket) {
  const decoded = decodeMotionEvent({
    id: `evt-${item.key}-${calls.length}`,
    type: "issue.review_requested",
    at: Date.now(),
    workspace: { name: "W" },
    issue: {
      id: item.id,
      key: item.key,
      title: item.title,
      url: `https://motion.test/p/${item.id}`,
      status: { name: "In Review", category: "in_progress" },
      assignees: [{ id: "u-cso", name: "CSO", kind: "agent", agent_key: item.assignee, role: "member" }],
    },
    actor: { id: "u-cso", name: "CSO", kind: "agent", agent_key: item.assignee, role: "member" },
    recipients: [],
    criteria: item.criteria,
  });
  if (!decoded) throw new Error("not decoded");
  return decoded;
}

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

interface Report {
  ownerAccept?: { status: string; reviews: Ticket["reviews"]; reviewRequests: number };
  ownerSendBack?: { status: string; reviewNotes: string | null; reviews: Ticket["reviews"] };
  ownerQuestion?: { status: string };
  managerAccept?: { status: string; reviews: Ticket["reviews"]; told: string; wakes: number };
}
const report: Report = {};
try {
  // 1. The owner accepts an escalated ticket as it is.
  const accepted = ticket("issue-32", "PUO-32");
  await escalate(accepted);
  const reviewsBefore = accepted.reviews.length;
  await host.answerWaiting(accepted.id, "Lo acepto así, sin más rondas de revisión: ciérralo.", "Alejandro", "accept");
  assert.equal(accepted.status, "Done", "the owner's accept closes the ticket");
  const ownerReview = accepted.reviews.at(-1);
  assert.deepEqual(
    ownerReview && { by: ownerReview.by, verdict: ownerReview.verdict, override: ownerReview.override },
    { by: "atelier-owner", verdict: "pass", override: true },
    "a pass by the owner's member that overrides the grader",
  );
  assert.equal(accepted.reviews.length, reviewsBefore + 1);
  assert.ok(!host.events.waiting().some((entry) => entry.issueId === accepted.id), "the ticket leaves Needs you");
  // The agent reads "close it" and marks it Done: Atelier does not send it back to review.
  const reads = calls.filter((call) => call.tool === "rows_get").length;
  host.observeToolCall("agent-cso", "motion__issues_update", { issue: "PUO-32", status: "Done" });
  await waitFor("the agent's Done is read", () => calls.filter((call) => call.tool === "rows_get").length > reads);
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
  assert.equal(accepted.reviewRequests, 0, "no new review round after the owner's accept");
  assert.equal(accepted.status, "Done");
  // It comes back to review anyway (by hand): the grader passes it on the owner's decision, judging nothing.
  accepted.status = "In Review";
  await host.grader.grade(reviewRequested(accepted));
  assert.equal(accepted.status, "Done");
  assert.equal(accepted.reviews.at(-1)?.by, "atelier-grader");
  report.ownerAccept = { status: accepted.status, reviews: accepted.reviews, reviewRequests: accepted.reviewRequests };

  // 2. The owner sends one back with a note.
  const back = ticket("issue-40", "PUO-40");
  await escalate(back);
  await host.answerWaiting(back.id, "Devuelto. Corrige esto: falta el cuarto ayudante.", "Alejandro", "send-back");
  assert.equal(back.status, "In Progress", "send back reopens the ticket");
  assert.equal(back.reviews.at(-1)?.by, "atelier-owner");
  assert.ok(back.reviewNotes?.includes("falta el cuarto ayudante"), "the note goes on the ticket");
  // The next hand-off is graded once more, not passed on a decision; still short, it comes back to a person.
  back.status = "In Review";
  await host.grader.grade(reviewRequested(back));
  assert.equal(back.status, "In Review");
  assert.equal(back.comments.at(-1)?.by, "atelier-grader", "the grader graded the new hand-off");
  await waitFor("PUO-40 waits again", () => host.events.waiting().some((entry) => entry.issueId === back.id));
  report.ownerSendBack = { status: back.status, reviewNotes: back.reviewNotes, reviews: back.reviews };

  // 3. An answer with no verdict (an older client) only comments, as before.
  const plain = ticket("issue-41", "PUO-41");
  await escalate(plain);
  await host.answerWaiting(plain.id, "¿Qué falta exactamente?", "Alejandro");
  assert.equal(plain.status, "In Review");
  assert.equal(plain.comments.at(-1)?.by, "atelier-owner");
  report.ownerQuestion = { status: plain.status };
} finally {
  await host.close();
}

// 4. The manager's accept in the tier-1 flow: the same host with the approval router.
const managed = await startMotionEventsHost({
  userData: join(root, "managed"),
  environment: {},
  settings: () => DEFAULT_WORKSPACE_MOTION_EVENTS,
  agents: () => agents,
  secret: () => null,
  send: (input) =>
    Effect.sync(() => {
      sent.push({ agentId: input.agentId, text: input.text });
    }),
  showWaiting: () => undefined,
  notifyOwner: () => undefined,
  timeZone: () => "UTC",
  mcpServers: () => [row],
  mcpAgent,
  personalMcpServer,
  chatPath: () => null,
  ticketsChanged: () => undefined,
  evidence: () => [],
  judge: async (input) => ({
    text: input.prompt.includes('"asks"')
      ? '{"asks":"review-escalated","reason":"The grader used up its rounds.","owner_only":"none"}'
      : REOPEN,
    model: "test/judge",
  }),
  observesToolCalls: true,
  approvals,
});
try {
  const item = ticket("issue-50", "PUO-50");
  for (let round = 1; round <= 3; round += 1) {
    item.status = "In Review";
    await managed.grader.grade(reviewRequested(item));
  }
  const pending = await waitFor("the manager is asked", () =>
    approvals.pending().find((entry) => entry.id === ticketApprovalId(item.id)),
  );
  assert.equal(pending.approverId, "agent-ceo", "an escalated review goes to the agent's manager");
  const answered = await approvals.answer("agent-ceo", { requestId: pending.id, verdict: "approve", note: "" });
  assert.equal(answered.ok, true, answered.message);
  await waitFor("the manager's verdict reaches Motion", () => item.status === "Done");
  assert.deepEqual(
    { by: item.reviews.at(-1)?.by, verdict: item.reviews.at(-1)?.verdict, override: item.reviews.at(-1)?.override },
    { by: "agent-ceo", verdict: "pass", override: true },
  );
  const reads = calls.filter((call) => call.tool === "rows_get").length;
  managed.observeToolCall("agent-cso", "motion__issues_update", { issue: item.key, status: "Done" });
  await waitFor("the agent's Done is read", () => calls.filter((call) => call.tool === "rows_get").length > reads);
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
  assert.equal(item.reviewRequests, 0, "no new review round after the manager's accept");
  const told = await waitFor("the asker hears it", () =>
    sent.find((entry) => entry.agentId === "agent-cso" && entry.text.includes("accepts PUO-50 as is")),
  );
  assert.ok(isString(told.text));
  report.managerAccept = { status: item.status, reviews: item.reviews, told: told.text, wakes: wakes.length };
} finally {
  await managed.close();
  motion.close();
  await rm(root, { recursive: true, force: true });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ok: true, ...report }, null, 2)}\n`);
process.stdout.write("motion-review-override-e2e: ok\n");
