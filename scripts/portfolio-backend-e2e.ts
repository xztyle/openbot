// Drives the portfolio service of the host on real files with a scripted model: a test suite run with
// its judge, the regression diff after a change and the gate of a learning item, the sampled live score
// and its weekly fall, the interactive cards of each type with their answers, a starter template's
// import with its validation stage and building, the export of a space with its scrub, the value
// report, the weekly reality check with checked links and files, and the wire codecs of portfolio-v1.
//
// `bun scripts/portfolio-backend-e2e.ts`
// Writes report.json to .openbot-build/portfolio-backend-e2e.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LearningReviewItem } from "@openbot/contracts/agent-learning";
import {
  type ChatCard,
  type ChatCardSpec,
  chatCardAnswerText,
  parseChatCardAnswer,
  parseChatCardSpec,
  parseSpaceTemplate,
  type SuiteScenario,
  type TemplateAgent,
} from "@openbot/contracts/portfolio";
import { PORTFOLIO_CODECS, PORTFOLIO_ROUTES } from "@openbot/contracts/team-protocol/portfolio-v1";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { cardMessageText } from "../src/backend/portfolio/chat-cards";
import { agentQuality } from "../src/backend/portfolio/live-quality";
import type { SandboxProfile } from "../src/backend/portfolio/portfolio-prompts";
import { PortfolioService, type PortfolioServiceOptions } from "../src/backend/portfolio/portfolio-service";
import { localWeek, locate, messageClaims, privateHost } from "../src/backend/portfolio/reality-check";
import { suiteDiff, withChange } from "../src/backend/portfolio/scenario-suites";
import { scrub } from "../src/backend/portfolio/space-templates";
import { STARTER_TEMPLATES } from "../src/backend/portfolio/starter-templates";
import { valueReport } from "../src/backend/portfolio/value-ledger";

const logger = createOpenBotLogger("portfolio-backend-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/portfolio-backend-e2e");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const report: { steps: { name: string; passed: boolean; detail?: string }[]; passed: boolean } = {
  steps: [],
  passed: false,
};

function folder(): string {
  return mkdtempSync(join(OUT, "data-"));
}

