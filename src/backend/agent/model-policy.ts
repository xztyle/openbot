import type { AutoModelReason, ModelTier } from "@openbot/contracts/agent-efficiency";
import type { AgentEvent, AgentModelOption, AgentSummary } from "@openbot/contracts/ipc";

/**
 * The automatic model policy. Each turn of an agent set to `auto` takes a model from what starts it,
 * with no model call: the small model for routine runs, teammates' notes and short status questions
 * of people, the medium model for the usual work, and the large one for a lead's planning turn, a
 * turn after a failed one, or when the agent asked for it with `escalate_model`. The large model
 * holds for one turn; the next one goes back down by itself.
 *
 * A provider caches the prompt of a session for one model only. Sessions are large (a few hundred
 * thousand tokens), so a model change in a session that is still warm rewrites the whole cache, which
 * costs more than the turn saves. So the tier applies freely only to a session of its own (a routine
 * run in the agent's own chat starts one and closes it). In a shared session (the agent's chat, a
 * channel, a task) a turn stays on the agent's model; it goes to the large model only after a real
 * failure or an escalation, or for a planning turn when the session's cache is cold.
 *
 * It holds no durable state: a restart forgets a failure and an escalation, which only means one turn
 * on the medium model. It never chooses a model that the agent's provider does not list now, nor one
 * that a usage limit holds; it keeps the agent's own model then.
 */

/** What the policy reads of each delivery that starts a turn. */
export interface TurnDeliveryShape {
  senderKind: string;
  text: string;
  attachments: number;
  expectsReply: boolean;
  fyi: boolean;
  replyToMessageId: string | null;
}

export interface TurnModelChoice {
  model: string;
  tier: ModelTier | null;
  reason: AutoModelReason;
  /** True when the turn runs on another model than the last turn of its session while that cache was warm. */
  switched?: boolean;
}

/** Where a turn runs: a session of its own, or a shared one of its lane (chat, channel or task). */
export interface TurnPlace {
  ownSession: boolean;
  lane: string;
}

/** A person's message up to this length that asks for a status, greets or thanks. */
const STATUS_TEXT_LIMIT = 160;
/** A teammate's note or a routine run up to this length stays on the small model. */
const SMALL_INPUT_LIMIT = 2_000;
/**
 * A routine run whose instruction is up to this long runs on the small model. Every routine of the
 * live host in the week of 2026-11-14 was under it.
 */
const ROUTINE_INPUT_LIMIT = 4_000;
/** Input past this length is never small work. */
const LARGE_INPUT_LIMIT = 6_000;
/** A person's message to a lead past this length is a planning turn. */
const PLAN_TEXT_LIMIT = 600;
/** A shared session idle this long has no warm cache left (the host asks for a one-hour cache). */
const COLD_SESSION_MS = 60 * 60_000;

const STATUS_WORDS =
  /\b(estado|status|c[oó]mo\s+va|qu[eé]\s+tal|avance|progreso|progress|update|resumen|summary|d[oó]nde\s+est[aá]|where\s+are|hola|hi|hello|hey|gracias|thanks|thank\s+you|ok|vale|perfecto|genial|great)\b/iu;
const WORK_WORDS =
  /\b(haz|hazlo|crea|escribe|rehaz|corrige|arregla|cambia|lanza|publica|dise[nñ]a|make|create|write|fix|change|build|deploy|redo|draft)\b/iu;
const PLAN_WORDS =
  /\b(plan|planea|planifica|estrategia|strategy|organiza|prioriza|prioritize|roadmap|reparte|asigna|delegate|delega|coordina|arquitectura)\b/iu;

/** The tier that a model id names, from the Claude family words. Another provider's model has none. */
export function modelTier(id: string): ModelTier | null {
  const lower = id.toLowerCase();
  if (lower.includes("haiku")) return "small";
  if (lower.includes("sonnet")) return "medium";
  if (lower.includes("opus")) return "large";
  return null;
}

/**
 * The model of `tier` for this agent: its own model when that is of the tier, else the newest listed
 * model of the tier from its provider. Null when the provider lists none.
 */
export function tierModel(
  agent: Pick<AgentSummary, "provider" | "model">,
  tier: ModelTier,
  models: readonly AgentModelOption[],
): string | null {
  if (modelTier(agent.model) === tier) return agent.model;
  const candidates = models
    .filter((model) => model.provider === agent.provider && !model.id.includes("[") && modelTier(model.id) === tier)
    .map((model) => model.id)
    .sort((left, right) => right.localeCompare(left));
  return candidates[0] ?? null;
}

/** The tier and the reason for a turn, from what starts it. */
export function classifyTurn(
  deliveries: readonly TurnDeliveryShape[],
  context: { lead: boolean; failedLast: boolean; escalated: boolean },
): { tier: ModelTier; reason: AutoModelReason } {
  if (context.escalated) return { tier: "large", reason: "escalated" };
  if (context.failedLast) return { tier: "large", reason: "retry" };
  const size = deliveries.reduce((total, delivery) => total + delivery.text.length, 0);
  const people = deliveries.filter((delivery) => delivery.senderKind === "user");
  if (people.length > 0) {
    const text = people.map((delivery) => delivery.text).join("\n");
    if (context.lead && (text.length > PLAN_TEXT_LIMIT || PLAN_WORDS.test(text)))
      return { tier: "large", reason: "plan" };
    const attachments = people.some((delivery) => delivery.attachments > 0);
    if (!attachments && text.length <= STATUS_TEXT_LIMIT && STATUS_WORDS.test(text) && !WORK_WORDS.test(text))
      return { tier: "small", reason: "status" };
    return { tier: "medium", reason: size > LARGE_INPUT_LIMIT ? "large" : "default" };
  }
  if (size > LARGE_INPUT_LIMIT) return { tier: "medium", reason: "large" };
  if (deliveries.length > 0 && deliveries.every((delivery) => delivery.senderKind === "routine"))
    return size <= ROUTINE_INPUT_LIMIT ? { tier: "small", reason: "routine" } : { tier: "medium", reason: "large" };
  // A teammate's note or an fyi digest: nobody waits for an answer, and it asks for no work.
  const notes = deliveries.filter((delivery) => delivery.senderKind === "agent");
  if (
    notes.length > 0 &&
    deliveries.every((delivery) => delivery.senderKind === "agent" || delivery.senderKind === "routine") &&
    notes.every((delivery) => delivery.fyi || (!delivery.expectsReply && delivery.replyToMessageId === null)) &&
    size <= SMALL_INPUT_LIMIT
  )
    return { tier: "small", reason: "note" };
  return { tier: "medium", reason: "default" };
}

