/*
 * The Guardrails tab of the Trust view on a fake host, for `scripts/guardrails-ui-e2e.ts`: one agent
 * paused at its turn limit, a Claude account at 97% of its five-hour window, a failover, today's use
 * and the newest events. The script reads the calls from `document.body.dataset.guardrailsCalls`.
 * `?lang=es` shows the Spanish text.
 */
import {
  DEFAULT_GUARDRAIL_POLICY,
  type GuardrailPolicy,
  type GuardrailsView,
  type GuardrailUsageRow,
} from "@openbot/contracts/guardrails";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { TrustGuardrailsPanel } from "../src/features/trust/TrustGuardrailsPanel";
import type { GuardrailCalls } from "../src/features/trust/trust-port";
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
let view: GuardrailsView = {
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
const calls: { saved: GuardrailPolicy[]; resumed: string[] } = { saved: [], resumed: [] };
const publish = () => {
  document.body.dataset.guardrailsCalls = JSON.stringify(calls);
};
const fake: GuardrailCalls = {
  view: async () => view,
  save: async (policy) => {
    calls.saved.push(policy);
    publish();
    view = { ...view, policy };
    return view;
  },
  resume: async (scope, id) => {
    calls.resumed.push(`${scope}:${id}`);
    publish();
    view = { ...view, pauses: view.pauses.filter((pause) => pause.id !== id) };
    return view;
  },
};
publish();

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale={new URLSearchParams(window.location.search).get("lang") === "es" ? "es" : "en"}>
        <Toaster />
        <section class="ws-view trust-view">
          <div class="ws-view-scroll trust-scroll">
            <TrustGuardrailsPanel
              calls={() => fake}
              name={(_scope, id) => names[id] ?? id}
              onOpenAgent={() => undefined}
            />
          </div>
        </section>
      </StaticI18nProvider>
    ),
    root,
  );
