// Drives the owner's decision card of `request_decision` end to end below the providers: the real
// `TrustToolGate` shows it through the real `AttentionRegistry`, with `PastDecisions` and
// `TrustService` on files in a temporary folder. It checks that a money decision never answers
// itself, that its buttons answer the agent, that a card whose call ended (a restart, a stop) still
// takes the owner's answer and gives it to the right agent as a message, that the card survives a
// restart of the list, and that a dismissal only closes it. No app, account or provider is needed.
// `bun scripts/owner-decision-e2e.ts`. Writes .openbot-build/owner-decision-e2e/report.json.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent, ConversationSnapshot } from "@openbot/contracts/ipc";
import {
  isOwnerDecisionBlock,
  OWNER_DECISION_FIELD,
  ownerDecisionView,
  pastDecisionRequestId,
  type UiBlockResponse,
  uiBlockAnswersFromResponse,
} from "@openbot/contracts/ui-blocks";
import { Effect } from "effect";
import { AttentionRegistry, type PromptResponder } from "../src/backend/agent/attention-registry";
import { InactiveAttentionRequest } from "../src/backend/agent/inactive-attention-request";
import { type PastDecision, PastDecisions } from "../src/backend/agent/past-decisions";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { RequestId } from "../src/backend/protocol";
import { TrustAuditLog } from "../src/backend/trust/trust-audit-log";
import { TrustService } from "../src/backend/trust/trust-service";
import { TrustToolGate } from "../src/backend/trust/trust-tool-gate";

const OUT = resolve(import.meta.dirname, "../.openbot-build/owner-decision-e2e");
const dir = mkdtempSync(join(tmpdir(), "owner-decision-e2e-"));
const THREAD = "thread-cso";
const CSO = "agent-cso";
const OWNER: PromptResponder = { sender: { id: "owner-1", name: "Alejandro" }, privileged: true };

/** The JSON of a `request_decision` result, as the gate writes it. */
interface AgentAnswer {
  status: string;
  option?: number | string;
  label?: string;
}

/** Records what Atelier answers to the agent's tool call. */
class RecordingClient extends CodexAppServerClient {
  readonly answers = new Map<RequestId, { success: boolean; value: AgentAnswer | null }>();

  override get running(): boolean {
    return true;
  }

  override respond(id: RequestId, result: unknown): void {
    const parsed: { success?: boolean; contentItems?: Array<{ text?: string }> } = JSON.parse(JSON.stringify(result));
    const text = parsed.contentItems?.[0]?.text;
    this.answers.set(id, { success: parsed.success !== false, value: text ? JSON.parse(text) : null });
  }
}

const client = new RecordingClient("/nonexistent/codex");
const snapshot: ConversationSnapshot = {
  agentId: CSO,
  threadId: THREAD,
  activeTurnId: null,
  revision: 0,
  messages: [],
};
const events: AgentEvent[] = [];
const decisionsFile = join(dir, "owner-decisions-v1.json");
const pastDecisions = new PastDecisions(decisionsFile);
const registry = new AttentionRegistry({
  conversation: {
    agentForThread: (threadId) => (threadId === THREAD ? CSO : undefined),
    publicThreadId: (_agentId, threadId) => threadId,
    ensureSnapshot: () => snapshot,
    emitConversation: () => {
      snapshot.revision += 1;
    },
  },
  browser: { listTabs: () => [], beginTakeover: () => Effect.void, endTakeover: () => {} },
  hostedSites: { prepareApproval: () => Effect.succeed(null), resolveApproval: () => Effect.void },
  routines: { markNeedsAttention: () => {}, markRunningForTurn: () => {} },
  emit: (event) => events.push(event),
  emitError: () => {},
  emitRuntimeSnapshot: () => {},
  agentName: (agentId) => (agentId === CSO ? "CSO - Director de Ventas" : undefined),
  pastDecisions,
});
const trust = new TrustService({
  file: join(dir, "trust-policy.json"),
  audit: new TrustAuditLog(join(dir, "trust-audit")),
  directory: { agents: () => [{ id: CSO, name: "CSO - Director de Ventas" }], spaceOf: () => "space-1" },
});
const gate = new TrustToolGate({
  trust,
  attention: registry,
  agentForThread: (threadId) => (threadId === THREAD ? CSO : undefined),
  publicThreadId: (_agent, threadId) => threadId,
  listTabs: () => [],
  messagingThread: () => false,
});
/** What the agent service does with a late answer: the gate's record, then a message to the agent. */
const delivered: Array<{ agentId: string; text: string; from: string | undefined }> = [];
registry.onPastDecisionAnswered((decision, response, responder) =>
  Effect.sync(() => {
    delivered.push({
      agentId: decision.agentId,
      text: gate.pastDecisionAnswered(decision, response, responder),
      from: responder?.sender?.name,
    });
  }),
);

