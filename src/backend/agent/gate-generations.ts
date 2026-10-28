import type { AgentModelOption } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentClient, AgentProvider } from "../agent-client";
import type { GenerationObserver } from "./profile-generation";
import { WarmGenerations, type WarmGenerationsOptions } from "./warm-generations";

/**
 * How many gate generations of one provider stay warm. The gate asks once for each `always` member
 * of a channel, at the same time, and a cold client takes longer than the gate budget to start.
 */
const GATE_WARM_SLOTS = 2;

/**
 * Owns the warm clients without tools of the channel answer gate: `GATE_WARM_SLOTS` independent
 * `WarmGenerations`, used in turn, so parallel gate questions do not each start a provider process.
 * The workflow steps keep their own warm client. A gate generation still counts against the busy
 * limit of `ProfileClients`.
 *
 * It never imports the agent service facade.
 */
export class GateGenerations {
  readonly #slots: WarmGenerations[];
  #next = 0;

  constructor(options: WarmGenerationsOptions) {
    this.#slots = Array.from({ length: GATE_WARM_SLOTS }, () => new WarmGenerations(options));
  }

  generate(
    provider: AgentProvider,
    model: AgentModelOption,
    prompt: string,
    observe?: GenerationObserver,
  ): ReturnType<WarmGenerations["generate"]> {
    const slot = this.#slots[this.#next % this.#slots.length];
    this.#next += 1;
    if (!slot) return Effect.die(new Error("The gate has no warm slot."));
    return slot.generate(provider, model, prompt, observe);
  }

  readonly ownerStopped = Effect.fn("GateGenerations.ownerStopped")(function* (
    this: GateGenerations,
    owner: AgentClient,
  ) {
    for (const slot of this.#slots) yield* slot.ownerStopped(owner);
  });

  readonly stopIdle = Effect.fn("GateGenerations.stopIdle")(function* (this: GateGenerations, provider: AgentProvider) {
    for (const slot of this.#slots) yield* slot.stopIdle(provider);
  });

  readonly dispose = Effect.fn("GateGenerations.dispose")(function* (this: GateGenerations) {
    yield* Effect.forEach(this.#slots, (slot) => slot.dispose(), { concurrency: "unbounded", discard: true });
  });
}
