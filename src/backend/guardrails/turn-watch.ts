import { createHash } from "node:crypto";
import type { GuardrailPolicy, GuardrailRunKey } from "@openbot/contracts/guardrails";
import { toolTraceDetail, toolUsage } from "../agent/thread-items";
import { getString, type ThreadItem } from "../protocol";

/** What the watch asks for after a step: a nudge into the running turn, or a stop. */
export type TurnWatchVerdict =
  | { kind: "nudge"; text: string; summary: string }
  | { kind: "stop"; reason: "repeat" | GuardrailRunKey; text: string; summary: string };

/** The steps of a turn that the repeat check compares. Older steps are forgotten. */
const REPEAT_WINDOW = 40;
/** A tool with no result to compare repeats this many times the limit before it counts. */
const NO_RESULT_FACTOR = 2;

interface RunningTurn {
  agentId: string;
  routine: boolean;
  startedAt: number;
  steps: number;
  /** Estimated tokens: the context of each request, summed. */
  tokens: number;
  /** The input digest of each started step, by item id, until it completes. */
  started: Map<string, string>;
  /** The last completed steps, as `input|result` keys. */
  window: string[];
  nudged: boolean;
  stopped: boolean;
  recipients: Set<string>;
  progressed: boolean;
}

/** The end of a watched turn: whom it messaged and whether it did any other work. */
export interface WatchedTurnEnd {
  agentId: string;
  recipients: string[];
  progressed: boolean;
}

/** Tools that only read or talk. A turn of only these did no work of its own. */
const QUIET_TOOLS =
  /^(Read|Glob|Grep|LS|NotebookRead|TodoWrite|ToolSearch|openbot\.(send_message|post_channel_message|acknowledge_request|react_to_user_message|tool_describe|tool_search|(list|read|history|query)_[a-z_]+))$/u;

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex")
    .slice(0, 24);
}

/** A tool's name for people and for the quiet set: `server.tool` for MCP, else the provider's name. */
export function toolName(item: ThreadItem): string {
  const usage = toolUsage(item);
  if (usage?.server && usage.tool) return `${usage.server}.${usage.tool}`;
  return getString(item, "name") ?? getString(item, "tool") ?? item.type;
}

/** What makes two calls the same: the tool and its input. Claude sends a digest of the input. */
function inputKey(item: ThreadItem): string {
  return digest([
    item.type,
    toolName(item),
    item.inputDigest ?? null,
    item.command ?? null,
    item.arguments ?? null,
    item.query ?? null,
  ]);
}

/** What makes two results the same, or null when the item carries none. */
function resultKey(item: ThreadItem): string | null {
  const result = item.resultDigest ?? item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.error;
  return result === undefined || result === null ? null : digest(result);
}

/**
 * Watches the tool steps of each running turn: the circuit breakers (steps, estimated tokens and
 * minutes of one turn, with stricter limits for a routine run) and repeated identical calls with the
 * same result. A repeat nudges the turn once at `repeats` and stops it at twice that. It keeps
 * nothing after the turn ends; a restart forgets the counts, which only delays a stop.
 *
 * It also watches two agents that message each other: `PairWatch` below.
 */
export class TurnWatch {
  readonly #policy: () => GuardrailPolicy;
  readonly #now: () => number;
  readonly #turns = new Map<string, RunningTurn>();

  constructor(policy: () => GuardrailPolicy, now: () => number = Date.now) {
    this.#policy = policy;
    this.#now = now;
  }

