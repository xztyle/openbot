// Optional portfolio-v1 contract of this fork, under `fork-host-v1`. Owners and admins only.
//
// What it adds, recorded here because freezing it makes it permanent. Every route is POST and answers
// JSON; a refusal of the request itself answers 409 with `{ error }`. The shapes are the types of
// `portfolio.ts`.
//
// Test suites (`AgentSuite`, `SuiteRun`): simulated customers for one agent, run on the agent's own
// model with no tools (nothing is sent, paid or written), scored by a judge on the small model.
// - `/v1/workspace/portfolio/suites` `{ agentId }` answers `{ suite (null), runs (at most 20, newest first) }`.
// - `/suites/save` `{ agentId, scenarios (20), autoRun, gate: "off" | "warn" | "block", trials (1-3),
//   passMark (0-1) }` answers the same.
// - `/suites/run` `{ agentId }` runs the suite now and answers `{ run }`.
// - `/suites/draft` `{ agentId }` answers `{ scenarios }`: scenarios that the small model writes from
//   the agent's instructions, which the client saves or edits.
// - `/quality` `{ settings?: { enabled?, sampleRate? (0-0.5) } }` answers `{ settings, agents }`: the
//   sampled live score of each agent, with a 30-day trend.
//
// Space templates (`SpaceTemplate`, `TemplateImport`): a space's agents, roles, instructions, skills,
// playbooks, loops, routines and channels, without memories, chats, keys or customer data.
// - `/templates` `{}` answers `{ starters, imports }`: the starter templates and the last imports.
// - `/templates/export` `{ spaceId }` answers `{ template }`.
// - `/templates/import` `{ starterId? | template?, name?, skipValidation? }` makes the space and answers
//   `{ import }`. Its agents wait until the validation stage ends and the owner starts the building.
// - `/templates/decide` `{ importId, decision: "build" | "stop" }` answers `{ import }`.
//
// Value (`ValueReport`): `/value` `{ days? (7-90) }` answers the value and the cost of each space and
// agent. `/value/rate` `{ spaceId, agentId?, title, ref?, rating (1-5), valueUsd? }` answers the report.
//
// Reality check (`RealityPage`): `/reality` `{ spaceId?, settings?: { enabled?, weekday?, hour? } }`
// answers `{ settings, reports (at most 50, newest first) }`. `/reality/run` `{ spaceId }` checks the
// space now and answers `{ report }`.
//
// Interactive cards (`ChatCard`): a chat message that ends with `[card:<id>]` carries a card.
// - `/cards` `{ cardIds (50) }` answers `{ cards }`; an unknown id is left out.
// - `/cards/answer` `{ cardId, answer }` answers `{ card }`; the agent gets the answer as a message.
//
// A fork host built before these routes answers 404, so a client hides what needs them.
import { parseChatCardSpec, parseSaveSuiteInput, parseSpaceTemplate, parseSuiteScenario } from "../portfolio";
import { isDynamicRecord } from "../runtime-values";
import {
  type AdminDecoder,
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { decodeTeamProtocolV2Json } from "./v2";

export const PORTFOLIO_ROUTES = {
  suites: "/v1/workspace/portfolio/suites",
  saveSuite: "/v1/workspace/portfolio/suites/save",
  runSuite: "/v1/workspace/portfolio/suites/run",
  draftSuite: "/v1/workspace/portfolio/suites/draft",
  quality: "/v1/workspace/portfolio/quality",
  templates: "/v1/workspace/portfolio/templates",
  exportTemplate: "/v1/workspace/portfolio/templates/export",
  importTemplate: "/v1/workspace/portfolio/templates/import",
  decideImport: "/v1/workspace/portfolio/templates/decide",
  value: "/v1/workspace/portfolio/value",
  rate: "/v1/workspace/portfolio/value/rate",
  reality: "/v1/workspace/portfolio/reality",
  runReality: "/v1/workspace/portfolio/reality/run",
  cards: "/v1/workspace/portfolio/cards",
  answerCard: "/v1/workspace/portfolio/cards/answer",
} as const;

const number =
  (minimum: number, maximum: number): AdminDecoder =>
  (value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
      throw new Error("Invalid portfolio number.");
    return value;
  };
const money = number(-1e12, 1e12);
const share = number(0, 1);
const time = string(80);
const text = (maximum: number) => string(maximum);
/** A value that a contract parser of `portfolio.ts` checks whole. */
const parsed =
  (parse: (value: unknown) => unknown): AdminDecoder =>
  (value) => {
    parse(value);
    return decodeTeamProtocolV2Json(value);
  };
const record =
  (decode: AdminDecoder, maximum: number): AdminDecoder =>
  (value) => {
    if (!isDynamicRecord(value) || Object.keys(value).length > maximum) throw new Error("Invalid portfolio record.");
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [String(identifier(key)), decode(entry)]));
  };

