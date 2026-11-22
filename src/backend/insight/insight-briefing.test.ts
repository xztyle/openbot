import { describe, expect, it } from "vitest";
import { type BriefingFacts, moneyText, plainBriefing } from "./insight-briefing";

// Failure mode: the Spanish briefing writes "1,250,000 COP" with English separators, "1 tareas
// terminadas" and "1 cosa esperan por ti".
const facts = (language: "es" | "en"): BriefingFacts => ({
  scope: "Universidad Online",
  language,
  date: "2026-11-22",
  moved: { tasksDone: 1, tasksFailed: 1, ticketsCreated: 1, ticketsClosed: 2, landings: [] },
  needsYou: [{ agent: "Ana", what: "Approve the ad", link: null }],
  loopDecisions: [],
  heldNotifications: 0,
  money: [
    {
      space: "Cursos",
      yesterday: {
        spend: moneyText(new Map([["COP", 1_250_000.5]]), language),
        revenue: null,
        sales: 1,
        net: null,
      },
      week: { spend: null, revenue: null, sales: null, net: null },
    },
  ],
  goals: [],
  decisions: [],
  costs: { weekUsd: 1234.5, previousWeekUsd: 0, idleUsd: 0, top: [] },
  alerts: [],
});

describe("plainBriefing", () => {
  it("writes Spanish numbers and singulars", () => {
    expect(plainBriefing(facts("es")).split("\n")[0]).toBe(
      "1 tarea terminada, 1 falló. 1 ticket nuevo y 2 cerrados. Cursos ayer: gasto 1.250.000,5 COP, ingresos 0 (1 venta). 1 cosa espera por ti. Costo de agentes esta semana: 1.234,5 USD (semana anterior 0 USD).",
    );
  });

  it("writes English numbers and singulars", () => {
    expect(plainBriefing(facts("en")).split("\n")[0]).toBe(
      "1 task done, 1 failed. 1 ticket opened and 2 closed. Cursos yesterday: spent 1,250,000.5 COP, earned 0 (1 sale). 1 thing waits for you. Agent cost this week: 1,234.5 USD (week before 0 USD).",
    );
  });
});