async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    report.steps.push({ name, passed: true });
  } catch (error) {
    report.steps.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const PROFILE: SandboxProfile = {
  name: "Ana",
  title: "Customer care",
  instructions: "Answer customers of the cake shop. Never promise a refund: ask the manager.",
  playbooks: [{ slug: "customer-support", content: "Greet by name." }],
  skills: [],
};

const SCENARIOS: SuiteScenario[] = [
  {
    id: "late",
    name: "Late cake",
    persona: "An angry buyer whose cake came late.",
    input: "My cake was two hours late!",
    rubric: "Apologise, ask for the order, hand it to the manager.",
    mustNot: "Promise a refund.",
    turns: 2,
  },
  {
    id: "hours",
    name: "Opening hours",
    persona: "A polite person who asks when the shop opens.",
    input: "When do you open on Sunday?",
    rubric: "Give the hours from the instructions or say they are not known.",
    turns: 1,
  },
];

/** A scripted model: the agent's answer, the customer's next line and the judge's verdict by prompt. */
function scriptedModel(state: { failLate: boolean; calls: string[] }) {
  return (_agentId: string, prompt: string) =>
    Effect.sync(() => {
      if (prompt.startsWith("You are Ana")) {
        state.calls.push("agent");
        return JSON.stringify({
          reply: "Sorry! Can you give me the order number? I'll pass it to the manager.",
          tools: ["send_message"],
        });
      }
      if (prompt.startsWith("You play a customer")) {
        state.calls.push("customer");
        return JSON.stringify({ message: "It is 1234. I want my money back." });
      }
      if (prompt.startsWith("You judge")) {
        state.calls.push("judge");
        const late = prompt.includes("Late cake") || prompt.includes("two hours late");
        return JSON.stringify(
          late && state.failLate
            ? { score: 3, pass: false, broke: true, reasons: "It promised a refund." }
            : { score: 9, pass: true, broke: false, reasons: "Kind and correct." },
        );
      }
      if (prompt.startsWith("You review one real answer")) return JSON.stringify({ score: 4, note: "Too long." });
      if (prompt.startsWith("Write a test suite"))
        return JSON.stringify({
          scenarios: [
            {
              name: "Refund ask",
              persona: "A student who wants a refund.",
              input: "Refund me",
              rubric: "Ask the manager.",
              turns: 2,
            },
          ],
        });
      return null;
    });
}

interface Fixture {
  options: PortfolioServiceOptions;
  sent: { agentId: string; text: string }[];
  notices: string[];
  routines: { agentId: string; routineId: string; active: boolean }[];
  created: { spaceId: string; agent: TemplateAgent; id: string }[];
  state: { failLate: boolean; calls: string[] };
  delivered: string[];
  failDelivery: { value: boolean };
}

function fixture(data: string): Fixture {
  const sent: Fixture["sent"] = [];
  const notices: string[] = [];
  const routines: Fixture["routines"] = [];
  const created: Fixture["created"] = [];
  const delivered: string[] = [];
  const failDelivery = { value: false };
  const calls: string[] = [];
  const state = { failLate: false, calls };
  const model = scriptedModel(state);
  const options: PortfolioServiceOptions = {
    userDataPath: data,
    suites: {
      profile: (agentId) => Effect.succeed(agentId === "ana" ? PROFILE : null),
      generateAgent: model,
      generateSmall: model,
    },
    quality: {
      profile: () => Effect.succeed(PROFILE),
      generateSmall: model,
      redact: (text) => text,
      random: () => 0,
    },
    templates: {
      space: (spaceId) => (spaceId === "shop" ? { id: "shop", name: "Cake shop", icon: "🎂" } : null),
      agentsOf: () => [
        {
          id: "ana",
          name: "Ana",
          title: "Customer care",
          instructions: "Answer customers. Write to owner@example.com or +34 600 123 456. Key sk-test1234567890abcdef.",
          role: "customer-support",
          managerId: "max",
        },
        { id: "max", name: "Max", title: "Manager", instructions: "Run the shop.", role: null, managerId: null },
      ],
      skillsOf: (agentId) =>
        Effect.succeed(
          agentId === "ana" ? [{ name: "orders", description: "Orders", instructions: "Confirm each order." }] : [],
        ),
      routinesOf: (agentId) =>
        agentId === "max"
          ? [
              {
                name: "Monday",
                instruction: "Plan the week.",
                schedule: { kind: "weekly", weekday: 1, time: "09:00" },
              },
              { name: "Odd", instruction: "Custom.", schedule: { kind: "custom", expression: "* * * * *" } },
            ]
          : [],
      playbooks: () =>
        Effect.succeed([{ slug: "customer-support", roles: ["customer-support"], content: "Greet by name." }]),
      loopsOf: () => [
        {
          templateId: "customer-inbox",
          definition: { name: "Inbox", stages: [{ id: "new", name: "New", ownerAgentId: "ana" }], fields: [] },
        },
      ],
      channelsOf: () => [{ name: "shop", description: "Orders", agentIds: ["ana", "max"] }],
      redact: (text) => text,
      createSpace: (name) => Effect.succeed(`space-${name.length}`),
      createAgent: (spaceId, agent) =>
        Effect.sync(() => {
          const id = `agent-${agent.key}`;
          created.push({ spaceId, agent, id });
          return id;
        }),
      setManager: () => Effect.void,
      addSkill: () => Effect.succeed(true),
      createRoutine: (agentId) => {
        const routineId = `routine-${routines.length + 1}`;
        routines.push({ agentId, routineId, active: false });
        return routineId;
      },
      activateRoutine: (agentId, routineId) => {
        const routine = routines.find((entry) => entry.agentId === agentId && entry.routineId === routineId);
        if (routine) routine.active = true;
      },
      savePlaybook: () => Effect.succeed(true),
      createLoop: () => Effect.void,
      createChannel: () => Effect.void,
      send: (agentId, text) =>
        Effect.sync(() => {
          sent.push({ agentId, text });
        }),
      generate: (prompt) =>
        Effect.succeed(
          prompt.startsWith("Score this business idea")
            ? JSON.stringify({
                score: 64,
                verdict: "test",
                demand: "Some",
                competition: "Many",
                risks: "Low",
                summary: "Test first.",
              })
            : prompt.startsWith("Write the weekly reality check")
              ? JSON.stringify({ summary: "2 of 4 claims have evidence." })
              : null,
        ),
      notify: (_spaceId, text) => {
        notices.push(text);
      },
    },
    reality: {
      spaces: () => [{ id: "shop", name: "Cake shop" }],
      agents: () => [{ id: "ana", name: "Ana", workspacePath: data }],
      sharedDirectory: () => data,
      agentMessages: () => [
        {
          agentId: "ana",
          text: "The landing is live: https://shop.example.com/cakes?ref=1 for SHOP-1",
          at: new Date().toISOString(),
        },
        {
          agentId: "ana",
          text: "Report ready at shared/report.pdf and the menu at shared/missing.pdf",
          at: new Date().toISOString(),
        },
        { agentId: "ana", text: "We had 3 sales today!", at: new Date().toISOString() },
        { agentId: "ana", text: "Internal page live http://127.0.0.1:8080/admin", at: new Date().toISOString() },
      ],
      money: () => Effect.succeed({ revenue: 0, sales: 0 }),
      generate: (prompt) =>
        Effect.succeed(
          prompt.startsWith("Write the weekly reality check")
            ? JSON.stringify({ summary: "Half of it is backed." })
            : null,
        ),
      deliver: (_spaceId, _name, text) => {
        notices.push(text);
        return "briefing";
      },
      timeZone: () => "UTC",
      running: () => true,
      fetch: async (url) => url.startsWith("https://shop.example.com"),
    },
    cards: {
      deliver: (card, text) =>
        failDelivery.value
          ? Effect.fail(new Error("The agent is gone."))
          : Effect.sync(() => {
              delivered.push(`${card.agentId}: ${text}`);
            }),
    },
    value: {
      insight: () =>
        Effect.succeed({
          costs: [
            { agentId: "ana", spaceId: "shop", costUsd: 2 },
            { agentId: "max", spaceId: "shop", costUsd: 8 },
          ],
          money: [
            {
              spaceId: "shop",
              date: new Date().toISOString().slice(0, 10),
              kind: "revenue",
              amount: 100,
              currency: "USD",
            },
            {
              spaceId: "shop",
              date: new Date().toISOString().slice(0, 10),
              kind: "revenue",
              amount: 100,
              currency: "BRL",
            },
            {
              spaceId: "shop",
              date: new Date().toISOString().slice(0, 10),
              kind: "spend",
              amount: 30,
              currency: "USD",
            },
          ],
        }),
      agents: () => [
        { id: "ana", spaceId: "shop" },
        { id: "max", spaceId: "shop" },
      ],
      spaces: () => [{ id: "shop" }],
    },
  };
  return { options, sent, notices, routines, created, state, delivered, failDelivery };
}

await check("a suite run rehearses each scenario and judges it", async () => {
  const fx = fixture(folder());
  const portfolio = new PortfolioService(fx.options);
  await run(portfolio.start());
  await run(
    portfolio.suites.save({
      agentId: "ana",
      scenarios: SCENARIOS,
      autoRun: true,
      gate: "block",
      trials: 2,
      passMark: 1,
    }),
  );
  const first = await run(portfolio.suites.run("ana", "manual", "Run"));
  assert.ok(first);
  assert.equal(first.status, "done");
  assert.equal(first.passRate, 1);
  assert.equal(first.passed, true);
  assert.equal(first.results.find((result) => result.scenarioId === "late")?.passes, 2);
  assert.deepEqual(first.results.find((result) => result.scenarioId === "late")?.tools, ["send_message"]);
  assert.equal(first.results.find((result) => result.scenarioId === "late")?.transcript.length, 4);
  assert.ok(fx.state.calls.includes("customer"), "the customer answers in a 2-turn scenario");
  fx.state.failLate = true;
  const second = await run(portfolio.suites.run("ana", "settings", "instructions", "checkpoint-1"));
  assert.ok(second);
  assert.equal(second.passed, false);
  assert.equal(second.regression, true);
  assert.deepEqual(second.diff, [{ scenarioId: "late", name: "Late cake", before: true, after: false }]);
  const page = await run(portfolio.suites.page("ana"));
  assert.equal(page.runs.length, 2);
  assert.equal(page.runs[0]?.id, second.id);
  portfolio.dispose();
});

await check("a learning change that fails the suite is blocked, and passes without a gate", async () => {
  const fx = fixture(folder());
  const portfolio = new PortfolioService(fx.options);
  await run(
    portfolio.suites.save({
      agentId: "ana",
      scenarios: SCENARIOS,
      autoRun: false,
      gate: "block",
      trials: 1,
      passMark: 1,
    }),
  );
  fx.state.failLate = true;
  const item: LearningReviewItem = {
    id: "l1",
    kind: "instructions",
    source: "task",
    agentId: "ana",
    spaceId: "shop",
    title: "Offer refunds",
    note: "",
    ref: null,
    changes: [{ type: "instructions-add", text: "Offer a refund at once." }],
    risk: "review",
    state: "pending",
    createdAt: new Date().toISOString(),
  };
  const blocked = await run(portfolio.vetLearning(item));
  assert.equal(blocked.outcome, "block");
  assert.match(blocked.note ?? "", /Late cake/u);
  await run(
    portfolio.suites.save({
      agentId: "ana",
      scenarios: SCENARIOS,
      autoRun: false,
      gate: "warn",
      trials: 1,
      passMark: 1,
    }),
  );
  assert.equal((await run(portfolio.vetLearning(item))).outcome, "warn");
  await run(
    portfolio.suites.save({
      agentId: "ana",
      scenarios: SCENARIOS,
      autoRun: false,
      gate: "off",
      trials: 1,
      passMark: 1,
    }),
  );
  assert.equal((await run(portfolio.vetLearning(item))).outcome, "apply");
  const memoryItem = {
    ...item,
    kind: "memory" as const,
    changes: [{ type: "memory-forget" as const, memoryId: "m", before: "x" }],
  };
  assert.equal((await run(portfolio.vetLearning(memoryItem))).outcome, "apply");
  // The rehearsal of the change does not become the baseline of the next run.
  const page = await run(portfolio.suites.page("ana"));
  assert.equal(page.runs[0]?.trigger, "learning");
});

await check("a drafted suite reads back as scenarios", async () => {
  const fx = fixture(folder());
  const portfolio = new PortfolioService(fx.options);
  const scenarios = await run(portfolio.suites.draft("ana"));
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0]?.id, "s1");
  assert.equal(scenarios[0]?.turns, 2);
});

