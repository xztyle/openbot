// Checks that a held note is not lost, and that only a note is held. A note is a new message from
// another agent marked fyi: it starts no turn, waits in the queue, and joins the next turn that
// something else starts. Runs the real mailbox store and SQLite on a temporary profile. Checks that
// the note waits without holding back the messages behind it, that it stays queued over a restart,
// that it joins the next turn after the message that starts it, that a failed start puts it back,
// that an answer still starts a turn, and that an order that asks for no answer (expectsReply false,
// not fyi) starts a turn, also when a message held before fyi existed is read back from SQLite.
// No app, provider, account or network is started.
//
// Run: bun scripts/held-note-e2e.ts
// Writes .openbot-build/held-note-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isQueuedAgentNote } from "@openbot/contracts/ipc";
import { AGENT_WAKE_COALESCE_MS } from "../src/backend/collaboration-limits";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/held-note-e2e");
const AGENT = "agent-a";
const LEAD = "agent-lead";
const PEER = "agent-peer";

const report: { checks: string[]; passed: boolean } = { checks: [], passed: false };

async function deliveryTo(mailbox: MailboxStore, input: Parameters<MailboxStore["enqueue"]>[0]): Promise<string> {
  const receipt = await runCauseEffect(mailbox.enqueue(input));
  const delivery = receipt.deliveries.find((candidate) => candidate.recipientAgentId === input.recipientAgentIds[0]);
  assert.ok(delivery);
  return delivery.id;
}

function queued(mailbox: MailboxStore, id: string) {
  const delivery = mailbox.listQueue(AGENT).deliveries.find((candidate) => candidate.id === id);
  assert.ok(delivery, `The queue lists ${id}.`);
  return delivery;
}

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

const root = await mkdtemp(join(tmpdir(), "openbot-held-note-"));
const path = join(root, "profile");
let database = new OpenBotDatabase(path);
try {
  let mailbox = new MailboxStore(path, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());

  const note = await deliveryTo(mailbox, {
    sender: { kind: "agent", agentId: PEER },
    recipientAgentIds: [AGENT],
    text: "Status: the landing page is live.",
    fyi: true,
  });
  assert.equal(mailbox.nextQueued(AGENT), null, "A note alone starts no turn.");
  assert.equal(mailbox.hasUnfinishedDelivery(AGENT), false, "A note alone is no unfinished work.");
  assert.equal(queued(mailbox, note).status, "queued");
  assert.equal(queued(mailbox, note).position, 1);
  assert.ok(isQueuedAgentNote(queued(mailbox, note)), "A client labels the note as waiting for a turn.");
  report.checks.push("a note alone stays queued at position 1, starts no turn and is no unfinished work");

  const request = await deliveryTo(mailbox, {
    sender: { kind: "agent", agentId: LEAD },
    recipientAgentIds: [AGENT],
    text: "Check the landing page and report.",
  });
  assert.equal(mailbox.nextQueued(AGENT), null, "A teammate's request waits for the wake hold.");
  passWakeHold();
  assert.equal(mailbox.nextQueued(AGENT)?.delivery.id, request, "The request behind the note starts the turn.");
  assert.deepEqual(
    mailbox.notesToStartWith(request).map((context) => context.delivery.id),
    [note],
  );
  assert.equal(mailbox.hasUnfinishedDelivery(AGENT), true);
  report.checks.push("a request behind the note starts the next turn, and the note joins it");

  // A restart reads the queue back from SQLite.
  database.close();
  database = new OpenBotDatabase(path);
  mailbox = new MailboxStore(path, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());
  assert.equal(queued(mailbox, note).status, "queued");
  assert.equal(mailbox.nextQueued(AGENT)?.delivery.id, request);
  assert.deepEqual(
    mailbox.notesToStartWith(request).map((context) => context.delivery.id),
    [note],
  );
  report.checks.push("after a restart the note is still queued and held, and the request still starts first");

  // A failed start puts the note back, held as before.
  await runCauseEffect(mailbox.markStarting(note));
  await runCauseEffect(mailbox.markStarting(request));
  await runCauseEffect(mailbox.restoreQueued(note));
  await runCauseEffect(mailbox.restoreQueued(request));
  assert.equal(queued(mailbox, note).status, "queued");
  assert.equal(mailbox.nextQueued(AGENT)?.delivery.id, request);
  report.checks.push("a failed start puts the note back in the queue, still held");

  // The turn takes both. The request leads it, so the turn's origin is the request's sender.
  const turnId = "turn-with-note";
  for (const id of [note, request]) await runCauseEffect(mailbox.markStarting(id));
  assert.equal(mailbox.startingDeliveryForAgent(AGENT)?.delivery.id, request);
  for (const id of [note, request]) await runCauseEffect(mailbox.markRunning(id, turnId));
  assert.deepEqual(
    mailbox.findDeliveriesByTurn(AGENT, turnId).map((context) => context.delivery.id),
    [request, note],
  );
  for (const id of [note, request]) await runCauseEffect(mailbox.markTerminal(id, "completed"));
  assert.equal(mailbox.getDelivery(note)?.delivery.status, "completed", "The note is delivered with the turn.");
  assert.equal(mailbox.hasUnfinishedDelivery(AGENT), false);
  report.checks.push("the note runs in the turn after the request that started it, and completes with it");

  // An answer to a request of the agent is no note: it starts a turn.
  const asked = await runCauseEffect(
    mailbox.enqueue({ sender: { kind: "agent", agentId: AGENT }, recipientAgentIds: [PEER], text: "Is it live?" }),
  );
  const answer = await deliveryTo(mailbox, {
    sender: { kind: "agent", agentId: PEER },
    recipientAgentIds: [AGENT],
    text: "Status: done",
    replyToMessageId: asked.messageId,
    expectsReply: false,
  });
  assert.equal(mailbox.nextQueued(AGENT)?.delivery.id, answer);
  assert.equal(isQueuedAgentNote(queued(mailbox, answer)), false);
  report.checks.push("an answer to the agent's own request still starts a turn");
  await runCauseEffect(mailbox.markStarting(answer));
  await runCauseEffect(mailbox.markRunning(answer, "turn-answer"));
  await runCauseEffect(mailbox.markTerminal(answer, "completed"));

  // An order that asks for no answer is work: it wakes the recipient. Models send orders this way.
  const order = await deliveryTo(mailbox, {
    sender: { kind: "agent", agentId: LEAD },
    recipientAgentIds: [AGENT],
    text: "Top priority: review the branch now.",
    expectsReply: false,
  });
  passWakeHold();
  assert.equal(mailbox.nextQueued(AGENT)?.delivery.id, order, "An order without fyi starts a turn.");
  assert.equal(mailbox.hasUnfinishedDelivery(AGENT), true, "The order is unfinished work.");
  assert.equal(isQueuedAgentNote(queued(mailbox, order)), false, "A client shows the order as ordinary work.");
  assert.equal(queued(mailbox, order).expectsReply, false, "The order still asks for no answer.");
  assert.deepEqual(mailbox.notesToStartWith(order), [], "No note waits for the order's turn.");
  report.checks.push("an order with expectsReply false and no fyi starts a turn and is no note");

  // A message that the previous rule held (expectsReply false, no fyi) is read back from SQLite after
  // the upgrade and starts a turn, so the orders held before the deploy run.
  database.close();
  database = new OpenBotDatabase(path);
  mailbox = new MailboxStore(path, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());
  assert.equal(mailbox.nextQueued(AGENT)?.delivery.id, order, "After a restart the old held order starts a turn.");
  report.checks.push("after a restart a queued expectsReply-false order without fyi is released, not held");
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
