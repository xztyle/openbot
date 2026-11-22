import { randomUUID } from "node:crypto";
import {
  type AgentSuite,
  PORTFOLIO_LIMITS,
  parseSuiteScenario,
  type SaveSuiteInput,
  type ScenarioResult,
  SUITE_GATES,
  SUITE_TRIGGERS,
  type SuiteDiffLine,
  type SuiteRun,
  type SuiteScenario,
  type SuiteTranscriptLine,
  type SuiteTrigger,
} from "@openbot/contracts/portfolio";
import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Schema } from "effect";
import { JsonStore } from "../agent-efficiency/json-store";
import { extractJsonObject } from "../structured-output";
import {
  CustomerReply,
  customerPrompt,
  DraftedScenarios,
  draftScenariosPrompt,
  JudgeVerdict,
  judgePrompt,
  type SandboxProfile,
  SandboxReply,
  sandboxAgentPrompt,
} from "./portfolio-prompts";

const logger = createOpenBotLogger("portfolio-suites");

export const SCENARIO_SUITES_FILE = "portfolio-suites-v1.json";
/** A change of settings waits this long, so that several edits in a row run the suite once. */
const SETTINGS_DEBOUNCE_MS = 3 * 60_000;
/** The automatic runs of one agent in a day: the owner's own runs do not count. */
const AUTO_RUNS_PER_DAY = 6;
/** A pass needs the judge's pass, no broken rule and at least this score. */
const PASS_SCORE = 6;

/** What the suites need of the host. */
export interface ScenarioSuitesHooks {
  path: string;
  /** The agent's instructions, role playbooks and skills, or null when the agent is gone. */
  profile(agentId: string): Effect.Effect<SandboxProfile | null>;
  /** Runs a prompt on the agent's own model with no tools. Null when no model can run it. */
  generateAgent(agentId: string, prompt: string): Effect.Effect<string | null>;
  /** Runs a prompt on the agent's small model with no tools. */
  generateSmall(agentId: string, prompt: string): Effect.Effect<string | null>;
  /** Tells the readers that a run ended. */
  changed?(agentId: string): void;
}

interface StoredSuites {
  version: 1;
  suites: AgentSuite[];
  runs: SuiteRun[];
  /** The automatic runs of each agent on one UTC day. */
  auto: { date: string; counts: Record<string, number> };
}

const EMPTY: StoredSuites = { version: 1, suites: [], runs: [], auto: { date: "", counts: {} } };

function decodeSuite(value: unknown): AgentSuite | null {
  if (!isDynamicRecord(value) || !isString(value.agentId) || !Array.isArray(value.scenarios)) return null;
  const scenarios: SuiteScenario[] = [];
  for (const entry of value.scenarios) {
    try {
      scenarios.push(parseSuiteScenario(entry));
    } catch {
      // A scenario that this build cannot read is left out.
    }
  }
  return {
    agentId: value.agentId,
    scenarios,
    autoRun: value.autoRun !== false,
    gate: isOneOf(SUITE_GATES, value.gate) ? value.gate : "warn",
    trials: typeof value.trials === "number" ? Math.min(Math.max(Math.round(value.trials), 1), 3) : 1,
    passMark: typeof value.passMark === "number" ? Math.min(Math.max(value.passMark, 0), 1) : 0.8,
    updatedAt: isString(value.updatedAt) ? value.updatedAt : new Date(0).toISOString(),
  };
}

function isRun(value: unknown): value is SuiteRun {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.agentId) &&
    isString(value.at) &&
    isOneOf(SUITE_TRIGGERS, value.trigger) &&
    Array.isArray(value.results) &&
    Array.isArray(value.diff) &&
    typeof value.passRate === "number"
  );
}

function decodeStored(value: unknown): StoredSuites | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  const auto = isDynamicRecord(value.auto) ? value.auto : {};
  return {
    version: 1,
    suites: Array.isArray(value.suites) ? value.suites.flatMap((entry) => decodeSuite(entry) ?? []) : [],
    runs: Array.isArray(value.runs) ? value.runs.filter(isRun) : [],
    auto: {
      date: isString(auto.date) ? auto.date : "",
      counts: isDynamicRecord(auto.counts)
        ? Object.fromEntries(
            Object.entries(auto.counts).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
          )
        : {},
    },
  };
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function decode<A>(schema: Schema.Codec<A, unknown>, text: string | null): Effect.Effect<A | null> {
  if (text === null) return Effect.succeed(null);
  return Effect.try(() => extractJsonObject(text)).pipe(
    Effect.flatMap((json) => Schema.decodeUnknownEffect(schema)(json)),
    Effect.orElseSucceed(() => null),
  );
}

