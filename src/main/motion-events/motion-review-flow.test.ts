// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationMessage,
  DEFAULT_WORKSPACE_MOTION_EVENTS,
  type McpServerConfig,
} from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotionClient, motionHeaders, motionToolAnswer } from "./motion-client";
import { decodeMotionEvent, type MotionEvent } from "./motion-event";
import { MotionEventsService, type WaitingTicket } from "./motion-events-service";
import { MotionGrader } from "./motion-grader";
import { MotionOrders } from "./motion-orders";
import { isImportantTicket, parseReviewVerdict, reviewEvidence, reviewTicket } from "./motion-review";

const agent = (id: string, name: string, reportsToAgentId?: string) => ({
  id,
  name,
  ...(reportsToAgentId ? { reportsToAgentId } : {}),
});
const dev = { id: "u-dev", name: "Dev", kind: "agent", agent_key: "agent-dev", role: "member" };
const lead = { id: "u-lead", name: "Lead", kind: "agent", agent_key: "agent-lead", role: "member" };
const ana = { id: "u-ana", name: "Ana", kind: "person", agent_key: null, role: "owner" };

function event(type: string, extra: DynamicRecord = {}, issue: DynamicRecord = {}): MotionEvent {
  const decoded = decodeMotionEvent({
    id: `evt-${Math.random()}`,
    type,
    at: 1,
    workspace: { name: "W" },
    issue: {
      id: "issue-1",
      key: "UO-7",
      title: "Landing page",
      url: "https://motion.test/w/p/1",
      status: { name: "In Review", category: "in_progress" },
      assignees: [dev],
      ...issue,
    },
    actor: dev,
    recipients: [],
    ...extra,
  });
  if (!decoded) throw new Error("not decoded");
  return decoded;
}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "motion-review-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function service(now = () => 1_000_000) {
  const sent: { agentId: string; text: string; fyi: boolean }[] = [];
  const waiting: WaitingTicket[][] = [];
  const pushes: string[] = [];
  const events = new MotionEventsService({
    settings: () => DEFAULT_WORKSPACE_MOTION_EVENTS,
    agents: () => [agent("agent-dev", "Dev", "agent-lead"), agent("agent-lead", "Lead")],
    deliver: async (input) => {
      sent.push(input);
    },
    showWaiting: (tickets) => waiting.push([...tickets]),
    notifyOwner: (input) => pushes.push(input.body),
    timeZone: () => "UTC",
    stateFile: join(root, "events.json"),
    log: () => undefined,
    now,
  });
  return { events, sent, waiting, pushes };
}

describe("Motion review events", () => {
  it("decodes the reviewer, criteria, hand-off, verdict, notes and blocker", () => {
    const review = event("issue.review_requested", { reviewer: [lead], criteria: "Has a CTA", handoff: "See /tmp/a" });
    expect(review.reviewer.map((person) => person.agentKey)).toEqual(["agent-lead"]);
    expect([review.criteria, review.handoff]).toEqual(["Has a CTA", "See /tmp/a"]);
    const reviewed = event("issue.reviewed", { verdict: "reopened", notes: "No CTA", from: "In Review" });
    expect([reviewed.verdict, reviewed.notes, reviewed.from]).toEqual(["reopened", "No CTA", "In Review"]);
    const cleared = event("issue.blocker_cleared", { blocker: { id: "b", key: "UO-6", title: "Copy" } });
    expect(cleared.blocker).toEqual({ id: "b", key: "UO-6", title: "Copy" });
  });

  it("wakes an agent reviewer with the criteria, and asks the host to grade a ticket with no reviewer", async () => {
    const { events, sent } = service();
    const asked = await events.receive(
      event("issue.review_requested", { reviewer: [lead], recipients: [lead], criteria: "Has a CTA" }),
    );
    expect(asked.grade).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ agentId: "agent-lead", fyi: false });
    expect(sent[0]?.text).toContain("Has a CTA");
    expect(sent[0]?.text).toContain("issues_review");

    const none = await events.receive(event("issue.review_requested", { criteria: "Has a CTA" }));
    expect(none.grade).toBe(true);
    // A person reviews it: the host grades nothing.
    const person = await events.receive(event("issue.review_requested", { reviewer: [ana] }));
    expect(person.grade).toBeUndefined();
  });

  it("wakes the assignee with the notes of a reopen even right after another wake, and holds a pass", async () => {
    const { events, sent } = service();
    await events.receive(event("issue.assigned", { actor: ana, recipients: [dev] }));
    await events.receive(
      event("issue.reviewed", { actor: lead, recipients: [dev], verdict: "reopened", notes: "No CTA" }),
    );
    expect(sent[1]).toMatchObject({ agentId: "agent-dev", fyi: false });
    expect(sent[1]?.text).toContain("> No CTA");
    await events.receive(event("issue.reviewed", { actor: lead, recipients: [dev], verdict: "passed", notes: "ok" }));
    expect(sent[2]).toMatchObject({ agentId: "agent-dev", fyi: true });
  });

  it("wakes the assignee when the last blocker is done", async () => {
    const { events, sent } = service();
    await events.receive(
      event("issue.blocker_cleared", {
        actor: lead,
        recipients: [dev],
        blocker: { id: "b", key: "UO-6", title: "Copy" },
      }),
    );
    expect(sent[0]).toMatchObject({ agentId: "agent-dev", fyi: false });
    expect(sent[0]?.text).toContain("UO-6 “Copy” is done");
    expect(sent[0]?.text).toContain("issues_start");
  });
});

