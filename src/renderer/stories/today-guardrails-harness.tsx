/*
 * Today and Money with the guardrails and the learning queue of a fake host, for `scripts/today-e2e.ts`:
 * an agent paused at its turn limit (Resume), a learning proposal (Apply / Dismiss), a blocked prompt
 * injection, a Claude account at 97% of its five-hour window, today's spenders and a failover. A space
 * pause and a failover carry times that do not parse, as a malformed host would send them. The
 * script reads what was pressed from `document.body.dataset.todayCalls`.
 */
import { DEFAULT_GUARDRAIL_POLICY, type GuardrailsView, type GuardrailUsageRow } from "@openbot/contracts/guardrails";
import { Toaster } from "@openbot/ui";
import { MoneyView } from "@openbot/ui/features/workspace/MoneyView";
import { type TodayDecision, TodayView } from "@openbot/ui/features/workspace/TodayView";
import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { StaticI18nProvider } from "../src/i18n-context";
import "../src/styles.css";

const now = Date.now();
const nowSeconds = Math.round(now / 1000);
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const names: Record<string, string> = {
  "ana-1": "CSO – Director de Ventas",
  "leo-1": "Piks Architect",
  "space-uo": "Universidad Online",
};
const usage = (id: string, turns: number, costUsd: number, tokens: number, state: GuardrailUsageRow["state"]) => ({
  scope: id.startsWith("space") ? ("space" as const) : ("agent" as const),
  id,
  turns,
  tokens,
  costUsd,
  windowSharePercent: id === "ana-1" ? 41 : null,
  limits: id.startsWith("space") ? DEFAULT_GUARDRAIL_POLICY.spaceDefaults : DEFAULT_GUARDRAIL_POLICY.agentDefaults,
  state,
});
const view: GuardrailsView = {
  policy: DEFAULT_GUARDRAIL_POLICY,
  day: "2026-11-22",
  usage: [
    usage("ana-1", 200, 64.5, 412_000_000, "paused"),
    usage("leo-1", 37, 21.2, 98_000_000, "ok"),
    usage("space-uo", 655, 301, 1_300_000_000, "warn"),
  ],
  pauses: [
    {
      scope: "agent",
      id: "ana-1",
      reason: "turns",
      since: iso(-600_000),
      until: iso(8 * 3_600_000),
      detail: "200 of 200 turns today",
    },
    // A host time that does not parse: Money must still render.
    {
      scope: "space",
      id: "space-uo",
      reason: "cost",
      since: iso(-1_200_000),
      until: "tomorrow morning",
      detail: "$601 of $600 today",
    },
  ],
  meter: [
    {
      provider: "claude",
      accountId: "default",
      label: "owner@example.com",
      pooled: false,
      inUse: true,
      nearlyExhausted: true,
      agents: 113,
      windows: [
        {
          kind: "short",
          usedPercent: 97,
          windowDurationMins: 300,
          resetsAt: nowSeconds + 5_400,
          exhaustsAt: nowSeconds + 600,
        },
        {
          kind: "long",
          usedPercent: 63,
          windowDurationMins: 10_080,
          resetsAt: nowSeconds + 3 * 86_400,
          exhaustsAt: null,
        },
      ],
    },
    {
      provider: "codex",
      accountId: "default",
      pooled: false,
      inUse: false,
      nearlyExhausted: false,
      agents: 9,
      windows: [
        { kind: "short", usedPercent: 12, windowDurationMins: 300, resetsAt: nowSeconds + 9_000, exhaustsAt: null },
      ],
    },
  ],
  failovers: [
    {
      agentId: "leo-1",
      from: { provider: "claude", model: "claude-sonnet-5-5" },
      to: { provider: "codex", model: "gpt-6-luna" },
      since: iso(-300_000),
    },
    {
      agentId: "ana-1",
      from: { provider: "claude", model: "claude-opus-5-5" },
      to: { provider: "codex", model: "gpt-6" },
      since: "not a time",
    },
  ],
  events: [
    {
      id: "e1",
      at: iso(-60_000),
      kind: "injection-blocked",
      agentId: "ana-1",
      summary: "Blocked meta-ads set-budget of CSO after it read web: the page asked to raise the budget.",
    },
    {
      id: "e2",
      at: iso(-600_000),
      kind: "budget-pause",
      agentId: "ana-1",
      summary: "CSO – Director de Ventas paused: 200 of 200 turns today.",
    },
    {
      id: "e3",
      at: iso(-3_600_000),
      kind: "stuck-stop",
      agentId: "leo-1",
      summary: "Piks Architect: Stuck: openbot_browser.evaluate ran 10 times with the same input and result.",
    },
  ],
  kpis: { "injection-blocked": 1, "stuck-stop": 1, breaker: 0, "budget-pause": 1 },
};
const calls: string[] = [];
const record = (call: string) => {
  calls.push(call);
  document.body.dataset.todayCalls = JSON.stringify(calls);
};
const member = (id: string): WorkspaceMember => ({ id, kind: "agent", name: names[id] ?? id, avatarSeed: id });

function Harness() {
  const [current, setCurrent] = createSignal(view);
  const decisions = (): TodayDecision[] => [
    ...current().pauses.map(
      (pause): TodayDecision => ({
        key: `pause:${pause.id}`,
        member: member(pause.id),
        kind: "pause",
        action: "Paused by a guardrail",
        summary: pause.detail,
        blocking: true,
        at: Date.parse(pause.since),
        approve: async () => {
          record(`resume:${pause.scope}:${pause.id}`);
          setCurrent({ ...current(), pauses: [] });
        },
        approveLabel: "Resume",
        openLabel: "Open",
        open: () => record("open:trust"),
      }),
    ),
    {
      key: "learning:playbook:1",
      member: member("leo-1"),
      kind: "proposal",
      action: "Review a playbook change",
      summary: "Check the ad budget before each launch",
      detail: "+ Read the space budget and stop when it is under $20.",
      blocking: false,
      at: now - 120_000,
      approve: async () => record("learning:approve"),
      approveLabel: "Apply",
      reject: async () => record("learning:dismiss"),
      rejectLabel: "Dismiss",
      openLabel: "Open",
      open: () => record("open:reviews"),
    },
  ];
  return (
    <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", height: "100vh" }}>
      <TodayView name="Owner" decisions={decisions()} working={[]} report={null} shipped={[]} />
      <MoneyView
        report={null}
        todayUsd={85.7}
        spend={[]}
        agents={[]}
        guardrails={{
          view: current(),
          name: (_scope, id) => names[id] ?? id,
          member,
          onResume: async (scope, id) => {
            record(`resume:${scope}:${id}`);
            setCurrent({ ...current(), pauses: [] });
          },
          onOpenAgent: (agentId) => record(`open:${agentId}`),
        }}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <Toaster />
        <Harness />
      </StaticI18nProvider>
    ),
    root,
  );