const scenario = parsed(parseSuiteScenario);
const suite = fields({
  agentId: identifier,
  scenarios: list(scenario, 20),
  autoRun: boolean,
  gate: oneOf("off", "warn", "block"),
  trials: count,
  passMark: share,
  updatedAt: time,
});
const run = fields(
  {
    id: identifier,
    agentId: identifier,
    at: time,
    trigger: oneOf("manual", "settings", "learning"),
    label: text(400),
    checkpointId: nullable(identifier),
    status: oneOf("running", "done", "failed"),
    passRate: share,
    passed: boolean,
    results: list(
      fields({
        scenarioId: identifier,
        name: text(120),
        pass: boolean,
        score: number(0, 10),
        passes: count,
        trials: count,
        note: text(600),
        transcript: list(fields({ from: oneOf("customer", "agent"), text: text(1_500) }), 20),
        tools: list(text(80), 20),
      }),
      20,
    ),
    diff: list(fields({ scenarioId: identifier, name: text(120), before: nullable(boolean), after: boolean }), 20),
    regression: boolean,
  },
  { error: text(600) },
);
const suitePage = fields({ suite: nullable(suite), runs: list(run, 20) });
const qualitySettings = fields({ enabled: boolean, sampleRate: number(0, 0.5) });
const quality = fields({
  settings: qualitySettings,
  agents: list(
    fields({
      agentId: identifier,
      average7: nullable(number(0, 10)),
      previous7: nullable(number(0, 10)),
      dropped: boolean,
      trend: list(fields({ date: string(10), average: number(0, 10), count }), 30),
      recent: list(fields({ turnId: identifier, at: time, score: number(0, 10), note: text(600) }), 20),
    }),
    1_000,
  ),
});

const validation = fields({
  score: number(0, 100),
  verdict: oneOf("go", "test", "stop"),
  demand: text(800),
  competition: text(800),
  risks: text(800),
  summary: text(1_200),
  at: time,
  agentId: nullable(identifier),
});
const templateImport = fields({
  id: identifier,
  templateName: text(60),
  spaceId: identifier,
  state: oneOf("validating", "ready", "building", "stopped"),
  validation: nullable(validation),
  agents: record(identifier, 20),
  researcherId: nullable(identifier),
  notes: list(text(400), 40),
  createdAt: time,
});
const starter = fields({
  id: identifier,
  name: text(60),
  description: text(600),
  icon: nullable(text(32)),
  agents: count,
});
const template = parsed(parseSpaceTemplate);

const valueReport = fields({
  days: count,
  spaces: list(
    fields({
      spaceId: identifier,
      revenueUsd: money,
      adSpendUsd: money,
      cardsDone: count,
      ratedUsd: money,
      valueUsd: money,
      costUsd: money,
      valuePerDollar: nullable(money),
    }),
    500,
  ),
  agents: list(
    fields({
      agentId: identifier,
      spaceId: identifier,
      revenueUsd: money,
      cardsDone: count,
      cardPoints: count,
      ratedUsd: money,
      rating: nullable(number(1, 5)),
      valueUsd: money,
      costUsd: money,
      valuePerDollar: nullable(money),
    }),
    1_000,
  ),
  ratings: list(
    fields({
      id: identifier,
      spaceId: identifier,
      agentId: nullable(identifier),
      title: text(200),
      ref: nullable(text(200)),
      rating: number(1, 5),
      valueUsd: nullable(money),
      at: time,
    }),
    2_000,
  ),
  converted: list(string(8), 20),
});

