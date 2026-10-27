// Checks that a teammate's request that waits for the user reaches the chats of the agents that gave
// it the work, on the real SQLite stores and mailbox. An orchestrator asks a lead, the lead asks QA,
// and QA's turn asks the user. The script reads the delegation chain, the escalation list that the
// clients get, the one note that the orchestrator gets, the wire event of `input-escalations-v1` and
// the notification that opens the orchestrator's chat. A secret question gives a note with no text,
// and a request that ends leaves the list. No provider, account or network is started: each request
// is a mailbox delivery marked running for a synthetic turn, as `send_message` and the drain make it.
// Run: `bun scripts/teammate-prompts-e2e.ts`.
// Writes .openbot-build/teammate-prompts-e2e/report.json.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent, AgentInputEscalation, AgentPromptQuestion } from "@openbot/contracts/ipc";
import { inputEscalationsEvent, visibleInputEscalations } from "@openbot/contracts/team-protocol/input-escalations-v1";
import { optionalTeamEvent } from "@openbot/contracts/team-protocol/optional-events";
import { translateFor } from "@openbot/i18n";
import { inputEscalationDelegator, notificationForAgentEvent } from "@openbot/team-client/agent-notifications";
import type { PendingAttentionRequest } from "../src/backend/agent/attention-registry";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { InputEscalations } from "../src/backend/agent/input-escalations";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "teammate-prompts-e2e");
const FIXTURE = join(ROOT, "packages/contracts/src/team-protocol/fixtures/input-escalations-v1/host-event.json");

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; steps: Step[] } = { passed: false, steps: [] };

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  try {
    const value = await run();
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const root = await mkdtemp(join(tmpdir(), "openbot-teammate-prompts-"));
const database = new OpenBotDatabase(join(root, "state"));
const store = new AgentStore(join(root, "state"), join(root, "home"), database);
const mailbox = new MailboxStore(join(root, "state"), store.sharedRoot, database);
const conversation = new ConversationRuntime(
  store,
  () => {},
  () => store.list(),
);
const events: AgentEvent[] = [];
const drained: string[] = [];
let pending: PendingAttentionRequest[] = [];
const escalations = new InputEscalations({
  store,
  mailbox,
  mailboxSync: { syncMailboxMessages: () => {}, emitQueue: () => {} },
  conversation,
  hooks: {
    pendingRequests: () => pending,
    scheduleDrain: (agentId) => drained.push(agentId),
    emit: (event) => events.push(event),
    emitError: (code, error) => {
      throw new Error(`${code}: ${error instanceof Error ? error.message : String(error)}`);
    },
  },
});

/** A request from `from` to `to`, sent in the turn `fromTurn` of `from`, and run by `to` in `toTurn`. */
async function delegate(from: string, fromTurn: string | null, to: string, toTurn: string, text: string) {
  const receipt = await runCauseEffect(
    mailbox.enqueue({
      sender: from === "user" ? { kind: "user" } : { kind: "agent", agentId: from },
      recipientAgentIds: [to],
      text,
      // The key of a tool call: the mailbox reads the sending turn from it.
      ...(fromTurn ? { idempotencyKey: `thread-${from}:${fromTurn}:${crypto.randomUUID()}` } : {}),
    }),
  );
  const delivery = receipt.deliveries[0];
  assert.ok(delivery, "The request has a delivery.");
  await runCauseEffect(mailbox.markStarting(delivery.id));
  await runCauseEffect(mailbox.markRunning(delivery.id, toTurn));
  return delivery.id;
}

/** Lets the forked note finish. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await new Promise((done) => setImmediate(done));
}

function lastList(): AgentInputEscalation[] {
  const event = events.findLast((candidate) => candidate.type === "agent-input-escalations-changed");
  assert.ok(event?.type === "agent-input-escalations-changed", "An escalation list was sent.");
  return event.escalations;
}

function notesTo(agentId: string): string[] {
  return mailbox
    .listQueue(agentId)
    .deliveries.filter((delivery) => delivery.status === "queued" && delivery.expectsReply === false)
    .map((delivery) => delivery.text);
}

const question = (text: string, isSecret = false): AgentPromptQuestion => ({
  id: crypto.randomUUID(),
  header: "Question",
  question: text,
  isSecret,
  options: null,
});

try {
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  const create = (name: string) =>
    runCauseEffect(
      store.createAgent({ name, description: "", avatarSeed: `teammate-${name.toLowerCase()}`, avatarHue: null }),
    );
  const orchestrator = await create("Orchestrator");
  const lead = await create("Lead");
  const qa = await create("QA");
  // A turn runs on the agent's thread, which the first turn makes.
  for (const agent of [orchestrator, lead, qa]) store.ensureThreadIdNow(agent.id);
  const threadOf = (agentId: string) => store.list().find((agent) => agent.id === agentId)?.threadId ?? "";

  await step("The delegation chain goes from the direct delegator to the root", async () => {
    await delegate("user", null, orchestrator.id, "turn-orchestrator", "Ship the game.");
    await delegate(orchestrator.id, "turn-orchestrator", lead.id, "turn-lead", "Build and test the game.");
    await delegate(lead.id, "turn-lead", qa.id, "turn-qa", "Test the game.");
    const chain = mailbox.delegationChain(qa.id, "turn-qa", 8);
    assert.deepEqual(chain, [lead.id, orchestrator.id]);
    assert.deepEqual(mailbox.delegationChain(orchestrator.id, "turn-orchestrator", 8), [], "The user started it.");
    return { chain };
  });

  const asked = await step("A question of QA goes to the chain, and the root gets one note", async () => {
    pending = [
      {
        kind: "prompt",
        requestId: 7,
        agentId: qa.id,
        threadId: threadOf(qa.id),
        turnId: "turn-qa",
        questions: [question("Allow the computer_use MCP server to run tool launch_app?")],
      },
    ];
    escalations.refresh();
    await settle();
    const list = lastList();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0]?.delegatorAgentIds, [lead.id, orchestrator.id]);
    assert.deepEqual(escalations.list(), list, "The runtime snapshot holds the same list.");
    const notes = notesTo(orchestrator.id);
    assert.equal(notes.length, 1, "The orchestrator gets one note.");
    assert.match(notes[0] ?? "", /QA is blocked waiting for the user/u);
    assert.match(notes[0] ?? "", /launch_app/u);
    assert.equal(notesTo(lead.id).length, 0, "Only the root gets the note.");
    assert.ok(drained.includes(orchestrator.id), "The note wakes the orchestrator.");
    // The note answers no request, so it starts no delegation of its own.
    assert.deepEqual(mailbox.delegationChain(orchestrator.id, "turn-orchestrator", 8), []);
    return { list, note: notes[0] };
  });

  await step("Another refresh sends no second note and no second list", async () => {
    const before = events.length;
    escalations.refresh();
    await settle();
    assert.equal(events.length, before, "An unchanged list is not sent again.");
    assert.equal(notesTo(orchestrator.id).length, 1);
    return { events: events.length };
  });

  await step("A secret question while the first note waits gives no text and no second note", async () => {
    pending = [
      ...pending,
      {
        kind: "prompt",
        requestId: 8,
        agentId: qa.id,
        threadId: threadOf(qa.id),
        turnId: "turn-qa",
        questions: [question("Enter the store password hunter2", true)],
      },
    ];
    escalations.refresh();
    await settle();
    assert.equal(lastList().length, 2);
    const notes = notesTo(orchestrator.id);
    assert.equal(notes.length, 1, "The queued note covers the next request.");
    assert.ok(!notes.some((note) => note.includes("hunter2")), "No note quotes a secret question.");
    return { notes: notes.length };
  });

  await step("The wire event keeps the list, and a peer sees only the agents it may see", async () => {
    const wire = optionalTeamEvent(
      JSON.parse(JSON.stringify({ type: "agent-input-escalations-changed", escalations: lastList() })),
    );
    assert.ok(wire?.type === "agent-input-escalations-changed");
    assert.deepEqual(wire.escalations, lastList());
    const fixture = inputEscalationsEvent(JSON.parse(await readFile(FIXTURE, "utf8")));
    assert.equal(fixture?.escalations.length, 1, "The released fixture decodes.");
    assert.deepEqual(visibleInputEscalations(lastList(), new Set([lead.id]))[0]?.delegatorAgentIds, [orchestrator.id]);
    assert.equal(visibleInputEscalations(lastList(), new Set([qa.id])).length, 0, "A hidden teammate is left out.");
    assert.throws(() => inputEscalationsEvent({ type: "agent-input-escalations-changed", escalations: [{}] }));
    return { decoded: wire.escalations.length };
  });

  await step("The notification of the question opens the orchestrator's chat", async () => {
    const agents = store.list().map((agent) => ({ ...agent, notifications: agent.id !== qa.id }));
    const event: AgentEvent = {
      type: "prompt",
      requestId: 7,
      agentId: qa.id,
      threadId: threadOf(qa.id),
      turnId: "turn-qa",
      questions: [question("Allow?")],
    };
    const delegator = inputEscalationDelegator(lastList(), event);
    assert.equal(delegator, orchestrator.id);
    const content = notificationForAgentEvent(event, agents, translateFor("en"), "needs-me", null, null, delegator);
    assert.ok(content, "A background teammate with its notifications off still notifies through its delegator.");
    assert.equal(content.agentId, orchestrator.id);
    assert.equal(content.threadId, threadOf(orchestrator.id));
    assert.equal(content.title, "Orchestrator: QA needs you");
    assert.equal(notificationForAgentEvent(event, agents, translateFor("en"), "needs-me"), null);
    return content;
  });

  await step("A request that ends leaves the list", async () => {
    pending = [];
    escalations.refresh();
    await settle();
    assert.deepEqual(lastList(), []);
    return { noteBefore: asked.note };
  });

  await step("A cycle stops the chain", async () => {
    await delegate(qa.id, "turn-qa-2", lead.id, "turn-lead-2", "Check my test.");
    await delegate(lead.id, "turn-lead-2", qa.id, "turn-qa-2", "Run it again.");
    const chain = mailbox.delegationChain(qa.id, "turn-qa-2", 8);
    assert.deepEqual(chain, [lead.id], "The walk stops at the agent that asks.");
    return { chain };
  });

  report.passed = true;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  database.close();
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