  start(turnId: string, agentId: string, routine: boolean): void {
    if (this.#turns.has(turnId)) return;
    this.#turns.set(turnId, {
      agentId,
      routine,
      startedAt: this.#now(),
      steps: 0,
      tokens: 0,
      started: new Map(),
      window: [],
      nudged: false,
      stopped: false,
      recipients: new Set(),
      progressed: false,
    });
  }

  /** The agent of a running turn. */
  agentOf(turnId: string): string | null {
    return this.#turns.get(turnId)?.agentId ?? null;
  }

  #limits(turn: RunningTurn) {
    const policy = this.#policy();
    return turn.routine ? policy.routine : policy.turn;
  }

  #breaker(turn: RunningTurn, key: GuardrailRunKey, used: number): TurnWatchVerdict | null {
    const limit = this.#limits(turn)[key];
    if (limit === null || used <= limit || turn.stopped) return null;
    turn.stopped = true;
    const what = { maxSteps: "tool steps", maxTokens: "estimated tokens", maxMinutes: "minutes" }[key];
    const run = turn.routine ? "routine run" : "turn";
    return {
      kind: "stop",
      reason: key,
      text: `Atelier stopped this ${run}: it passed the limit of ${limit} ${what}. Do not start the same work again at once. Say in one line what you finished and what is left.`,
      summary: `Circuit breaker: ${run} passed ${limit} ${what} (${Math.round(used)}).`,
    };
  }

  /** A tool step started or completed. */
  tool(turnId: string, item: ThreadItem, completed: boolean): TurnWatchVerdict | null {
    const turn = this.#turns.get(turnId);
    if (!turn || !this.#policy().enabled) return null;
    const id = getString(item, "id") ?? "";
    const name = toolName(item);
    if (!completed) {
      if (turn.started.has(id)) return null;
      turn.started.set(id, inputKey(item));
      turn.steps += 1;
      return this.#breaker(turn, "maxSteps", turn.steps);
    }
    const input = turn.started.get(id) ?? inputKey(item);
    turn.started.delete(id);
    const recipients = toolTraceDetail(item).recipientAgentIds ?? [];
    for (const recipient of recipients) turn.recipients.add(recipient);
    if (!QUIET_TOOLS.test(name)) turn.progressed = true;
    const stuck = this.#policy().stuck;
    if (!stuck.enabled || turn.stopped) return null;
    const result = resultKey(item);
    const key = `${input}|${result ?? "?"}`;
    turn.window.push(key);
    if (turn.window.length > REPEAT_WINDOW) turn.window.shift();
    const same = turn.window.filter((entry) => entry === key).length;
    const limit = result === null ? stuck.repeats * NO_RESULT_FACTOR : stuck.repeats;
    if (same >= limit * 2) {
      turn.stopped = true;
      return {
        kind: "stop",
        reason: "repeat",
        text: `Atelier stopped this turn: you ran ${name} ${same} times with the same input and the same result. Do not repeat it. Say in one line what blocks you.`,
        summary: `Stuck: ${name} ran ${same} times with the same input and result.`,
      };
    }
    if (same >= limit && !turn.nudged) {
      turn.nudged = true;
      return {
        kind: "nudge",
        text: `Atelier guardrail: you ran ${name} ${same} times with the same input and got the same result each time. Stop repeating it. Change your approach, wait with openbot.await_event or a routine instead of a sleep loop, or end the turn and say what blocks you. At ${limit * 2} repeats Atelier stops the turn.`,
        summary: `Nudged: ${name} ran ${same} times with the same input and result.`,
      };
    }
    return null;
  }

  /** The context of one request of the turn, which adds to its estimated tokens. */
  context(turnId: string, tokens: number): TurnWatchVerdict | null {
    const turn = this.#turns.get(turnId);
    if (!turn || !this.#policy().enabled || !Number.isFinite(tokens) || tokens <= 0) return null;
    turn.tokens += tokens;
    return this.#breaker(turn, "maxTokens", turn.tokens);
  }

  /** The turns that ran past their minutes now. */
  overtime(): Array<{ turnId: string; agentId: string; verdict: TurnWatchVerdict }> {
    if (!this.#policy().enabled) return [];
    const now = this.#now();
    const stops: Array<{ turnId: string; agentId: string; verdict: TurnWatchVerdict }> = [];
    for (const [turnId, turn] of this.#turns) {
      const verdict = this.#breaker(turn, "maxMinutes", (now - turn.startedAt) / 60_000);
      if (verdict) stops.push({ turnId, agentId: turn.agentId, verdict });
    }
    return stops;
  }

  end(turnId: string): WatchedTurnEnd | null {
    const turn = this.#turns.get(turnId);
    if (!turn) return null;
    this.#turns.delete(turnId);
    return { agentId: turn.agentId, recipients: [...turn.recipients], progressed: turn.progressed };
  }

  /** The running turns of an agent. */
  turnsOf(agentId: string): string[] {
    return [...this.#turns].filter(([, turn]) => turn.agentId === agentId).map(([turnId]) => turnId);
  }
}

/** Messages between two agents count within this time. */
const PAIR_WINDOW_MS = 30 * 60_000;

export type PairVerdict = { kind: "nudge" | "stop"; agents: [string, string]; count: number };

/**
 * Two agents that message each other with no other work: each turn that only talks adds its
 * messages to the pair, and a turn that did other work clears its pairs. Messages in both directions
 * within 30 minutes count. At `pingPong` the pair is nudged once; at twice that both agents pause.
 */
export class PairWatch {
  readonly #policy: () => GuardrailPolicy;
  readonly #now: () => number;
  readonly #pairs = new Map<string, { at: number; from: string }[]>();
  readonly #nudged = new Set<string>();

  constructor(policy: () => GuardrailPolicy, now: () => number = Date.now) {
    this.#policy = policy;
    this.#now = now;
  }

  turnEnded(end: WatchedTurnEnd): PairVerdict[] {
    const policy = this.#policy();
    if (!policy.enabled || !policy.stuck.enabled) return [];
    const now = this.#now();
    const verdicts: PairVerdict[] = [];
    for (const recipient of end.recipients) {
      if (recipient === end.agentId) continue;
      const agents: [string, string] = end.agentId < recipient ? [end.agentId, recipient] : [recipient, end.agentId];
      const key = agents.join("\n");
      if (end.progressed) {
        this.#pairs.delete(key);
        this.#nudged.delete(key);
        continue;
      }
      const messages = (this.#pairs.get(key) ?? []).filter((message) => now - message.at <= PAIR_WINDOW_MS);
      messages.push({ at: now, from: end.agentId });
      this.#pairs.set(key, messages);
      if (new Set(messages.map((message) => message.from)).size < 2) continue;
      if (messages.length >= policy.stuck.pingPong * 2) {
        this.#pairs.delete(key);
        this.#nudged.delete(key);
        verdicts.push({ kind: "stop", agents, count: messages.length });
      } else if (messages.length >= policy.stuck.pingPong && !this.#nudged.has(key)) {
        this.#nudged.add(key);
        verdicts.push({ kind: "nudge", agents, count: messages.length });
      }
    }
    if (this.#pairs.size > 2_000) this.#pairs.clear();
    return verdicts;
  }
}