/** The card the owner saw on 2026-11-26, with the money, the ticket and the Ads Manager link. */
const CAMPAIGN = {
  title: "Campaña navideña del 1 al 23 de diciembre: ¿cuánto gastamos como máximo en total?",
  options: [
    { label: "125 USD: 3/día y luego 7", consequence: "3 USD al día del 1 al 9 y 7 USD al día del 10 al 23." },
    { label: "161 USD: 7/día siempre", consequence: "Mismo gasto diario los 23 días." },
    { label: "98 USD: unos 4,25/día", consequence: "No sube el total aprobado." },
  ],
  recommended: 1,
  amount: { value: 125, currency: "USD", platform: "meta" },
  ticket: "COC-25",
  previewUrl: "https://adsmanager.facebook.com/adsmanager/manage/ads?act=1666106438553775&selected_campaign_ids=1",
  preview: "Elegir una opción no activa los anuncios.",
  // An agent may still give these; an owner card must ignore them.
  timeoutMinutes: 1,
  defaultOption: 4,
};

let nextRequest = 1;
function decide(turnId: string, args: typeof CAMPAIGN = CAMPAIGN) {
  const id = nextRequest++;
  gate.requestDecision(
    client,
    { id, method: "item/tool/call", params: { threadId: THREAD, turnId } },
    { threadId: THREAD, turnId, callId: `call-${id}`, namespace: "openbot", tool: "request_decision", arguments: args },
  );
  const message = snapshot.messages.find((candidate) => candidate.id === `question-prompt:${turnId}:${id}`);
  assert(message?.uiBlock, "the decision card was not shown");
  return { id, message, block: message.uiBlock };
}

function answers(response: UiBlockResponse, spec: Parameters<typeof uiBlockAnswersFromResponse>[0]) {
  return uiBlockAnswersFromResponse(spec, response);
}