describe("the grader's pure parts", () => {
  it("marks high priority and money tickets important", () => {
    expect(isImportantTicket({ priority: "High", title: "Landing", criteria: null })).toBe(true);
    expect(isImportantTicket({ priority: "Low", title: "Set the price of the course", criteria: null })).toBe(true);
    expect(isImportantTicket({ priority: "Medium", title: "Landing copy", criteria: "Has a headline" })).toBe(false);
  });

  it("reads the run's steps, links and messages as evidence", () => {
    const messages: ConversationMessage[] = [
      {
        id: "m1",
        author: "assistant",
        text: "Published it at https://site.test/landing",
        createdAt: new Date(2_000).toISOString(),
        status: "completed",
        trace: {
          startedAt: "",
          endedAt: "",
          steps: [
            {
              id: "s",
              kind: "tool",
              category: "shell",
              command: "npm run build",
              startedAt: "",
              endedAt: "",
              failed: true,
            },
          ],
        },
      },
      { id: "m0", author: "assistant", text: "old", createdAt: new Date(0).toISOString(), status: "completed" },
    ];
    const evidence = reviewEvidence(messages, 1_000);
    expect(evidence).toContain("[shell] npm run build (FAILED)");
    expect(evidence).toContain("https://site.test/landing");
    expect(evidence).not.toContain("old");
  });

  it("parses a verdict, and an answer that is none passes nothing", () => {
    expect(parseReviewVerdict('{"verdict":"pass","notes":"All met."}')).toEqual({ verdict: "pass", notes: "All met." });
    expect(parseReviewVerdict('Sure: {"verdict":"reopen","notes":"CTA","missing":["a CTA button"]}')).toEqual({
      verdict: "reopen",
      notes: "CTA\nMissing:\n- a CTA button",
    });
    expect(parseReviewVerdict("Looks great!")).toBeNull();
    expect(parseReviewVerdict('{"verdict":"reopen","notes":""}')).toBeNull();
  });

  it("reads a compact Motion row", () => {
    const ticket = reviewTicket(
      { key: "UO-7", title: "Landing", url: "https://m", status: "In Review", priority: "Urgent", criteria: "CTA" },
      { key: "", title: "", url: "" },
    );
    expect(ticket).toMatchObject({ key: "UO-7", priority: "Urgent", criteria: "CTA", handoff: null });
  });

  it("acts as the grader with its own agent headers, and reads tool answers", () => {
    const headers = motionHeaders(
      [
        { key: "Authorization", value: "Bearer t" },
        { key: "X-Motion-Agent", value: "agent-dev" },
        { key: "X-Motion-Agent-Name", value: "Dev" },
      ],
      true,
    );
    expect(headers).toEqual({
      Authorization: "Bearer t",
      "X-Motion-Agent": "atelier-grader",
      "X-Motion-Agent-Name": "Grader",
    });
    expect(motionToolAnswer({ result: { content: [{ type: "text", text: '{"key":"UO-7"}' }] } })).toEqual({
      key: "UO-7",
    });
    expect(() =>
      motionToolAnswer({ result: { isError: true, content: [{ type: "text", text: "forbidden: no" }] } }),
    ).toThrow("forbidden: no");
  });
});

