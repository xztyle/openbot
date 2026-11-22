import { join } from "node:path";
import type { LearningReviewItem } from "@openbot/contracts/agent-learning";
import type { ValueReport } from "@openbot/contracts/portfolio";
import { Effect, Option } from "effect";

import { CHAT_CARDS_FILE, ChatCards, type ChatCardsHooks } from "./chat-cards";
import { LIVE_QUALITY_FILE, LiveQuality, type LiveQualityHooks } from "./live-quality";
import { REALITY_CHECK_FILE, RealityCheck, type RealityCheckHooks } from "./reality-check";
import { type ProfileChange, SCENARIO_SUITES_FILE, ScenarioSuites, type ScenarioSuitesHooks } from "./scenario-suites";
import { SPACE_TEMPLATES_FILE, SpaceTemplates, type SpaceTemplatesHooks } from "./space-templates";
import { VALUE_LEDGER_FILE, type ValueInputs, ValueLedger, valueReport } from "./value-ledger";

type Without<T, K extends keyof T> = Omit<T, K>;

/** How long the accept of a learning item waits for the rehearsal of its change. */
const VET_TIMEOUT_MS = 100_000;

export interface PortfolioServiceOptions {
  userDataPath: string;
  suites: Without<ScenarioSuitesHooks, "path">;
  quality: Without<LiveQualityHooks, "path">;
  templates: Without<SpaceTemplatesHooks, "path">;
  reality: Without<RealityCheckHooks, "path" | "cardsDone">;
  cards: Without<ChatCardsHooks, "path">;
  value: {
    /** The cost of each agent and the money rows of the insight report, for the last `days`. */
    insight(days: number): Effect.Effect<Pick<ValueInputs, "costs" | "money"> | null>;
    agents(): readonly { id: string; spaceId: string }[];
    spaces(): readonly { id: string }[];
  };
}

/** What a learning change does after its rehearsal: apply, apply with a warning, or wait. */
export interface LearningVerdict {
  outcome: "apply" | "warn" | "block";
  note: string | null;
}

/** The change of a learning item that a rehearsal can try, or null for a memory or a copied skill. */
export function learningChange(item: LearningReviewItem): ProfileChange | null {
  for (const change of item.changes) {
    if (change.type === "instructions-add") return { kind: "instructions", text: change.text };
    if (change.type === "playbook-add") return { kind: "playbook", slug: change.slug, text: change.text };
    if (change.type === "skill-add") return { kind: "skill", name: change.name, text: change.text };
  }
  return null;
}

/**
 * The portfolio tools of the host, one object for the routes, the tools and the hooks of the agent
 * service: the test suites and the live score, the space templates, the value ledger, the weekly
 * reality check and the interactive cards. Each part keeps its own small file in the user data folder.
 */
export class PortfolioService {
  readonly suites: ScenarioSuites;
  readonly quality: LiveQuality;
  readonly templates: SpaceTemplates;
  readonly reality: RealityCheck;
  readonly cards: ChatCards;
  readonly ledger: ValueLedger;
  readonly #value: PortfolioServiceOptions["value"];

  constructor(options: PortfolioServiceOptions) {
    const path = (file: string) => join(options.userDataPath, file);
    this.suites = new ScenarioSuites({ ...options.suites, path: path(SCENARIO_SUITES_FILE) });
    this.quality = new LiveQuality({ ...options.quality, path: path(LIVE_QUALITY_FILE) });
    this.templates = new SpaceTemplates({ ...options.templates, path: path(SPACE_TEMPLATES_FILE) });
    this.ledger = new ValueLedger(path(VALUE_LEDGER_FILE));
    this.reality = new RealityCheck({
      ...options.reality,
      path: path(REALITY_CHECK_FILE),
      cardsDone: (spaceId, since) => {
        const agents = new Set(
          options.value
            .agents()
            .filter((agent) => agent.spaceId === spaceId)
            .map((agent) => agent.id),
        );
        return (this.#cards ?? [])
          .filter((card) => card.at >= since && card.agentIds.some((agentId) => agents.has(agentId)))
          .map((card) => ({ key: card.key, title: card.title, agentIds: card.agentIds }));
      },
    });
    this.cards = new ChatCards({ ...options.cards, path: path(CHAT_CARDS_FILE) });
    this.#value = options.value;
  }

  /** The done cards that the reality check reads, loaded at start and after each new one. */
  #cards: { key: string; title: string; agentIds: string[]; at: string }[] | null = null;

  readonly start = Effect.fn("PortfolioService.start")(function* (this: PortfolioService) {
    this.#cards = (yield* this.ledger.snapshot()).cards;
    this.reality.start();
  });

  dispose(): void {
    this.suites.dispose();
    this.templates.dispose();
    this.reality.dispose();
  }

  /** A Motion card that reached done, for the value of its agents. */
  readonly cardDone = Effect.fn("PortfolioService.cardDone")(function* (
    this: PortfolioService,
    input: { key: string; title: string; agentIds: readonly string[]; priority?: string | null },
  ) {
    yield* this.ledger.cardDone(input);
    this.#cards = (yield* this.ledger.snapshot()).cards;
  });

  readonly value = Effect.fn("PortfolioService.value")(function* (this: PortfolioService, days: number) {
    const insight = yield* this.#value.insight(days);
    const stored = yield* this.ledger.snapshot();
    const report: ValueReport = valueReport({
      days,
      now: Date.now(),
      costs: insight?.costs ?? [],
      money: insight?.money ?? [],
      agents: this.#value.agents(),
      spaces: this.#value.spaces(),
      cards: stored.cards,
      ratings: stored.ratings,
    });
    return report;
  });

  /**
   * Rehearses a learning item that changes an agent's instructions, playbook or skill before it
   * applies. An agent without a suite, or a suite whose gate is off, applies it at once.
   */
  readonly vetLearning = Effect.fn("PortfolioService.vetLearning")(function* (
    this: PortfolioService,
    item: LearningReviewItem,
  ) {
    const apply: LearningVerdict = { outcome: "apply", note: null };
    const change = learningChange(item);
    if (!item.agentId || !change) return apply;
    const suite = yield* this.suites.suite(item.agentId);
    if (!suite || suite.gate === "off" || suite.scenarios.length === 0) return apply;
    // The owner waits for the answer of the accept: a slow rehearsal lets the change apply with a note.
    const run = yield* this.suites
      .run(item.agentId, "learning", item.title, null, change)
      .pipe(Effect.timeoutOption(VET_TIMEOUT_MS), Effect.map(Option.getOrUndefined));
    if (run === undefined)
      return {
        outcome: "warn",
        note: "The test suite did not finish in time; check its result in Portfolio.",
      } satisfies LearningVerdict;
    if (run?.status !== "done") return apply;
    if (run.passed && !run.regression) return apply;
    const failed = run.results.filter((result) => !result.pass).map((result) => result.name);
    const note = `The agent's test suite fails with this change (${Math.round(run.passRate * 100)}% passed${
      failed.length ? `; failed: ${failed.slice(0, 5).join(", ")}` : ""
    }).`;
    return { outcome: suite.gate === "block" ? "block" : "warn", note } satisfies LearningVerdict;
  });

  readonly forgetAgent = Effect.fn("PortfolioService.forgetAgent")(function* (this: PortfolioService, agentId: string) {
    yield* this.suites.forgetAgent(agentId);
    yield* this.quality.forgetAgent(agentId);
    yield* this.cards.forgetAgent(agentId);
  });
}
