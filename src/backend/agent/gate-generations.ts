import type { AgentModelOption } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Option, Semaphore } from "effect";
import type { AgentClient, AgentProvider } from "../agent-client";
import { type GenerationObserver, ProfileGenerationFailed } from "./profile-generation";
import { WarmGenerations, type WarmGenerationsOptions } from "./warm-generations";

/**
 * The most gate generations that run at once, and the most warm clients the gate keeps for one
 * provider. The gate asks once for each gated member of a channel, at the same time, and a cold
 * client takes longer than the gate budget to start.
 */
export const GATE_CONCURRENCY = 8;
/** How often a gate question that found the budget full asks for a place again. */
const GATE_QUEUE_POLL_MS = 100;

interface GateSlot {
  readonly warm: WarmGenerations;
  /** The generations that run on this slot now. */
  running: number;
}

/**
 * Owns the warm clients without tools of the channel answer gate and their own concurrency budget:
 * at most `GATE_CONCURRENCY` gate generations run at once, apart from the limit of `ProfileClients`
 * that the profile drafts, the workflow steps and the side questions share, so a channel with many
 * gated members does not fail them or hold them back. A question that finds the budget full waits
 * for a place until its deadline, then fails.
 *
 * The warm pool grows to the number of questions of one message (at most `GATE_CONCURRENCY` slots,
 * each one `WarmGenerations`); a question takes the slot with the fewest running generations among
 * the ones that message needs, so parallel questions do not each start a provider process. The
 * generations run in the `ProfileClients` given in the options, which the service keeps for the
 * gate alone, so the OpenCode endpoint stop and the shutdown still reach them.
 *
 * It never imports the agent service facade.
 */
export class GateGenerations {
  readonly #options: WarmGenerationsOptions;
  readonly #slots: GateSlot[] = [];
  readonly #permits = Semaphore.makeUnsafe(GATE_CONCURRENCY);

  constructor(options: WarmGenerationsOptions) {
    this.#options = options;
  }

  /**
   * One gate question. `pool` is the number of questions that the message asks at once; `deadline`
   * (epoch milliseconds) is the time by which it must start.
   */
  generate(
    provider: AgentProvider,
    model: AgentModelOption,
    prompt: string,
    generation: { pool: number; deadline: number },
    observe?: GenerationObserver,
  ): Effect.Effect<string, unknown> {
    const run = Effect.suspend(() => {
      const slot = this.#slot(generation.pool);
      slot.running += 1;
      return slot.warm
        .generate(provider, model, prompt, observe)
        .pipe(Effect.ensuring(Effect.sync(() => (slot.running -= 1))));
    });
    // A full budget is asked again every `GATE_QUEUE_POLL_MS` until the deadline. The permit is taken
    // and given back by the semaphore itself, so an interrupt never loses one.
    const attempt: Effect.Effect<string, unknown> = this.#permits
      .withPermitsIfAvailable(1)(run)
      .pipe(
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Date.now() + GATE_QUEUE_POLL_MS > generation.deadline
              ? Effect.fail(new ProfileGenerationFailed({ cause: new Error(sourceText("error.workflow.modelBusy")) }))
              : Effect.sleep(GATE_QUEUE_POLL_MS).pipe(Effect.andThen(Effect.suspend(() => attempt))),
        ),
      );
    return attempt;
  }

  /** The least busy slot of the first `pool` ones, made when the pool grows. */
  #slot(pool: number): GateSlot {
    const size = Math.min(GATE_CONCURRENCY, Math.max(1, Math.floor(pool)));
    while (this.#slots.length < size) this.#slots.push({ warm: new WarmGenerations(this.#options), running: 0 });
    let best = this.#slots[0];
    for (const slot of this.#slots.slice(0, size)) if (!best || slot.running < best.running) best = slot;
    if (!best) throw new Error("The gate has no warm slot.");
    return best;
  }

  readonly ownerStopped = Effect.fn("GateGenerations.ownerStopped")(function* (
    this: GateGenerations,
    owner: AgentClient,
  ) {
    for (const slot of this.#slots) yield* slot.warm.ownerStopped(owner);
  });

  readonly stopIdle = Effect.fn("GateGenerations.stopIdle")(function* (this: GateGenerations, provider: AgentProvider) {
    for (const slot of this.#slots) yield* slot.warm.stopIdle(provider);
  });

  readonly dispose = Effect.fn("GateGenerations.dispose")(function* (this: GateGenerations) {
    yield* Effect.forEach(this.#slots, (slot) => slot.warm.dispose(), { concurrency: "unbounded", discard: true });
  });
}
