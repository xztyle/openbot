/*
 * The web client on a mock host that serves the secondary views to its owner, for
 * `scripts/views-e2e.ts`: Portfolio (value, quality with a suite, templates, reality check), Reviews
 * (savings, a weekly review, playbooks, the learning queue), Trust (rules with a budget, the audit
 * trail, the guardrails) and Insights. `?data=empty` serves each view with nothing in it, and
 * `?data=extreme` with large numbers and long text; `?appearance=dark` paints the dark palette. Each
 * admin call lands in `data-views-calls`.
 */
import type { LearningReviewItem } from "@openbot/contracts/agent-learning";
import { DEFAULT_GUARDRAIL_POLICY, type GuardrailsView, normalizeGuardrailPolicy } from "@openbot/contracts/guardrails";
import type { WorkspaceInsight } from "@openbot/contracts/ipc";
import { DEFAULT_INSIGHT_BRIEFING } from "@openbot/contracts/ipc";
import type {
  AgentSuitePage,
  QualityPage,
  RealityPage,
  SpaceTemplateSummary,
  TemplateImport,
  ValueReport,
} from "@openbot/contracts/portfolio";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { AGENT_EFFICIENCY_ROUTES } from "@openbot/contracts/team-protocol/agent-efficiency-v1";
import { AGENT_LEARNING_ROUTES } from "@openbot/contracts/team-protocol/agent-learning-v1";
import { FORK_HOST_CAPABILITY } from "@openbot/contracts/team-protocol/fork-host-v1";
import { GUARDRAILS_ROUTES } from "@openbot/contracts/team-protocol/guardrails-v1";
import { PORTFOLIO_ROUTES } from "@openbot/contracts/team-protocol/portfolio-v1";
import { decodeTrustPolicyView, TRUST_CONTROL_ROUTES } from "@openbot/contracts/team-protocol/trust-control-v1";
import { DEFAULT_TRUST_POLICY, type TrustAuditEntry, type TrustPolicyView } from "@openbot/contracts/trust-control";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { StaticI18nProvider } from "../src/i18n-context";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { seeds } from "./workspace/workspace-app-seeds";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

const params = new URLSearchParams(window.location.search);
const DATA = params.get("data") === "empty" ? "empty" : params.get("data") === "extreme" ? "extreme" : "real";
/** `?appearance=dark` paints the views in the dark palette, for a screenshot sweep. */
const APPEARANCE = params.get("appearance") === "dark" ? "dark" : "light";
const empty = DATA === "empty";
const big = DATA === "extreme";
const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const long = (text: string) => (big ? `${text} ${"and a very long explanation that goes on ".repeat(6)}` : text);

const calls: string[] = [];
function record(call: string): void {
  calls.push(call);
  document.body.dataset.viewsCalls = calls.join("\n");
}

let value: ValueReport = {
  days: 30,
  spaces: empty
    ? []
    : [
        {
          spaceId: "general",
          revenueUsd: big ? 1_234_567.891 : 540,
          adSpendUsd: big ? 98_765.4 : 120,
          cardsDone: big ? 12_345 : 14,
          ratedUsd: 50,
          valueUsd: big ? 1_334_567.5 : 590,
          costUsd: big ? 45_678.9 : 88.4,
          valuePerDollar: big ? 29.2165 : 6.67,
        },
      ],
  agents: empty
    ? []
    : [
        {
          agentId: "chief",
          spaceId: "general",
          revenueUsd: 400,
          cardsDone: 9,
          cardPoints: 20,
          ratedUsd: 50,
          rating: 4.333,
          valueUsd: 450,
          costUsd: big ? 12_345.678 : 41.2,
          valuePerDollar: 10.92,
        },
        {
          agentId: "research",
          spaceId: "general",
          revenueUsd: 0,
          cardsDone: 0,
          cardPoints: 0,
          ratedUsd: 0,
          rating: null,
          valueUsd: 0,
          costUsd: 0,
          valuePerDollar: null,
        },
      ],
  ratings: [],
  converted: empty ? [] : ["BRL"],
};

const quality: QualityPage = {
  settings: { enabled: true, sampleRate: 0.1 },
  agents: empty
    ? []
    : [
        {
          agentId: "chief",
          average7: 6.25,
          previous7: 8.1,
          dropped: true,
          trend: Array.from({ length: big ? 30 : 6 }, (_, index) => ({
            date: new Date(NOW - (6 - index) * 86_400_000).toISOString().slice(0, 10),
            average: 5 + (index % 5),
            count: 3,
          })),
          recent: [{ turnId: "t1", at: iso(-3_600_000), score: 6, note: long("Answered late and forgot the price.") }],
        },
      ],
};