/** The scenarios whose result is new or changed against the run before. */
export function suiteDiff(before: SuiteRun | undefined, results: readonly ScenarioResult[]): SuiteDiffLine[] {
  const old = new Map((before?.results ?? []).map((result) => [result.scenarioId, result.pass]));
  return results
    .filter((result) => old.get(result.scenarioId) !== result.pass)
    .map((result) => ({
      scenarioId: result.scenarioId,
      name: result.name,
      before: old.get(result.scenarioId) ?? null,
      after: result.pass,
    }));
}

/** What one learning change adds to the profile, for a run of the suite before it applies. */
export type ProfileChange =
  | { kind: "instructions"; text: string }
  | { kind: "playbook"; slug: string; text: string }
  | { kind: "skill"; name: string; text: string };

export function withChange(profile: SandboxProfile, change: ProfileChange): SandboxProfile {
  switch (change.kind) {
    case "instructions":
      return { ...profile, instructions: `${profile.instructions.trimEnd()}\n\n${change.text}` };
    case "playbook": {
      const found = profile.playbooks.some((playbook) => playbook.slug === change.slug);
      return {
        ...profile,
        playbooks: found
          ? profile.playbooks.map((playbook) =>
              playbook.slug === change.slug
                ? { ...playbook, content: `${playbook.content.trimEnd()}\n- ${change.text}` }
                : playbook,
            )
          : [...profile.playbooks, { slug: change.slug, content: `## Lessons\n- ${change.text}` }],
      };
    }
    case "skill":
      return {
        ...profile,
        skills: profile.skills.some((skill) => skill.name === change.name)
          ? profile.skills.map((skill) =>
              skill.name === change.name
                ? { ...skill, instructions: `${skill.instructions.trimEnd()}\n- ${change.text}` }
                : skill,
            )
          : [...profile.skills, { name: change.name, instructions: change.text }],
      };
  }
}

/**
 * The test suite of each agent: scenarios with a simulated customer, the agent's answers from its own
 * model with no tools (so a rehearsal sends, pays and writes nothing), and a judge on the small model
 * that scores each conversation against its rubric. A scenario passes only when each of its runs
 * passes (pass^k). A change of the agent's settings runs the suite again after a short wait, and each
 * run keeps the scenarios whose result changed since the run before.
 */
export class ScenarioSuites {
  readonly #hooks: ScenarioSuitesHooks;
  readonly #store: JsonStore<StoredSuites>;
  readonly #timers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; labels: Set<string>; checkpointId: string }
  >();
  /** One run at a time on the host: each costs model calls. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(hooks: ScenarioSuitesHooks) {
    this.#hooks = hooks;
    this.#store = new JsonStore(hooks.path, EMPTY, decodeStored);
  }

  dispose(): void {
    for (const entry of this.#timers.values()) clearTimeout(entry.timer);
    this.#timers.clear();
  }

  readonly page = Effect.fn("ScenarioSuites.page")(function* (this: ScenarioSuites, agentId: string) {
    const stored = yield* this.#store.load();
    return {
      suite: stored.suites.find((suite) => suite.agentId === agentId) ?? null,
      runs: stored.runs.filter((run) => run.agentId === agentId).slice(0, PORTFOLIO_LIMITS.runs),
    };
  });

  readonly suite = Effect.fn("ScenarioSuites.suite")(function* (this: ScenarioSuites, agentId: string) {
    return (yield* this.#store.load()).suites.find((suite) => suite.agentId === agentId) ?? null;
  });

  readonly save = Effect.fn("ScenarioSuites.save")(function* (this: ScenarioSuites, input: SaveSuiteInput) {
    const suite: AgentSuite = { ...input, updatedAt: new Date().toISOString() };
    yield* this.#store.update((stored) => ({
      ...stored,
      suites: [suite, ...stored.suites.filter((entry) => entry.agentId !== input.agentId)],
    }));
    return yield* this.page(input.agentId);
  });

  readonly forgetAgent = Effect.fn("ScenarioSuites.forgetAgent")(function* (this: ScenarioSuites, agentId: string) {
    const entry = this.#timers.get(agentId);
    if (entry) clearTimeout(entry.timer);
    this.#timers.delete(agentId);
    yield* this.#store.update((stored) => ({
      ...stored,
      suites: stored.suites.filter((suite) => suite.agentId !== agentId),
      runs: stored.runs.filter((run) => run.agentId !== agentId),
    }));
  });

  /** Scenarios that the small model writes from the agent's instructions. Nothing is saved. */
  readonly draft = Effect.fn("ScenarioSuites.draft")(function* (this: ScenarioSuites, agentId: string) {
    const profile = yield* this.#hooks.profile(agentId);
    if (!profile) return [];
    const answer = yield* decode(
      DraftedScenarios,
      yield* this.#hooks.generateSmall(agentId, draftScenariosPrompt(profile)),
    );
    const scenarios: SuiteScenario[] = [];
    for (const [index, entry] of (answer?.scenarios ?? []).entries()) {
      try {
        scenarios.push(
          parseSuiteScenario({
            ...entry,
            id: `s${index + 1}`,
            turns: Math.min(Math.max(Math.round(entry.turns ?? 1), 1), 3),
          }),
        );
      } catch {
        // A drafted scenario with an empty field is left out.
      }
    }
    return scenarios;
  });