const realitySettings = fields({ enabled: boolean, weekday: number(0, 6), hour: number(0, 23) });
const realityReport = fields({
  id: identifier,
  spaceId: identifier,
  at: time,
  summary: text(2_000),
  claims: list(
    fields({
      kind: oneOf("card", "url", "file", "sale"),
      text: text(400),
      agentId: nullable(identifier),
      evidence: oneOf("found", "missing", "unknown"),
      detail: text(400),
    }),
    40,
  ),
  flagged: count,
  channelId: nullable(identifier),
});

const card = fields(
  {
    id: identifier,
    agentId: identifier,
    channelId: nullable(identifier),
    spec: parsed(parseChatCardSpec),
    status: oneOf("open", "answered", "closed"),
    createdAt: time,
  },
  {
    answer: fields(
      {},
      {
        selected: list(text(64), 20),
        approved: boolean,
        values: record(text(1_000), 8),
        rows: record(oneOf("approve", "reject"), 20),
        note: text(600),
      },
    ),
    answeredBy: fields({ id: identifier, name: text(200) }),
    answeredAt: time,
  },
);

const agentInput = fields({ agentId: identifier });

export const PORTFOLIO_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [PORTFOLIO_ROUTES.suites, adminRoute(agentInput, suitePage)],
  [PORTFOLIO_ROUTES.saveSuite, adminRoute(parsed(parseSaveSuiteInput), suitePage)],
  [PORTFOLIO_ROUTES.runSuite, adminRoute(agentInput, fields({ run }))],
  [PORTFOLIO_ROUTES.draftSuite, adminRoute(agentInput, fields({ scenarios: list(scenario, 20) }))],
  [
    PORTFOLIO_ROUTES.quality,
    adminRoute(fields({}, { settings: fields({}, { enabled: boolean, sampleRate: number(0, 0.5) }) }), quality),
  ],
  [
    PORTFOLIO_ROUTES.templates,
    adminRoute(empty, fields({ starters: list(starter, 20), imports: list(templateImport, 50) })),
  ],
  [PORTFOLIO_ROUTES.exportTemplate, adminRoute(fields({ spaceId: identifier }), fields({ template }))],
  [
    PORTFOLIO_ROUTES.importTemplate,
    adminRoute(
      fields({}, { starterId: string(40), template, name: text(60), skipValidation: boolean }),
      fields({ import: templateImport }),
    ),
  ],
  [
    PORTFOLIO_ROUTES.decideImport,
    adminRoute(fields({ importId: identifier, decision: oneOf("build", "stop") }), fields({ import: templateImport })),
  ],
  [PORTFOLIO_ROUTES.value, adminRoute(fields({}, { days: number(7, 90) }), valueReport)],
  [
    PORTFOLIO_ROUTES.rate,
    adminRoute(
      fields(
        { spaceId: identifier, title: text(200), rating: number(1, 5) },
        { agentId: identifier, ref: text(200), valueUsd: number(0, 10_000_000) },
      ),
      valueReport,
    ),
  ],
  [
    PORTFOLIO_ROUTES.reality,
    adminRoute(
      fields(
        {},
        {
          spaceId: identifier,
          settings: fields({}, { enabled: boolean, weekday: number(0, 6), hour: number(0, 23) }),
        },
      ),
      fields({ settings: realitySettings, reports: list(realityReport, 50) }),
    ),
  ],
  [PORTFOLIO_ROUTES.runReality, adminRoute(fields({ spaceId: identifier }), fields({ report: realityReport }))],
  [PORTFOLIO_ROUTES.cards, adminRoute(fields({ cardIds: list(string(36), 50) }), fields({ cards: list(card, 50) }))],
  [
    PORTFOLIO_ROUTES.answerCard,
    adminRoute(
      fields({
        cardId: string(36),
        answer: fields(
          {},
          {
            selected: list(text(64), 20),
            approved: boolean,
            values: record(text(1_000), 8),
            rows: record(oneOf("approve", "reject"), 20),
            note: text(600),
          },
        ),
      }),
      fields({ card }),
    ),
  ],
]);
