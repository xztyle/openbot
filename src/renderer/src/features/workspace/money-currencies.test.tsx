import { DEFAULT_INSIGHT_BRIEFING, type InsightMoneyEntry, type WorkspaceInsight } from "@openbot/contracts/ipc";
import { createFormat } from "@openbot/i18n";
import { MoneyView } from "@openbot/ui/features/workspace/MoneyView";
import { TextProvider } from "@openbot/ui/text";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

// Failure mode: a shop that sells in pesos sees no revenue in Money at all, only a note that other
// currencies are left out, and an amount in a currency code shows as "50000 COP" in no one's format.
const entry = (kind: "revenue" | "spend", amount: number, currency: string): InsightMoneyEntry => ({
  id: `${kind}-${currency}-${amount}`,
  spaceId: "s1",
  date: "2026-11-21",
  kind,
  amount,
  currency,
  sales: null,
  product: null,
  source: "manual",
  note: null,
  updatedAt: "2026-11-21T12:00:00Z",
});

const report = (money: InsightMoneyEntry[]): WorkspaceInsight => ({
  at: Date.parse("2026-11-22T12:00:00Z"),
  days: 30,
  timeZone: "America/Bogota",
  goals: [],
  costs: { days: [], totalUsd: 0, sideUsd: 0, idleUsd: 0, weekUsd: 0, previousWeekUsd: 0, agents: [] },
  money,
  sources: [],
  alerts: [],
  briefing: { settings: DEFAULT_INSIGHT_BRIEFING, channelId: null, lastSentAt: null, lastText: null, routines: [] },
});

describe("Money in other currencies", () => {
  it("shows the revenue and the ad spend of each currency in the reader's format", () => {
    render(() => (
      <TextProvider locale="es" formatLocale="es-CO">
        <MoneyView
          report={report([
            entry("revenue", 1_250_000, "COP"),
            entry("spend", 200_000, "cop"),
            entry("revenue", 19, "USD"),
          ])}
          todayUsd={0}
          spend={[]}
          agents={[]}
        />
      </TextProvider>
    ));
    const values = [...document.querySelectorAll(".ws-money-figures dd")].map((node) =>
      node.textContent?.replace(/\s/gu, " "),
    );
    expect(values).toContain("$ 1.250.000");
    expect(values).toContain("$ 200.000");
    expect(values).toContain("US$ 19,00");
    expect(screen.getByText(/costos de los agentes están en dólares/u)).toBeTruthy();
  });

  it("formats a currency code and falls back for one Intl does not take", () => {
    const format = createFormat("en", "en-US");
    expect(format.currency(50_000, "COP").replace(/\s/gu, " ")).toBe("COP 50,000");
    expect(format.currency(12.5, "USDT")).toBe("12.5 USDT");
  });
});