  /**
   * A change of the agent's settings: the suite runs once after `SETTINGS_DEBOUNCE_MS` without another
   * change, when it runs by itself and the agent has runs left today.
   */
  settingsChanged(agentId: string, checkpointId: string, fields: readonly string[]): void {
    const suite = this.#store.current.suites.find((entry) => entry.agentId === agentId);
    if (!suite?.autoRun || suite.scenarios.length === 0) return;
    const followed = fields.filter((field) =>
      [
        "instructions",
        "model",
        "provider",
        "reasoningEffort",
        "modelPolicy",
        "playbookRole",
        "skill",
        "playbook",
      ].includes(field),
    );
    if (followed.length === 0) return;
    const previous = this.#timers.get(agentId);
    if (previous) clearTimeout(previous.timer);
    const labels = new Set([...(previous?.labels ?? []), ...followed]);
    const timer = setTimeout(() => {
      this.#timers.delete(agentId);
      void Effect.runPromise(
        this.#autoAllowed(agentId).pipe(
          Effect.flatMap((allowed) =>
            allowed
              ? this.run(agentId, "settings", [...labels].join(", "), checkpointId).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.catchCause((cause) => Effect.sync(() => logger.warn("A suite run after a change failed.", { cause }))),
        ),
      );
    }, SETTINGS_DEBOUNCE_MS);
    timer.unref?.();
    this.#timers.set(agentId, { timer, labels, checkpointId });
  }

