import { isDynamicRecord, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";
import {
  isOwnerDecisionBlock,
  normalizeUiBlockSpec,
  OWNER_DECISION_BLOCK_PREFIX,
  type UiBlockResponse,
  type UiConfirmBlock,
} from "@openbot/contracts/ui-blocks";
import { Effect } from "effect";
import { JsonStore } from "../agent-efficiency/json-store";

export const PAST_DECISIONS_FILE = "owner-decisions-v1.json";
/** Open decisions kept, newest first. The owner answers or dismisses each one; this only bounds the file. */
const KEPT = 200;

const GO_LIVE_KINDS = ["landings", "ads", "emails"] as const;

/** What the owner's answer does besides the agent's message: the go-live it grants, the audit record. */
export interface OwnerDecisionMeta {
  goLive?: (typeof GO_LIVE_KINDS)[number];
  amount?: { value: number; currency: string; platform?: string };
  ticket?: string;
  previewUrl?: string;
}

/** An owner decision card that waits for the owner, also once the agent's call ended. */
export interface PastDecision {
  blockId: string;
  agentId: string;
  /** The public thread that shows the card. */
  threadId: string;
  turnId: string;
  messageId: string;
  spec: UiConfirmBlock;
  meta: OwnerDecisionMeta;
  createdAt: string;
}

interface StoredDecisions {
  version: 1;
  decisions: PastDecision[];
}

const EMPTY: StoredDecisions = { version: 1, decisions: [] };

function decodeMeta(value: unknown): OwnerDecisionMeta {
  if (!isDynamicRecord(value)) return {};
  const meta: OwnerDecisionMeta = {};
  if (isOneOf(GO_LIVE_KINDS, value.goLive)) meta.goLive = value.goLive;
  const amount = value.amount;
  if (isDynamicRecord(amount) && isNumber(amount.value) && isString(amount.currency))
    meta.amount = {
      value: amount.value,
      currency: amount.currency,
      ...(isString(amount.platform) ? { platform: amount.platform } : {}),
    };
  if (isString(value.ticket)) meta.ticket = value.ticket;
  if (isString(value.previewUrl)) meta.previewUrl = value.previewUrl;
  return meta;
}

function decodeDecision(value: unknown): PastDecision | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.blockId) ||
    !isString(value.agentId) ||
    !isString(value.threadId) ||
    !isString(value.turnId) ||
    !isString(value.messageId) ||
    !isString(value.createdAt)
  )
    return null;
  const spec = normalizeUiBlockSpec(value.spec);
  if (spec?.type !== "confirm" || !isOwnerDecisionBlock({ blockId: value.blockId, spec })) return null;
  return {
    blockId: value.blockId,
    agentId: value.agentId,
    threadId: value.threadId,
    turnId: value.turnId,
    messageId: value.messageId,
    spec,
    meta: decodeMeta(value.meta),
    createdAt: value.createdAt,
  };
}

function decodeStored(value: unknown): StoredDecisions | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  return {
    version: 1,
    decisions: Array.isArray(value.decisions) ? value.decisions.flatMap((entry) => decodeDecision(entry) ?? []) : [],
  };
}

/**
 * The owner decision cards (`request_decision` with money or another owner-only class) that wait for
 * the owner. A card is kept from the moment it shows until the owner answers or dismisses it. The
 * agent's call can end first, on a restart or a stop: the card then stays open, and the owner's answer
 * goes to the agent as a message (`AttentionRegistry`, `pastDecisionRequestId`). The list is in
 * memory for the synchronous attention code and written to a small file after each change.
 */
export class PastDecisions {
  readonly #store: JsonStore<StoredDecisions> | null;
  #decisions = new Map<string, PastDecision>();

  /** Without a path the list lives in memory only, as in a test. */
  constructor(path: string | null) {
    this.#store = path ? new JsonStore(path, EMPTY, decodeStored) : null;
  }

  /** Reads the file once. A decision added before the read is kept. */
  readonly load = Effect.fn("PastDecisions.load")(function* (this: PastDecisions) {
    if (!this.#store) return;
    const stored = yield* this.#store.load();
    for (const decision of stored.decisions)
      if (!this.#decisions.has(decision.blockId)) this.#decisions.set(decision.blockId, decision);
  });

  add(decision: PastDecision): void {
    if (!decision.blockId.startsWith(OWNER_DECISION_BLOCK_PREFIX)) return;
    this.#decisions.set(decision.blockId, structuredClone(decision));
    const newest = [...this.#decisions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const old of newest.slice(KEPT)) this.#decisions.delete(old.blockId);
    this.#save();
  }

  get(blockId: string): PastDecision | undefined {
    return this.#decisions.get(blockId);
  }

  remove(blockId: string): void {
    if (this.#decisions.delete(blockId)) this.#save();
  }

  list(): PastDecision[] {
    return [...this.#decisions.values()];
  }

  #save(): void {
    const store = this.#store;
    if (!store) return;
    const decisions = this.list();
    Effect.runFork(store.update(() => ({ version: 1, decisions })));
  }
}

/**
 * What the agent reads when the owner answers its decision card after its call ended: the decision,
 * the choice, and what to do now. `goLive` says whether the answer granted the go-live.
 */
export function pastDecisionAnswerText(
  decision: PastDecision,
  response: UiBlockResponse,
  by: string,
  goLive: "granted" | "needs-owner" | null,
): string {
  const head = `Decision answer from ${by} — "${decision.spec.title}" (your request_decision call had already ended; card ${decision.blockId}):`;
  if (response.actionId === "_text") return `${head} they wrote: "${response.text ?? ""}". Follow their words.`;
  const action = decision.spec.actions.find((candidate) => candidate.id === response.actionId);
  if (response.actionId === "no") return `${head} No. Do not do it.`;
  if (response.actionId === "change")
    return `${head} ${action?.label ?? "Change"}. Ask in one sentence what to change.`;
  const option = /^option([1-3])$/u.exec(response.actionId)?.[1];
  const live =
    goLive === "granted"
      ? ` Go-live approved: run the ${decision.meta.goLive} publish command now.`
      : goLive === "needs-owner"
        ? " The go-live is not approved: only the owner or an admin can approve it. Ask the owner."
        : "";
  return `${head} option ${option ?? response.actionId} "${action?.label ?? ""}". Do it.${live}`;
}