const steps: Array<{ step: string; result: unknown }> = [];
async function step(name: string, run: () => unknown): Promise<void> {
  try {
    steps.push({ step: name, result: (await run()) ?? "ok" });
  } catch (error) {
    steps.push({ step: name, result: { failed: error instanceof Error ? error.message : String(error) } });
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Waits for the list file to say what is expected: its writes run after each change. */
async function fileHas(blockId: string, present: boolean): Promise<void> {
  for (;;) {
    let text = "";
    try {
      text = readFileSync(decisionsFile, "utf8");
    } catch {
      // Not written yet.
    }
    if (text.includes(blockId) === present) return;
    await new Promise<void>((done) => setImmediate(done));
  }
}

await mkdir(OUT, { recursive: true });
try {
  let first: ReturnType<typeof decide> | undefined;
  await step("a money decision for the owner shows a plain card that never answers itself", () => {
    first = decide("turn-1");
    const { block, id } = first;
    assert.ok(isOwnerDecisionBlock(block), "not marked as an owner decision");
    assert.equal(block.state.status, "pending");
    assert.equal(block.state.autoAnswer, undefined, "the owner card has a timeout");
    assert.equal(client.answers.has(id), false, "the call was answered without the owner");
    assert.equal(block.spec.type, "confirm");
    if (block.spec.type !== "confirm") return;
    const labels = (block.spec.fields ?? []).map((field) => field.label);
    assert.ok(!labels.includes("#") && !labels.includes("💰") && !labels.includes("⏱"), `noise: ${labels.join(", ")}`);
    assert.ok(!block.spec.preview?.includes("adsmanager"), "the raw link is in the text");
    const view = ownerDecisionView(block.spec);
    assert.deepEqual(
      view.options.map((option) => [option.action.label, option.recommended, Boolean(option.consequence)]),
      [
        ["125 USD: 3/día y luego 7", true, true],
        ["161 USD: 7/día siempre", false, true],
        ["98 USD: unos 4,25/día", false, true],
      ],
    );
    assert.equal(view.askedBy, "CSO - Director de Ventas");
    assert.equal(view.amount, "125 USD");
    assert.equal(view.ticket, "COC-25");
    assert.ok(view.link?.startsWith("https://adsmanager.facebook.com/"));
    assert.ok(labels.includes(OWNER_DECISION_FIELD.askedBy));
    return { fields: block.spec.fields, actions: block.spec.actions };
  });

  await step("the waiting card is in Needs you once, as the live question", () => {
    const items = registry.attentionItems().filter((item) => item.agentId === CSO);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.requestId, first?.id);
  });

  await step("a button answers the waiting agent", async () => {
    assert(first);
    const { id, block, message } = first;
    if (block.spec.type !== "confirm") throw new Error("not a confirm");
    await runCauseEffect(
      registry.respondToPrompt({ requestId: id, answers: answers({ actionId: "option2" }, block.spec) }, OWNER),
    );
    const got = client.answers.get(id)?.value;
    assert.equal(got?.status, "answered");
    assert.equal(got?.option, 2);
    assert.equal(got?.label, "161 USD: 7/día siempre");
    assert.equal(message.uiBlock?.state.status, "answered");
    assert.equal(pastDecisions.get(block.blockId), undefined, "an answered card still waits");
    assert.equal(registry.attentionItems().length, 0);
    return got;
  });

  let ended: ReturnType<typeof decide> | undefined;
  await step("a restart ends the call: the card stays open in Needs you", async () => {
    ended = decide("turn-2");
    const { id, block, message } = ended;
    registry.cancelRequest(client, id);
    assert.equal(client.answers.get(id)?.value?.status, "expired");
    assert.equal(message.uiBlock?.state.status, "expired");
    const items = registry.attentionItems();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.requestId, pastDecisionRequestId(block.blockId));
    assert.equal(registry.agentIdForRequest(pastDecisionRequestId(block.blockId)), CSO);
    await fileHas(block.blockId, true);
    const reloaded = new PastDecisions(decisionsFile);
    await Effect.runPromise(reloaded.load());
    const kept: PastDecision | undefined = reloaded.get(block.blockId);
    assert.equal(kept?.agentId, CSO, "the card did not survive a restart of the list");
    return items[0];
  });

  await step("the owner answers the expired card: the asking agent gets it as a message", async () => {
    assert(ended);
    const { block, message } = ended;
    if (block.spec.type !== "confirm") throw new Error("not a confirm");
    const requestId = pastDecisionRequestId(block.blockId);
    await runCauseEffect(
      registry.respondToPrompt({ requestId, answers: answers({ actionId: "option1" }, block.spec) }, OWNER),
    );
    assert.equal(delivered.length, 1);
    const sent = delivered[0];
    assert.equal(sent?.agentId, CSO);
    assert.equal(sent?.from, "Alejandro");
    assert.ok(sent?.text.startsWith("Decision answer from Alejandro"), sent?.text);
    assert.ok(sent?.text.includes('"125 USD: 3/día y luego 7"'), sent?.text);
    assert.equal(message.uiBlock?.state.status, "answered");
    assert.equal(message.uiBlock?.state.response?.actionId, "option1");
    assert.equal(message.questionPrompt?.resolution?.status, "answered");
    assert.equal(pastDecisions.get(block.blockId), undefined);
    assert.equal(registry.attentionItems().length, 0);
    const audit = trust.audit.query({ limit: 5 });
    assert.ok(
      audit.some((entry) => entry.summary.includes("after the call ended") && entry.amount === 125),
      "no audit record",
    );
    const again = await runCauseEffect(
      registry.respondToPrompt({ requestId, answers: answers({ actionId: "option1" }, block.spec) }, OWNER),
    ).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.ok(again instanceof InactiveAttentionRequest, `a second answer went through: ${String(again)}`);
    await fileHas(block.blockId, false);
    return sent;
  });

  await step("the owner dismisses an expired card: it closes and the agent gets nothing", async () => {
    const { id, block, message } = decide("turn-3");
    registry.cancelRequest(client, id);
    await runCauseEffect(
      registry.respondToPrompt({ requestId: pastDecisionRequestId(block.blockId), answers: {} }, OWNER),
    );
    assert.equal(delivered.length, 1, "a dismissal sent a message");
    assert.equal(message.uiBlock?.state.status, "closed");
    assert.equal(registry.attentionItems().length, 0);
  });

  await step("the lasting id answers a card whose call still waits, through the call", async () => {
    const { id, block } = decide("turn-4");
    if (block.spec.type !== "confirm") throw new Error("not a confirm");
    await runCauseEffect(
      registry.respondToPrompt(
        { requestId: pastDecisionRequestId(block.blockId), answers: answers({ actionId: "no" }, block.spec) },
        OWNER,
      ),
    );
    assert.equal(client.answers.get(id)?.value?.option, "no");
    assert.equal(delivered.length, 1, "the waiting call's answer became a message");
  });

  await writeFile(resolve(OUT, "report.json"), `${JSON.stringify({ ok: true, steps }, null, 2)}\n`);
  process.stdout.write(`owner-decision-e2e: ${steps.length} steps passed\n`);
} catch (error) {
  await writeFile(
    resolve(OUT, "report.json"),
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), steps }, null, 2)}\n`,
  );
  process.stderr.write(`owner-decision-e2e failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