export interface ModelPolicyOptions {
  agents(): readonly AgentSummary[];
  /** The models the providers list now. */
  models(): readonly AgentModelOption[];
  /** Whether a usage limit holds this model of the agent. */
  limited(agentId: string, model: string): boolean;
}

/** The chosen model of each running turn, for the fleet and the working line. */
export interface TurnModelRecord extends TurnModelChoice {
  agentId: string;
  turnId: string;
  lane: string | null;
}

export class ModelPolicy {
  readonly #options: ModelPolicyOptions;
  /** The agents whose last turn failed. Their next turn runs on the large model once. */
  readonly #failed = new Set<string>();
  /** The agents that asked for the large model for their next turn. */
  readonly #escalated = new Set<string>();
  /** The choice of each running turn, by turn id. Small: it goes when the turn ends. */
  readonly #running = new Map<string, TurnModelRecord>();
  /** The model and the end of the last turn of each shared session lane. */
  readonly #lanes = new Map<string, { model: string; endedAt: number | null }>();
  /** Turns that changed the model of a warm session since start: the guard should keep this at zero. */
  #warmSwitches = 0;

  constructor(options: ModelPolicyOptions) {
    this.#options = options;
  }

  /**
   * The model for the next turn of `agent`. A fixed agent keeps its model; an `auto` one takes the
   * tier of the turn, or its own model when the provider lists no model of that tier or a usage limit
   * holds it.
   */
  choose(agent: AgentSummary, deliveries: readonly TurnDeliveryShape[], place: TurnPlace): TurnModelChoice {
    if (agent.modelPolicy !== "auto") return { model: agent.model, tier: modelTier(agent.model), reason: "default" };
    const agents = this.#options.agents();
    const lead = agents.some(
      (other) => other.id !== agent.id && (other.reportsToAgentId ?? other.createdBy?.agentId) === agent.id,
    );
    const { tier, reason } = classifyTurn(deliveries, {
      lead,
      failedLast: this.#failed.has(agent.id),
      escalated: this.#escalated.has(agent.id),
    });
    const own = { model: agent.model, tier: modelTier(agent.model), reason } as const;
    if (!place.ownSession) {
      const last = this.#lanes.get(place.lane);
      const cold = !last || (last.endedAt !== null && Date.now() - last.endedAt >= COLD_SESSION_MS);
      // A shared session keeps the agent's model. Only a real failure, an escalation, or a planning
      // turn on a cold cache moves it up, and only to the large model.
      const up = tier === "large" && (reason === "retry" || reason === "escalated" || (reason === "plan" && cold));
      if (!up) return { ...own, reason: tier === "medium" ? reason : "default" };
    }
    const model = tierModel(agent, tier, this.#options.models());
    if (model === null || (model !== agent.model && this.#options.limited(agent.id, model))) return own;
    return { model, tier, reason };
  }

  /** The turn started on the choice: the escalation and the failure are spent. */
  started(agentId: string, turnId: string, choice: TurnModelChoice, place: TurnPlace): void {
    this.#escalated.delete(agentId);
    this.#failed.delete(agentId);
    let switched = false;
    if (!place.ownSession) {
      const last = this.#lanes.get(place.lane);
      switched =
        last !== undefined &&
        last.model !== choice.model &&
        (last.endedAt === null || Date.now() - last.endedAt < COLD_SESSION_MS);
      if (switched) this.#warmSwitches += 1;
      this.#lanes.set(place.lane, { model: choice.model, endedAt: null });
    }
    this.#running.set(turnId, { ...choice, switched, agentId, turnId, lane: place.ownSession ? null : place.lane });
  }

  /** The turns that changed the model of a warm session since this process started. */
  warmSwitches(): number {
    return this.#warmSwitches;
  }

  /** The agent asked for the large model for its next turn. */
  escalate(agentId: string): void {
    this.#escalated.add(agentId);
  }

  /** The choice of a running turn, or null. */
  running(turnId: string): TurnModelRecord | null {
    return this.#running.get(turnId) ?? null;
  }

  observe(event: AgentEvent): void {
    if (event.type !== "turn-completed") return;
    const record = this.#running.get(event.turnId);
    this.#running.delete(event.turnId);
    if (record?.lane) this.#lanes.set(record.lane, { model: record.model, endedAt: Date.now() });
    // Only an automatic turn that failed raises the next one; a fixed agent has nothing to raise.
    if (event.status === "failed" && record && record.tier !== "large") this.#failed.add(event.agentId);
  }

  forget(agentId: string): void {
    this.#failed.delete(agentId);
    this.#escalated.delete(agentId);
  }
}