function grader(verdicts: string[]) {
  const calls: { name: string; args: DynamicRecord; asGrader: boolean }[] = [];
  const escalated: string[] = [];
  const told: string[] = [];
  const judged: boolean[] = [];
  const motion = new MotionGrader({
    tool: async (caller, name, args) => {
      calls.push({ name, args, asGrader: caller.asGrader === true });
      if (name === "rows_get")
        return {
          key: "UO-7",
          title: "Landing",
          url: "https://m",
          status: "Done",
          priority: "High",
          criteria: "Has a CTA",
        };
      return {};
    },
    agents: () => [agent("agent-dev", "Dev")],
    evidence: () => [],
    judge: async (input) => {
      judged.push(input.important);
      return { text: verdicts.shift() ?? "", model: "codex/gpt" };
    },
    escalate: (_ticket, body) => escalated.push(body),
    tell: (_agentId, text) => told.push(text),
    stateFile: join(root, "grader.json"),
    log: () => undefined,
  });
  return { motion, calls, escalated, told, judged };
}

describe("the grader", () => {
  it("passes or reopens as its own member, on the other vendor for an important ticket", async () => {
    const { motion, calls, judged } = grader(['{"verdict":"reopen","notes":"No CTA button."}']);
    await motion.grade(event("issue.review_requested", { criteria: "Has a CTA" }));
    const review = calls.find((call) => call.name === "issues_review");
    expect(review).toMatchObject({ asGrader: true, args: { issue: "UO-7", verdict: "reopen" } });
    expect(String(review?.args.notes)).toContain("No CTA button.");
    expect(String(review?.args.notes)).toContain("round 1 of 3");
    expect(judged).toEqual([true]);
  });

  it("hands the ticket to the owner instead of a fourth round", async () => {
    const reopen = '{"verdict":"reopen","notes":"Still no CTA."}';
    const { motion, calls, escalated } = grader([reopen, reopen, reopen]);
    for (let round = 0; round < 3; round += 1) await motion.grade(event("issue.review_requested"));
    expect(calls.filter((call) => call.name === "issues_review")).toHaveLength(2);
    expect(calls.some((call) => call.name === "comments_create")).toBe(true);
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toContain("after 3 reviews");
  });

  it("escalates when the judge gives no verdict twice", async () => {
    const { motion, escalated, calls } = grader(["nope", "still nope"]);
    await motion.grade(event("issue.review_requested"));
    expect(calls.some((call) => call.name === "issues_review")).toBe(false);
    expect(escalated[0]).toContain("could not grade");
  });

  it("sends a ticket with criteria that its agent moved to Done to review", async () => {
    const { motion, calls, told } = grader([]);
    motion.observeToolCall("agent-dev", "motion__issues_update", { issue: "uo-7", status: "Done" });
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(calls.map((call) => call.name)).toEqual(["rows_get", "issues_request_review"]);
    expect(calls[1]).toMatchObject({ asGrader: false, args: { issue: "UO-7" } });
    expect(told[0]).toContain("went to review instead of Done");
    // A status that is not done sends nothing to Motion: the call ends before any request.
    motion.observeToolCall("agent-dev", "motion__issues_update", { issue: "UO-7", status: "In Progress" });
    expect(calls).toHaveLength(2);
  });
});

