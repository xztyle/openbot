import { describe, expect, it } from "vitest";
import { APPROVE, askTarget, fold, GOAL, isCommandText, STOP } from "./workspace-command-text";

// Failure mode: an owner who uses Atelier in Spanish types "pídele a Research …" or "aprobar" in the
// command bar, and it goes to the lead as a task instead, or a Spanish sentence that only starts
// like a verb ("parar", "Meta Ads") is taken for one.
const agents = [{ name: "Research" }, { name: "Research Lead" }, { name: "Chief" }];

describe("command bar verbs", () => {
  it("sends a Spanish ask to the agent it names", () => {
    expect(askTarget("pídele a Research compara los precios", agents)).toEqual({
      kind: "named",
      agent: agents[0],
      message: "compara los precios",
    });
    expect(askTarget("pide a Chief: el resumen de hoy", agents)).toMatchObject({
      agent: agents[2],
      message: "el resumen de hoy",
    });
    expect(askTarget("pregúntale a Research Lead qué falta", agents)).toMatchObject({
      agent: agents[1],
      message: "qué falta",
    });
    expect(askTarget("dile a Chief hola", agents)).toMatchObject({ agent: agents[2], message: "hola" });
    expect(askTarget("ask Research compare the prices", agents)).toMatchObject({ agent: agents[0] });
  });

  it("leaves a Spanish sentence that names no agent to the lead", () => {
    expect(askTarget("pregunta a los clientes qué opinan", agents)).toBeNull();
    expect(askTarget("pidieron un reembolso ayer", agents)).toBeNull();
  });

  it("knows the Spanish approve, stop and goal words, with or without accents", () => {
    for (const text of ["aprobar", "aprueba Chief", "decisiones", "pendientes"]) {
      expect(APPROVE.test(fold(text)), text).toBe(true);
    }
    for (const text of ["detener Research", "detén Research", "pausa"]) {
      expect(STOP.test(fold(text)), text).toBe(true);
      expect(text.replace(STOP, "").trim(), text).not.toMatch(/^(?:n |én )/u);
    }
    for (const text of ["objetivo", "nuevo objetivo", "fijar un objetivo"]) {
      expect(GOAL.test(fold(text)), text).toBe(true);
    }
    expect(isCommandText("detén a Research")).toBe(true);
  });

  it("does not take a word that only starts like a verb", () => {
    for (const text of [
      "parar la campaña",
      "Meta Ads gastó mucho",
      "pausado desde ayer",
      "aprobado",
      "objetivos del mes",
    ]) {
      expect(isCommandText(text), text).toBe(false);
    }
    expect(isCommandText("approved yesterday")).toBe(false);
  });
});