const suite: AgentSuitePage = {
  suite: empty
    ? null
    : {
        agentId: "chief",
        scenarios: [
          {
            id: "late-cake",
            name: "Late cake",
            persona: "An angry buyer whose cake came 2 hours late",
            input: "Where is my cake?",
            rubric: "Says sorry, gives a time, offers a fix",
            turns: 2,
          },
        ],
        autoRun: true,
        gate: "warn",
        trials: 1,
        passMark: 0.8,
        updatedAt: iso(-86_400_000),
      },
  runs: [],
};

const starters: SpaceTemplateSummary[] = empty
  ? []
  : [
      {
        id: "course",
        name: "Online course",
        description: long("Sell a course with a landing page, ads and a support agent."),
        icon: "🎓",
        agents: 4,
      },
    ];
let imports: TemplateImport[] = [];

let reality: RealityPage = {
  settings: { enabled: true, weekday: 1, hour: 9 },
  reports: empty
    ? []
    : [
        {
          id: "r1",
          spaceId: "general",
          at: iso(-2 * 86_400_000),
          summary: long("Two claims had no evidence."),
          claims: [
            { kind: "url", text: "Published the landing page", agentId: "chief", evidence: "found", detail: "200 OK" },
            { kind: "sale", text: "Sold 3 courses", agentId: "chief", evidence: "missing", detail: "No sale rows" },
          ],
          flagged: 1,
          channelId: null,
        },
      ],
};

let learning: LearningReviewItem[] = empty
  ? []
  : [
      {
        id: "lesson",
        kind: "playbook",
        source: "task",
        agentId: "chief",
        spaceId: "general",
        title: long("Check the title is readable at phone size before handing over."),
        note: "The owner sent two thumbnails back for small text.",
        ref: "YT-41",
        changes: [{ type: "playbook-add", playbookId: "p1", slug: "thumbnails", text: "Check the title size." }],
        risk: "review",
        state: "pending",
        createdAt: iso(-3_600_000),
      },
      {
        id: "space-wide-other",
        kind: "cross-space",
        source: "dreaming",
        agentId: null,
        spaceId: "piks",
        title: "A lesson for the whole Piks space",
        note: "Only Piks should see this.",
        ref: null,
        changes: [{ type: "instructions-add", text: "Piks only." }],
        risk: "review",
        state: "pending",
        createdAt: iso(-7_200_000),
      },
    ];

let trust: TrustPolicyView = {
  policy: {
    ...DEFAULT_TRUST_POLICY,
    budgets: empty ? [] : [{ id: "b1", platform: "meta", scope: "all", perDay: 50, currency: "USD" }],
  },
  spend: empty ? [] : [{ platform: "meta", currency: "USD", today: big ? 123_456.789 : 12.5, total: 340 }],
};

const audit: TrustAuditEntry[] = empty
  ? []
  : Array.from({ length: big ? 40 : 3 }, (_, index) => ({
      id: `a${index}`,
      at: iso(-index * 3_600_000),
      actor: { kind: "agent" as const, id: "chief", name: "Chief" },
      category: "spend" as const,
      action: "meta-ads set-budget",
      summary: long(`Raised the ad budget ${index}`),
      outcome: "approved" as const,
      amount: big ? 1_234_567.5 : 40,
      currency: "USD",
      platform: "meta",
      agentId: "chief",
    }));

let guardrails: GuardrailsView = {
  policy: DEFAULT_GUARDRAIL_POLICY,
  day: new Date(NOW).toISOString().slice(0, 10),
  usage: empty
    ? []
    : [
        {
          scope: "agent",
          id: "chief",
          turns: 120,
          tokens: big ? 9_876_543_210 : 41_000_000,
          costUsd: big ? 98_765.43 : 21.2,
          windowSharePercent: 41,
          limits: DEFAULT_GUARDRAIL_POLICY.agentDefaults,
          state: "warn",
        },
      ],
  pauses: empty
    ? []
    : [
        {
          scope: "agent",
          id: "chief",
          reason: "turns",
          since: iso(-600_000),
          until: iso(8 * 3_600_000),
          detail: "200 of 200 turns today",
        },
      ],
  meter: [],
  failovers: [],
  events: [],
  kpis: { "injection-blocked": 0, "stuck-stop": 0, breaker: 0, "budget-pause": 0 },
};

