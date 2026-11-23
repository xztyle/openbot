// Checks the answers to a request that an agent sent to several teammates (upstream 0.72 and 0.74).
// Runs the real mailbox store and SQLite on a temporary profile. Checks that an answer waits while
// another teammate still works, that a later turn of the asking agent in its own chat releases it
// (it then starts a turn, and the slow teammate is still outstanding), that a person's message still
// reads it at once, and that a teammate whose turn fails after it answered shows as completed, not
// failed. No app, provider, account or network is started.
//
// Run: bun scripts/teammate-answers-e2e.ts
// Writes .openbot-build/teammate-answers-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_WAKE_COALESCE_MS } from "../src/backend/collaboration-limits";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/teammate-answers-e2e");
/**
 * A new teammate message starts a turn only after `AGENT_WAKE_COALESCE_MS`. The mailbox reads the time
 * from `Date.now`, so this clock runs ahead to the end of that hold instead of waiting two minutes.
 */
const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
const passWakeHold = () => {
  ahead += AGENT_WAKE_COALESCE_MS;
};
const LEAD = "agent-lead";
const FAST = "agent-fast";
const SLOW = "agent-slow";

const report: { checks: string[]; passed: boolean } = { checks: [], passed: false };
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 5));

async function enqueue(mailbox: MailboxStore, input: Parameters<MailboxStore["enqueue"]>[0]) {
  await tick();
  return runCauseEffect(mailbox.enqueue(input));
}

async function runTurn(mailbox: MailboxStore, ids: readonly string[], turnId: string, status: "completed" | "failed") {
  for (const id of ids) await runCauseEffect(mailbox.markStarting(id));
  for (const id of ids) await runCauseEffect(mailbox.markRunning(id, turnId));
  for (const id of ids) await runCauseEffect(mailbox.markTerminal(id, status, status === "failed" ? "boom" : null));
}

function deliveryFor(receipt: { deliveries: readonly { id: string; recipientAgentId: string }[] }, agentId: string) {
  const delivery = receipt.deliveries.find((candidate) => candidate.recipientAgentId === agentId);
  assert.ok(delivery, `A delivery to ${agentId}.`);
  return delivery.id;
}

const root = await mkdtemp(join(tmpdir(), "openbot-teammate-answers-"));
const path = join(root, "profile");
const database = new OpenBotDatabase(path);
try {
  const mailbox = new MailboxStore(path, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());

  const request = await enqueue(mailbox, {
    sender: { kind: "agent", agentId: LEAD },
    recipientAgentIds: [FAST, SLOW],
    text: "Each of you: check one part and report.",
  });
  const fastCopy = deliveryFor(request, FAST);
  const slowCopy = deliveryFor(request, SLOW);
  for (const id of [fastCopy, slowCopy]) await runCauseEffect(mailbox.markStarting(id));
  await runCauseEffect(mailbox.markRunning(fastCopy, "fast-turn"));
  await runCauseEffect(mailbox.markRunning(slowCopy, "slow-turn"));

  const answer = await enqueue(mailbox, {
    sender: { kind: "agent", agentId: FAST },
    recipientAgentIds: [LEAD],
    text: "Status: done\nResult: part one works.\nEvidence: none",
    replyToMessageId: request.messageId,
    expectsReply: false,
  });
  const answerId = deliveryFor(answer, LEAD);
  // The fast teammate's turn then fails, after its answer.
  await runCauseEffect(mailbox.markTerminal(fastCopy, "failed", "The provider stopped."));
  assert.equal(mailbox.getDelivery(fastCopy)?.delivery.status, "completed");
  assert.equal(mailbox.getDelivery(fastCopy)?.delivery.error, null);
  report.checks.push("a teammate whose turn fails after it answered ends completed, so the list shows Replied");

  assert.equal(mailbox.nextQueued(LEAD), null, "The answer waits while the slow teammate works.");
  report.checks.push("an answer waits while another teammate still works on the request");

  const person = await enqueue(mailbox, {
    sender: { kind: "user" },
    recipientAgentIds: [LEAD],
    text: "How is it going?",
  });
  const personId = deliveryFor(person, LEAD);
  assert.equal(mailbox.nextQueued(LEAD)?.delivery.id, personId);
  assert.deepEqual(
    mailbox.repliesToStartWith(personId).map((context) => context.delivery.id),
    [answerId],
    "A person's message reads the waiting answer in the same turn.",
  );
  report.checks.push("a person's message still reads the waiting answer in its own turn");

  // A routine run of the lead, in its own chat, ends without the answer.
  const routine = await enqueue(mailbox, {
    sender: { kind: "routine", routineId: "r-1", runId: "run-1", routineName: "Daily", scheduledFor: "2026-11-20" },
    recipientAgentIds: [LEAD],
    text: "Daily check.",
  });
  await runTurn(mailbox, [deliveryFor(routine, LEAD)], "routine-turn", "completed");
  passWakeHold();
  assert.equal(
    mailbox.nextQueued(LEAD)?.delivery.id,
    answerId,
    "After a later turn ended, the answer is no longer held: it is the oldest message and starts next.",
  );
  assert.deepEqual(mailbox.outstandingRecipients(request.messageId), [SLOW]);
  assert.deepEqual(mailbox.unansweredRecipients(request.messageId), []);
  assert.ok(mailbox.heldReplyReleaseTimes().get(LEAD) === undefined, "No release timer for an answer that is free.");
  report.checks.push(
    "a later turn of the asker in its own chat releases the answer; the slow teammate stays outstanding",
  );
  report.passed = true;
} finally {
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(
  `${report.passed ? "PASS" : "FAIL"}: ${report.checks.length} checks. Report: ${join(OUT, "report.json")}\n`,
);
if (!report.passed) process.exitCode = 1;
