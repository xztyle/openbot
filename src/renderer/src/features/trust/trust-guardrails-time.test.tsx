import { DEFAULT_GUARDRAIL_POLICY, type GuardrailsView } from "@openbot/contracts/guardrails";
import { TextProvider } from "@openbot/ui/text";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { TrustGuardrailsPanel } from "./TrustGuardrailsPanel";
import type { GuardrailCalls } from "./trust-port";

// Failure mode: one pause or event with a time that does not parse throws in the date format, and the
// whole Guardrails tab stays blank.
const view: GuardrailsView = {
  policy: DEFAULT_GUARDRAIL_POLICY,
  day: "2026-11-22",
  usage: [],
  pauses: [{ scope: "agent", id: "ana", reason: "turns", since: "", until: "soon", detail: "200 of 200 turns today" }],
  meter: [],
  failovers: [],
  events: [
    { id: "e1", at: "not a time", kind: "stuck-stop", agentId: "ana", summary: "Ana: stuck." },
    { id: "e2", at: "2026-11-22T20:05:00Z", kind: "budget-pause", agentId: "ana", summary: "Ana paused." },
  ],
  kpis: { "injection-blocked": 0, "stuck-stop": 1, breaker: 0, "budget-pause": 1 },
};
const calls: GuardrailCalls = { view: async () => view, save: async () => view, resume: async () => view };

describe("Guardrails times", () => {
  it("renders with a time that does not parse", async () => {
    render(() => (
      <TextProvider locale="en" formatLocale="en-US">
        <TrustGuardrailsPanel calls={() => calls} name={(_scope, id) => id} onOpenAgent={() => undefined} />
      </TextProvider>
    ));
    expect(await screen.findByText("Ana: stuck.")).toBeTruthy();
    expect(screen.getByText("Ana paused.")).toBeTruthy();
    expect(screen.getByText(/200 of 200 turns today/u)).toBeTruthy();
  });
});