/** One text or number field of a request body, as text. */
function text(body: unknown, key: string): string {
  const value = isDynamicRecord(body) ? body[key] : undefined;
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** The policy of a save request, as the host reads it. */
const policyOf = (body: unknown) => (isDynamicRecord(body) ? body.policy : undefined);

const answers: Record<string, (body: unknown) => object> = {
  [PORTFOLIO_ROUTES.value]: (body) => ({ ...value, days: Number(text(body, "days")) }),
  [PORTFOLIO_ROUTES.rate]: (body) => {
    value = { ...value, ratings: [...value.ratings] };
    record(`rate:${JSON.stringify(body)}`);
    return value;
  },
  [PORTFOLIO_ROUTES.quality]: () => quality,
  [PORTFOLIO_ROUTES.suites]: () => suite,
  [PORTFOLIO_ROUTES.saveSuite]: (body) => {
    record(`saveSuite:${JSON.stringify(body)}`);
    return suite;
  },
  [PORTFOLIO_ROUTES.runSuite]: () => ({
    run: {
      id: `run${calls.length}`,
      agentId: "chief",
      at: iso(0),
      trigger: "manual",
      label: "Run by you",
      checkpointId: null,
      status: "done",
      passRate: 1,
      passed: true,
      results: [],
      diff: [],
      regression: false,
    },
  }),
  [PORTFOLIO_ROUTES.draftSuite]: () => ({ scenarios: [] }),
  [PORTFOLIO_ROUTES.templates]: () => {
    // The research agent reports a few seconds after the import, as the host scores it later.
    imports = imports.map(
      (entry): TemplateImport =>
        entry.state === "validating" && Date.now() - Date.parse(entry.createdAt) > 3_000
          ? {
              ...entry,
              state: "ready",
              validation: {
                score: 72,
                verdict: "go",
                demand: "People search for it every month.",
                competition: "",
                risks: "",
                summary: "A real demand with room to stand out.",
                at: iso(0),
                agentId: null,
              },
            }
          : entry,
    );
    return { starters, imports };
  },
  [PORTFOLIO_ROUTES.importTemplate]: (body) => {
    record(`import:${JSON.stringify(body)}`);
    // A pasted template file fails, as a host that cannot make one of its parts does.
    if (isDynamicRecord(body) && body.template) throw new Error("The host could not create the space.");
    const made: TemplateImport = {
      id: `imp${imports.length}`,
      templateName: "Online course",
      spaceId: "general",
      state: "validating",
      validation: null,
      agents: {},
      researcherId: null,
      notes: [],
      createdAt: new Date().toISOString(),
    };
    imports = [made, ...imports];
    return { import: made };
  },
  [PORTFOLIO_ROUTES.exportTemplate]: () => ({
    template: { format: "atelier-space-template", version: 1, name: "General", agents: [] },
  }),
  [PORTFOLIO_ROUTES.reality]: (body) => {
    const settings = isDynamicRecord(body) ? body.settings : undefined;
    const enabled = isDynamicRecord(settings) ? settings.enabled : undefined;
    if (typeof enabled === "boolean") reality = { ...reality, settings: { ...reality.settings, enabled } };
    return reality;
  },
  [PORTFOLIO_ROUTES.runReality]: () => ({ report: { ...reality.reports[0], id: `r${calls.length}`, at: iso(0) } }),
  [AGENT_EFFICIENCY_ROUTES.modelSavings]: () => ({
    days: 7,
    turns: big ? 123_456 : 340,
    autoTurns: empty ? 0 : big ? 100_000 : 200,
    smallTurns: big ? 80_000 : 150,
    costUsd: big ? 12_345.678 : 12.3,
    fixedCostUsd: big ? 45_678.9 : 30.5,
    warmSwitches: 2,
  }),
  [AGENT_EFFICIENCY_ROUTES.reviews]: () => ({
    enabled: true,
    reviews: empty
      ? []
      : [
          {
            id: "rev1",
            agentId: "chief",
            periodStart: iso(-7 * 86_400_000),
            periodEnd: iso(0),
            grade: "watch",
            scorecard: {
              turns: big ? 12_345 : 120,
              failedTurns: 3,
              ticketsDone: 4,
              ticketsReopened: 1,
              praise: 2,
              complaints: 1,
              costUsd: big ? 9_876.543 : 21.2,
              smallModelShare: 0.4,
            },
            summary: long("Good week, two late answers."),
            proposal: { text: "Answer price questions first.", state: "pending" },
            reviewCostUsd: 0.02,
            createdAt: iso(-3_600_000),
          },
        ],
  }),
  [AGENT_EFFICIENCY_ROUTES.playbooks]: () => ({ playbooks: [], proposals: [], candidates: [] }),
  [AGENT_LEARNING_ROUTES.reviews]: () => ({ items: learning, settings: { dreaming: true, taskLearning: true } }),
  [AGENT_LEARNING_ROUTES.decide]: (body) => {
    const itemId = text(body, "itemId");
    const decision = text(body, "decision");
    record(`decide:${itemId}:${decision}`);
    const state = decision === "accept" ? "applied" : decision === "revert" ? "reverted" : "dismissed";
    learning = learning.map((item) => (item.id === itemId ? { ...item, state, decidedAt: iso(0) } : item));
    return { item: learning.find((item) => item.id === itemId) ?? null };
  },
  [TRUST_CONTROL_ROUTES.policy]: () => trust,
  [TRUST_CONTROL_ROUTES.savePolicy]: (body) => {
    record(`trustSave:${JSON.stringify(policyOf(body))}`);
    trust = decodeTrustPolicyView({ policy: policyOf(body), spend: trust.spend });
    return trust;
  },
  [TRUST_CONTROL_ROUTES.audit]: () => ({ entries: audit }),
  [GUARDRAILS_ROUTES.view]: () => guardrails,
  [GUARDRAILS_ROUTES.savePolicy]: (body) => {
    record(`guardrailsSave:${JSON.stringify(policyOf(body))}`);
    guardrails = { ...guardrails, policy: normalizeGuardrailPolicy(policyOf(body)) ?? guardrails.policy };
    return guardrails;
  },
  [GUARDRAILS_ROUTES.resume]: (body) => {
    const id = text(body, "id");
    record(`resume:${id}`);
    guardrails = { ...guardrails, pauses: guardrails.pauses.filter((pause) => pause.id !== id) };
    return guardrails;
  },
};

const request: TeamApiRequest = async (_method, path, decode, body) => {
  const answer = answers[path];
  if (!answer) throw new Error(`No preview answer for ${path}.`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return decode(JSON.parse(JSON.stringify(answer(body ?? {}))));
};

/** Insights in the reader's zone: the host answers with days of that zone. */
function insight(input: { days?: number; timeZone?: string }): WorkspaceInsight {
  const zone = input.timeZone ?? "UTC";
  const dayOf = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at);
  const days = Array.from({ length: input.days ?? 7 }, (_, index) => dayOf(NOW - (6 - index) * 86_400_000));
  return {
    at: NOW,
    days: input.days ?? 7,
    timeZone: zone,
    goals: [],
    costs: {
      days,
      totalUsd: empty ? 0 : big ? 123_456.78 : 88.4,
      sideUsd: 1.2,
      idleUsd: 9.6,
      weekUsd: 88.4,
      previousWeekUsd: 70.1,
      agents: [],
    },
    money: insightMoney,
    sources: [],
    alerts: [],
    briefing: {
      settings: { ...DEFAULT_INSIGHT_BRIEFING, timeZone: zone },
      channelId: null,
      lastSentAt: null,
      lastText: null,
      routines: [],
    },
  };
}
let insightMoney: WorkspaceInsight["money"] = [];

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    channels: seeds(WEB_PREVIEW_MEMBER_ID, {}),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    spaces: [{ space: { id: "piks", name: "Piks", icon: null, hue: 150 } }],
  });
  Object.assign(mock.api.agent, {
    workspaceInsight: async (input: { days?: number; timeZone?: string }) => insight(input),
    workspaceInsightAction: async (action: { kind: string; entry?: WorkspaceInsight["money"][number] }) => {
      record(`insight:${JSON.stringify(action)}`);
      if (action.kind === "money-add" && action.entry)
        insightMoney = [
          ...insightMoney,
          {
            ...action.entry,
            id: `m${insightMoney.length}`,
            source: "manual",
            product: null,
            note: null,
            updatedAt: iso(0),
          },
        ];
      return insight({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    },
  });
  const base = mockWebRuntimeFor(mock, events);
  return {
    ...base,
    connect: async (host) => [...(await base.connect(host)), FORK_HOST_CAPABILITY],
    admin: { request, team: mock.api.host },
  };
};

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <div class="web-app">
          <Toaster />
          <WebWorkspace
            accountId="preview-account"
            accountEmail="you@example.com"
            accountName="Preview User"
            accountFetch={fetch}
            onSessionCheck={async () => {}}
            onLogout={async () => {}}
            createRuntime={runtime}
            language="system"
            onChangeLanguage={() => {}}
            appearance={APPEARANCE}
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
document.documentElement.dataset.openbotColorScheme = APPEARANCE;
