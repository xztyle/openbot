// A message between agents whose idempotency key holds a long Codex id is sent, not refused with
// "The idempotency key is too long.". The mailbox (src/backend/mailbox-store.ts) keeps each key in one
// form (src/backend/idempotency-key.ts):
// 1. An agent note keyed by a Codex turn id and a long Codex call id is queued, and the stored key fits
//    the identifier limit.
// 2. The same key again gives the same message: a retry sends nothing twice. `receiptForKey` and
//    `deliveryForKey` find it by the long key.
// 3. Two long keys that differ only at the end give two messages.
// 4. A long `user-send:` key keeps its kind, so `forgetIdempotencyKeys("user-send:")` still forgets it.
// 5. The state on disk survives a new store: the long key finds its message after a restart.
//
// `bun scripts/mailbox-long-idempotency-key-e2e.ts`. Writes .openbot-build/mailbox-long-idempotency-key-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/mailbox-long-idempotency-key-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-long-key-"));
const userData = join(root, "user-data");
const shared = join(root, "Shared");
mkdirSync(userData, { recursive: true });
mkdirSync(shared, { recursive: true });

// A Codex turn id and call id as Codex 0.17x makes them, with the request id of an approval.
const codexTurn = "019a7c3e-5f21-7d40-9b8e-2c1f0e6a4d93";
const codexCall = `call_${"Xk9pQ2vR7tLmN4wZ".repeat(8)}`;
const noteKey = `input-escalation/agent-creativo/${codexTurn}/command/${codexCall}`.replaceAll(":", "_");
const report: {
  passed: boolean;
  noteKeyLength: number;
  firstMessageId?: string;
  userSendMessageId?: string;
  storedKeys?: string[];
  error?: string;
} = { passed: false, noteKeyLength: noteKey.length };

/** The keys that the database holds, as a restart reads them. */
function storedKeys(database: OpenBotDatabase): string[] {
  const state = database.readMailboxState();
  return typeof state === "object" && state !== null && "idempotency" in state && typeof state.idempotency === "object"
    ? Object.keys(state.idempotency ?? {})
    : [];
}

try {
  assert(noteKey.length > INPUT_LIMITS.identifier, "The key is longer than the limit, as the real one was.");
  const database = new OpenBotDatabase(userData);
  const mailbox = new MailboxStore(userData, shared, database);
  await runCauseEffect(mailbox.initialize());
  const send = (key: string, text: string, sender = "agent-creativo") =>
    runCauseEffect(
      mailbox.enqueue({
        sender: { kind: "agent", agentId: sender },
        recipientAgentIds: ["agent-cso"],
        text,
        replyToMessageId: null,
        expectsReply: false,
        idempotencyKey: key,
      }),
    );

  // 1.
  const first = await send(noteKey, "Atelier note: Creativo is blocked waiting for the user.");
  assert.ok(first.messageId, "The note was queued.");
  report.firstMessageId = first.messageId;

  // 2.
  const retry = await send(noteKey, "Atelier note: Creativo is blocked waiting for the user.");
  assert.equal(retry.messageId, first.messageId, "A retry with the same long key sent a second message.");
  assert.equal(mailbox.receiptForKey(noteKey)?.messageId, first.messageId, "receiptForKey did not find it.");
  assert.equal(mailbox.deliveryForKey(noteKey)?.delivery.messageId, first.messageId, "deliveryForKey did not find it.");

  // 3.
  const other = await send(`${noteKey}2`, "A second note.");
  assert.notEqual(other.messageId, first.messageId, "Two different long keys gave one message.");

  // 4.
  const userKey = `user-send:${"client-".repeat(30)}`;
  const userSend = await send(userKey, "From the owner's tab.");
  const keys = storedKeys(database);
  report.storedKeys = keys;
  assert(
    keys.every((key) => key.length <= INPUT_LIMITS.identifier),
    "A stored key is longer than the limit.",
  );
  assert(
    keys.some((key) => key.startsWith("user-send:")),
    "The long user-send key lost its kind.",
  );
  mailbox.forgetIdempotencyKeys("user-send:", new Date(Date.now() + 60_000));
  assert.equal(mailbox.receiptForKey(userKey), null, "forgetIdempotencyKeys did not forget the long key.");
  assert.equal(mailbox.receiptForKey(noteKey)?.messageId, first.messageId, "It forgot a key of another kind.");
  report.userSendMessageId = userSend.messageId;

  // 5.
  const reopened = new MailboxStore(userData, shared, new OpenBotDatabase(userData));
  await runCauseEffect(reopened.initialize());
  assert.equal(reopened.receiptForKey(noteKey)?.messageId, first.messageId, "The key did not survive a restart.");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