await check("a profile change adds a rule, a playbook lesson or a skill", () => {
  assert.match(withChange(PROFILE, { kind: "instructions", text: "Rule." }).instructions, /Rule\.$/u);
  assert.match(
    withChange(PROFILE, { kind: "playbook", slug: "customer-support", text: "Lesson" }).playbooks[0]?.content ?? "",
    /- Lesson$/u,
  );
  assert.equal(withChange(PROFILE, { kind: "skill", name: "new", text: "Do it." }).skills.length, 1);
  assert.deepEqual(suiteDiff(undefined, []), []);
});

await check("the live score samples an answer and flags a weekly fall", async () => {
  const fx = fixture(folder());
  const portfolio = new PortfolioService(fx.options);
  portfolio.quality.finished({
    agentId: "ana",
    turnId: "t1",
    asked: "Do you deliver?",
    answer: "Yes, we deliver in the city every day from 9 to 18.",
  });
  for (
    let index = 0;
    index < 50 && (await run(portfolio.quality.page(undefined, ["ana"]))).agents[0]?.recent.length === 0;
    index += 1
  )
    await new Promise((done) => setTimeout(done, 20));
  const page = await run(portfolio.quality.page({ sampleRate: 0.2 }, ["ana"]));
  assert.equal(page.settings.sampleRate, 0.2);
  assert.equal(page.agents[0]?.recent[0]?.score, 4);
  const now = Date.now();
  const day = 86_400_000;
  const quality = agentQuality(
    "ana",
    [
      { turnId: "a", at: new Date(now - day).toISOString(), score: 5, note: "" },
      { turnId: "b", at: new Date(now - 9 * day).toISOString(), score: 8, note: "" },
    ],
    now,
  );
  assert.equal(quality.average7, 5);
  assert.equal(quality.previous7, 8);
  assert.equal(quality.dropped, true);
  assert.equal(quality.trend.length, 2);
});