describe("order cards", () => {
  it("makes the card as the sender, holds its assignment wake, and nudges then escalates a stalled order", async () => {
    let now = 1_000_000;
    const calls: { name: string; args: DynamicRecord; agentId: string }[] = [];
    const notes: { agentId: string; text: string }[] = [];
    const woken: string[] = [];
    const orders = new MotionOrders({
      tool: async (caller, name, args) => {
        calls.push({ name, args, agentId: caller.agentId });
        if (name === "issues_create") return { id: "issue-9", key: "UO-9", title: "Write the FAQ", url: "https://m/9" };
        return { key: "UO-9", status: "In Progress" };
      },
      available: () => true,
      observesToolCalls: () => true,
      agents: () => [agent("agent-dev", "Dev"), agent("agent-lead", "Lead")],
      currentTicket: (agentId) => (agentId === "agent-lead" ? { key: "UO-3" } : null),
      woken: (agentId, issueId) => woken.push(`${agentId}:${issueId}`),
      note: async (input) => {
        notes.push(input);
        return "wake";
      },
      stateFile: join(root, "orders.json"),
      log: () => undefined,
      now: () => now,
    });
    const card = await orders.create({
      senderAgentId: "agent-lead",
      recipientAgentId: "agent-dev",
      recipientName: "Dev",
      text: "Write the FAQ for the course page.",
      card: { title: "Write the FAQ", criteria: "10 questions", dedupeKey: "faq-v1" },
    });
    expect(card).toEqual({ key: "UO-9", title: "Write the FAQ", url: "https://m/9", existing: false });
    expect(calls[0]).toMatchObject({
      agentId: "agent-lead",
      args: { project: "UO", assignee: "Dev", criteria: "10 questions", dedupe_key: "faq-v1" },
    });
    expect(woken).toEqual(["agent-dev:issue-9"]);

    now += 2 * 3_600_000;
    orders.observeToolCall("agent-dev", "motion__issues_update", { issue: "UO-9", status: "In Progress" });
    now += 5 * 3_600_000;
    await orders.tick();
    expect(notes).toHaveLength(0);
    now += 2 * 3_600_000;
    await orders.tick();
    expect(notes[0]).toMatchObject({ agentId: "agent-dev" });
    expect(notes[0]?.text).toContain("no progress for 7 h");
    now += 7 * 3_600_000;
    await orders.tick();
    expect(notes[1]).toMatchObject({ agentId: "agent-lead" });
    expect(notes[1]?.text).toContain("your order to Dev");
    now += 7 * 3_600_000;
    await orders.tick();
    expect(notes).toHaveLength(2);

    orders.observeEvent(event("issue.review_requested", {}, { id: "issue-9", key: "UO-9" }));
    expect(orders.orders()[0]?.inReview).toBe(true);
    orders.observeEvent(
      event(
        "issue.reviewed",
        { verdict: "passed" },
        { id: "issue-9", key: "UO-9", status: { name: "Done", category: "done" } },
      ),
    );
    expect(orders.orders()).toHaveLength(0);
    orders.dispose();
  });
});

describe("the Motion client", () => {
  it("calls a Motion tool over MCP as the agent, or as the grader", async () => {
    const seen: { agent: string | undefined; body: string }[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        seen.push({ agent: request.headers["x-motion-agent"]?.toString(), body });
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"key":"UO-7"}' }] } }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const config: McpServerConfig = {
      id: "m",
      name: "motion",
      enabled: true,
      transport: "http",
      command: "",
      args: [],
      env: [],
      envPassthrough: [],
      workingDirectory: "",
      url: `http://127.0.0.1:${port}/mcp`,
      headers: [
        { key: "X-Motion-Agent", value: "{{agent.id}}" },
        { key: "X-Motion-Agent-Name", value: "{{agent.name}}" },
      ],
    };
    const client = new MotionClient({
      mcpServers: () => [config],
      mcpAgent: () => null,
      personalMcpServer: (stored) => ({
        ...stored,
        headers: [
          { key: "X-Motion-Agent", value: "agent-dev" },
          { key: "X-Motion-Agent-Name", value: "Dev" },
        ],
      }),
    });
    try {
      expect(client.available()).toBe(true);
      expect(await client.tool({ agentId: "agent-dev" }, "rows_get", { id: "UO-7" })).toEqual({ key: "UO-7" });
      await client.tool({ agentId: "agent-dev", asGrader: true }, "issues_review", {
        issue: "UO-7",
        verdict: "pass",
        notes: "ok",
      });
      expect(seen.map((entry) => entry.agent)).toEqual(["agent-dev", "atelier-grader"]);
      expect(JSON.parse(seen[1]?.body ?? "{}")).toMatchObject({
        method: "tools/call",
        params: { name: "issues_review", arguments: { verdict: "pass" } },
      });
    } finally {
      server.close();
    }
  });
});