  readonly #autoAllowed = Effect.fn("ScenarioSuites.autoAllowed")(function* (this: ScenarioSuites, agentId: string) {
    const today = new Date().toISOString().slice(0, 10);
    let allowed = false;
    yield* this.#store.update((stored) => {
      const counts = stored.auto.date === today ? stored.auto.counts : {};
      const used = counts[agentId] ?? 0;
      allowed = used < AUTO_RUNS_PER_DAY;
      return allowed ? { ...stored, auto: { date: today, counts: { ...counts, [agentId]: used + 1 } } } : stored;
    });
    return allowed;
  });

  /**
   * Runs the agent's suite now and keeps the run. With `change`, the agent's profile has that change
   * first, for a learning item that has not applied yet. Null when the agent has no suite.
   */
  run(
    agentId: string,
    trigger: SuiteTrigger,
    label: string,
    checkpointId: string | null = null,
    change?: ProfileChange,
  ): Effect.Effect<SuiteRun | null> {
    const task = this.#queue.then(() => Effect.runPromise(this.#run(agentId, trigger, label, checkpointId, change)));
    this.#queue = task.catch(() => undefined);
    return Effect.promise(() => task);
  }

  readonly #run = Effect.fn("ScenarioSuites.runNow")(function* (
    this: ScenarioSuites,
    agentId: string,
    trigger: SuiteTrigger,
    label: string,
    checkpointId: string | null,
    change: ProfileChange | undefined,
  ) {
    const stored = yield* this.#store.load();
    const suite = stored.suites.find((entry) => entry.agentId === agentId);
    if (!suite || suite.scenarios.length === 0) return null;
    const base = yield* this.#hooks.profile(agentId);
    // A rehearsal of a learning change that has not applied is not the agent's state.
    const before = stored.runs.find(
      (entry) => entry.agentId === agentId && entry.status === "done" && entry.trigger !== "learning",
    );
    const run: SuiteRun = {
      id: randomUUID(),
      agentId,
      at: new Date().toISOString(),
      trigger,
      label: cut(label, 400),
      checkpointId,
      status: "done",
      passRate: 0,
      passed: false,
      results: [],
      diff: [],
      regression: false,
    };
    if (!base) return { ...run, status: "failed" as const, error: "The agent does not exist any more." };
    const profile = change ? withChange(base, change) : base;
    for (const scenario of suite.scenarios) {
      const result = yield* this.#scenario(agentId, profile, scenario, suite.trials);
      if (!result) {
        run.status = "failed";
        run.error = "No model could run the rehearsal. Check that the agent's provider is signed in.";
        break;
      }
      run.results.push(result);
    }
    const passes = run.results.filter((result) => result.pass).length;
    run.passRate = run.results.length ? Math.round((passes / suite.scenarios.length) * 1000) / 1000 : 0;
    run.passed = run.status === "done" && run.passRate >= suite.passMark;
    run.diff = suiteDiff(before, run.results);
    run.regression = run.diff.some((line) => line.before === true && !line.after);
    yield* this.#store.update((current) => {
      const mine = [run, ...current.runs.filter((entry) => entry.agentId === agentId)].slice(0, PORTFOLIO_LIMITS.runs);
      return { ...current, runs: [...mine, ...current.runs.filter((entry) => entry.agentId !== agentId)] };
    });
    this.#hooks.changed?.(agentId);
    return run;
  });

  /** One scenario `trials` times. The worst run is the result. Null when no model answered at all. */
  readonly #scenario = Effect.fn("ScenarioSuites.scenario")(function* (
    this: ScenarioSuites,
    agentId: string,
    profile: SandboxProfile,
    scenario: SuiteScenario,
    trials: number,
  ) {
    let worst: ScenarioResult | null = null;
    let passes = 0;
    for (let trial = 0; trial < trials; trial += 1) {
      const transcript: SuiteTranscriptLine[] = [{ from: "customer", text: scenario.input }];
      const tools = new Set<string>();
      for (let turn = 0; turn < scenario.turns; turn += 1) {
        const text = yield* this.#hooks.generateAgent(agentId, sandboxAgentPrompt(profile, transcript));
        if (text === null) return null;
        const reply = yield* decode(SandboxReply, text);
        // An agent that answered in prose instead of JSON still answered.
        transcript.push({ from: "agent", text: cut(reply?.reply ?? text.trim(), PORTFOLIO_LIMITS.transcript) });
        for (const tool of reply?.tools ?? []) if (tool.trim()) tools.add(cut(tool.trim(), 80));
        if (turn === scenario.turns - 1) break;
        const next = yield* decode(
          CustomerReply,
          yield* this.#hooks.generateSmall(agentId, customerPrompt(scenario, transcript)),
        );
        if (!next?.message) break;
        transcript.push({ from: "customer", text: cut(next.message, PORTFOLIO_LIMITS.transcript) });
      }
      const verdict = yield* decode(
        JudgeVerdict,
        yield* this.#hooks.generateSmall(agentId, judgePrompt(scenario, transcript, [...tools])),
      );
      // An answer that the judge's reply does not hold counts as a fail.
      const score = verdict ? Math.round(verdict.score * 10) / 10 : 0;
      const pass = verdict !== null && verdict.broke !== true && verdict.pass && score >= PASS_SCORE;
      if (pass) passes += 1;
      const result: ScenarioResult = {
        scenarioId: scenario.id,
        name: scenario.name,
        pass,
        score,
        passes: 0,
        trials,
        note: cut(verdict?.reasons ?? "The judge gave no readable verdict.", PORTFOLIO_LIMITS.note),
        transcript: transcript.slice(0, 20),
        tools: [...tools].slice(0, 20),
      };
      if (!worst || (!result.pass && worst.pass) || (result.pass === worst.pass && result.score < worst.score))
        worst = result;
    }
    return worst ? { ...worst, pass: passes === trials, passes } : null;
  });
}