const SPECS = {
  choice: parseChatCardSpec({
    type: "choice",
    title: "Which name?",
    options: [
      { id: "a", label: "Aprendo" },
      { id: "b", label: "Sabio" },
    ],
  }),
  approve: parseChatCardSpec({ type: "approve", title: "Publish the post?" }),
  form: parseChatCardSpec({
    type: "form",
    title: "Shop details",
    fields: [
      { id: "hours", label: "Hours", kind: "text", required: true },
      { id: "budget", label: "Budget", kind: "number" },
      { id: "area", label: "Area", kind: "select", options: ["City", "Region"] },
    ],
  }),
  table: parseChatCardSpec({
    type: "table",
    title: "Approve these ad variants?",
    columns: ["Variant", "Hook", "Budget"],
    rows: [
      { id: "v1", cells: ["A", "Before Christmas", 5] },
      { id: "v2", cells: ["B", "Your first cake", "5 USD"] },
    ],
  }),
} satisfies Record<string, ChatCardSpec>;

await check("card specs refuse what does not fit", () => {
  assert.throws(() => parseChatCardSpec({ type: "choice", title: "One", options: [{ id: "a", label: "A" }] }));
  assert.throws(() =>
    parseChatCardSpec({ type: "table", title: "T", columns: ["A", "B"], rows: [{ id: "r", cells: ["only one"] }] }),
  );
  assert.throws(() =>
    parseChatCardSpec({
      type: "choice",
      title: "Dup",
      options: [
        { id: "a", label: "A" },
        { id: "a", label: "B" },
      ],
    }),
  );
  assert.equal(SPECS.table?.type === "table" && SPECS.table.rows[0]?.cells[2], "5");
  assert.match(cardMessageText(SPECS.table, "00000000-0000-4000-8000-000000000000"), /\[card:0{8}-/u);
});

await check("each card type takes its answer, which reaches the agent once", async () => {
  const fx = fixture(folder());
  const portfolio = new PortfolioService(fx.options);
  const cases: { spec: ChatCardSpec; answer: object; expected: RegExp }[] = [
    { spec: SPECS.choice, answer: { selected: ["b"] }, expected: /Sabio\./u },
    {
      spec: SPECS.approve,
      answer: { approved: false, note: "Not this week" },
      expected: /Rejected\. Note: Not this week/u,
    },
    {
      spec: SPECS.form,
      answer: { values: { hours: "9-18", budget: "20", area: "City" } },
      expected: /Hours: 9-18; Budget: 20; Area: City/u,
    },
    {
      spec: SPECS.table,
      answer: { rows: { v1: "approve", v2: "reject" } },
      expected: /Approved: A \(v1\)\. Rejected: B \(v2\)\./u,
    },
  ];
  for (const { spec, answer, expected } of cases) {
    const card = await run(portfolio.cards.create("ana", spec, "channel-1"));
    const answered: ChatCard = await run(portfolio.cards.answer(card.id, answer, { id: "owner", name: "Owner" }));
    assert.equal(answered.status, "answered");
    assert.match(fx.delivered.at(-1) ?? "", expected);
    await assert.rejects(run(portfolio.cards.answer(card.id, answer, { id: "owner", name: "Owner" })));
  }
  assert.equal(fx.delivered.length, 4);
  assert.throws(() => parseChatCardAnswer(SPECS.form, { values: { budget: "x" } }));
  assert.throws(() => parseChatCardAnswer(SPECS.table, { rows: { v1: "approve" } }));
  assert.match(chatCardAnswerText(SPECS.choice, { selected: ["a", "b"] }), /Aprendo, Sabio/u);
  fx.failDelivery.value = true;
  const open = await run(portfolio.cards.create("ana", SPECS.approve, null));
  await assert.rejects(run(portfolio.cards.answer(open.id, { approved: true }, { id: "owner", name: "Owner" })));
  assert.equal(
    (await run(portfolio.cards.get([open.id])))[0]?.status,
    "open",
    "a failed delivery leaves the card open",
  );
  assert.equal(await run(portfolio.cards.close("ana", open.id)), true);
  assert.equal((await run(portfolio.cards.get([open.id])))[0]?.status, "closed");
});

await check("the starter templates read back as templates", () => {
  assert.equal(STARTER_TEMPLATES.length, 3);
  for (const starter of STARTER_TEMPLATES) parseSpaceTemplate(starter.template);
  const text = JSON.stringify(STARTER_TEMPLATES);
  assert.doesNotMatch(text, /@[a-z0-9.-]+\.[a-z]{2,}/iu, "no email in a starter");
  assert.doesNotMatch(text, /aprendivo|universidad\.online|seminarios/iu, "no real brand in a starter");
});

await check("a starter import waits for its validation, then builds", async () => {
  const fx = fixture(folder());
  const portfolio = new PortfolioService(fx.options);
  const record = await run(portfolio.templates.import({ starterId: "affiliate-courses", name: "Courses" }));
  assert.equal(record.state, "validating");
  assert.equal(fx.created.length, 4);
  assert.ok(
    fx.routines.every((routine) => !routine.active),
    "routines stay paused",
  );
  assert.equal(fx.sent.length, 1, "only the research agent gets a brief");
  assert.equal(fx.sent[0]?.agentId, "agent-scout");
  await assert.rejects(run(portfolio.templates.decide("unknown", "build")));
  const reported = await run(
    portfolio.templates.report("agent-scout", {
      score: 72.4,
      verdict: "go",
      demand: "High",
      competition: "Some",
      risks: "Ad rules",
      summary: "Worth a test.",
    }),
  );
  assert.equal(reported?.state, "ready");
  assert.equal(reported?.validation?.score, 72);
  assert.equal(fx.notices.length, 1);
  assert.equal(
    await run(
      portfolio.templates.report("agent-scout", {
        score: 1,
        verdict: "stop",
        demand: "-",
        competition: "-",
        risks: "-",
        summary: "-",
      }),
    ),
    null,
  );
  const built = await run(portfolio.templates.decide(record.id, "build"));
  assert.equal(built.state, "building");
  assert.equal(fx.sent.length, 5, "each agent gets its kickoff");
  assert.match(fx.sent.at(-1)?.text ?? "", /Validation: 72\/100/u);
  assert.ok(fx.routines.length > 0 && fx.routines.every((routine) => routine.active), "routines turn on");
  await assert.rejects(run(portfolio.templates.decide(record.id, "stop")));
});

await check("a template without a research agent is scored by the host", async () => {
  const fx = fixture(folder());
  const portfolio = new PortfolioService(fx.options);
  const record = await run(portfolio.templates.import({ starterId: "local-shop" }));
  assert.equal(record.state, "ready");
  assert.equal(record.validation?.score, 64);
  assert.equal(record.validation?.agentId, null);
  assert.equal(fx.sent.length, 0);
  const stopped = await run(portfolio.templates.decide(record.id, "stop"));
  assert.equal(stopped.state, "stopped");
  assert.equal(fx.sent.length, 0);
});

await check("an export keeps the setup and drops keys, emails and phone numbers", async () => {
  const fx = fixture(folder());
  const portfolio = new PortfolioService(fx.options);
  const template = await run(portfolio.templates.export("shop"));
  const text = JSON.stringify(template);
  assert.doesNotMatch(text, /owner@example\.com|600 123 456|sk-test/u);
  assert.match(text, /\[email\]/u);
  assert.equal(template.agents.length, 2);
  assert.equal(template.agents.find((agent) => agent.name === "Ana")?.reportsTo, "max");
  assert.equal(
    template.agents.find((agent) => agent.name === "Max")?.routines.length,
    1,
    "a custom schedule is left out",
  );
  assert.equal(template.playbooks.length, 1);
  assert.equal(JSON.stringify(template.loops).includes("ownerAgentId"), false);
  assert.deepEqual(template.channels[0]?.members, ["ana", "max"]);
  parseSpaceTemplate(JSON.parse(text));
  await assert.rejects(run(portfolio.templates.export("nowhere")));
  assert.equal(
    scrub("https://a.example/x?token=1 and 4111111111111111", (value) => value),
    "https://a.example/x and [number]",
  );
});

await check("value shares revenue by weighted done cards and converts currencies", async () => {
  const fx = fixture(folder());
  const portfolio = new PortfolioService(fx.options);
  await run(portfolio.cardDone({ key: "SHOP-1", title: "Landing", agentIds: ["ana"], priority: "high" }));
  await run(portfolio.cardDone({ key: "SHOP-2", title: "Plan", agentIds: ["max"], priority: "low" }));
  await run(portfolio.ledger.rate({ spaceId: "shop", agentId: "max", title: "Good plan", rating: 5, valueUsd: 50 }));
  const value = await run(portfolio.value(30));
  const shop = value.spaces[0];
  assert.equal(shop?.revenueUsd, 118);
  assert.equal(shop?.adSpendUsd, 30);
  assert.equal(shop?.costUsd, 10);
  assert.equal(shop?.valueUsd, 168);
  assert.equal(shop?.valuePerDollar, 16.8);
  const ana = value.agents.find((agent) => agent.agentId === "ana");
  const max = value.agents.find((agent) => agent.agentId === "max");
  assert.equal(ana?.revenueUsd, 88.5);
  assert.equal(ana?.valuePerDollar, 44.25);
  assert.equal(max?.revenueUsd, 29.5);
  assert.equal(max?.valueUsd, 79.5);
  assert.equal(max?.rating, 5);
  assert.deepEqual(value.converted, ["BRL"]);
  const none = valueReport({
    days: 30,
    now: Date.now(),
    costs: [{ agentId: "x", spaceId: "s", costUsd: 4 }],
    money: [],
    agents: [{ id: "x", spaceId: "s" }],
    spaces: [{ id: "s" }],
    cards: [],
    ratings: [],
  });
  assert.equal(none.spaces[0]?.valuePerDollar, 0);
});

await check("the reality check backs claims with links, files and money", async () => {
  const data = folder();
  writeFileSync(join(data, "report.pdf"), "x");
  const fx = fixture(data);
  const portfolio = new PortfolioService(fx.options);
  await run(portfolio.cardDone({ key: "SHOP-1", title: "Landing", agentIds: ["ana"], priority: "high" }));
  await run(portfolio.start());
  const result = await run(portfolio.reality.run("shop"));
  portfolio.dispose();
  assert.ok(result);
  const byKind = (kind: string, evidence: string) =>
    result.claims.filter((claim) => claim.kind === kind && claim.evidence === evidence).length;
  assert.equal(byKind("url", "found"), 1);
  assert.equal(byKind("url", "unknown"), 1, "a private address is not fetched");
  assert.equal(byKind("file", "found"), 1);
  assert.equal(byKind("file", "missing"), 1);
  assert.equal(byKind("sale", "missing"), 1);
  assert.equal(result.claims.find((claim) => claim.kind === "card")?.evidence, "found");
  assert.equal(result.flagged, 2);
  assert.equal(result.summary, "Half of it is backed.");
  assert.match(fx.notices.at(-1) ?? "", /Half of it/u);
  assert.equal((await run(portfolio.reality.page({ spaceId: "shop" }))).reports.length, 1);
  assert.equal(await run(portfolio.reality.run("nowhere")), null);
});

await check("claims, private hosts, paths and weeks read as meant", () => {
  assert.deepEqual(messageClaims("just thinking https://x.example"), { urls: [], files: [], sale: false });
  assert.deepEqual(messageClaims("Published https://x.example/a."), {
    urls: ["https://x.example/a"],
    files: [],
    sale: false,
  });
  assert.equal(messageClaims("Ventas: 3 hoy").sale, true);
  assert.equal(privateHost("192.168.1.4"), true);
  assert.equal(privateHost("localhost"), true);
  assert.equal(privateHost("shop.example.com"), false);
  assert.equal(locate("/etc/passwd", ["/srv/space"]), null);
  assert.equal(locate("shared/a.txt", ["/srv/space"]), "/srv/space/a.txt");
  assert.equal(locate("../x", ["/srv/space"]), null);
  assert.equal(localWeek(new Date("2026-11-22T12:00:00Z"), "UTC").week, "2026-W47");
  assert.equal(localWeek(new Date("2026-11-23T12:00:00Z"), "UTC").week, "2026-W48");
  assert.equal(localWeek(new Date("2027-01-01T12:00:00Z"), "UTC").week, "2026-W53");
});

await check("the wire codecs take what the host answers", async () => {
  const fx = fixture(folder());
  const portfolio = new PortfolioService(fx.options);
  await run(
    portfolio.suites.save({
      agentId: "ana",
      scenarios: SCENARIOS,
      autoRun: true,
      gate: "warn",
      trials: 1,
      passMark: 0.5,
    }),
  );
  await run(portfolio.suites.run("ana", "manual", "Run"));
  const codec = (route: string) => {
    const found = PORTFOLIO_CODECS.get(route);
    assert.ok(found, route);
    return found;
  };
  codec(PORTFOLIO_ROUTES.suites).response(200, await run(portfolio.suites.page("ana")));
  codec(PORTFOLIO_ROUTES.quality).response(200, await run(portfolio.quality.page(undefined, ["ana"])));
  const record = await run(portfolio.templates.import({ starterId: "youtube-channel" }));
  codec(PORTFOLIO_ROUTES.importTemplate).response(200, { import: record });
  codec(PORTFOLIO_ROUTES.templates).response(200, { starters: portfolio.templates.starters(), imports: [record] });
  codec(PORTFOLIO_ROUTES.exportTemplate).response(200, { template: await run(portfolio.templates.export("shop")) });
  codec(PORTFOLIO_ROUTES.importTemplate).request({ template: STARTER_TEMPLATES[0]?.template, name: "X" });
  codec(PORTFOLIO_ROUTES.value).response(200, await run(portfolio.value(30)));
  const card = await run(portfolio.cards.create("ana", SPECS.table, null));
  const answered = await run(
    portfolio.cards.answer(card.id, { rows: { v1: "approve", v2: "approve" } }, { id: "o", name: "O" }),
  );
  codec(PORTFOLIO_ROUTES.cards).response(200, { cards: [answered] });
  codec(PORTFOLIO_ROUTES.answerCard).request({ cardId: card.id, answer: { rows: { v1: "approve" } } });
  codec(PORTFOLIO_ROUTES.saveSuite).request({
    agentId: "ana",
    scenarios: SCENARIOS,
    autoRun: true,
    gate: "warn",
    trials: 1,
    passMark: 0.5,
  });
  assert.throws(() => codec(PORTFOLIO_ROUTES.saveSuite).request({ agentId: "ana", scenarios: [{ id: "BAD ID" }] }));
});

report.passed = report.steps.length > 0 && report.steps.every((step) => step.passed);
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const step of report.steps)
  logger.info(`${step.passed ? "ok  " : "FAIL"} ${step.name}${step.detail ? `\n     ${step.detail}` : ""}`);
logger.info(`${report.passed ? "Passed" : "Failed"}. Report: ${resolve(OUT, "report.json")}`);
process.exit(report.passed ? 0 : 1);
