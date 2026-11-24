// @vitest-environment node
//
// What reaches the owner is plain: the owner-facing summary of a waiting ticket has no ids, codes,
// long numbers, flags or technical words, also when the model slips one in. The model answers here
// are recorded answers for two real tickets, one clean and one with jargon left in.
import { describe, expect, it } from "vitest";
import { parseWaitingAsks, waitingAsksPrompt } from "../../main/motion-events/motion-waiting-asks";
import { ownerSummaryPrompt, parseOwnerSummary, plainText } from "./owner-summary";

const TECHNICAL = /[A-Z_]{3,}|\d{5,}|--\w|token|API/u;

const EVE_18 =
  "La app asociada al token de OpenBot está en modo Público/Live y un create-creative --validate con meta-ads ya no devuelve el error 1885183.";
const MAN_9 = "Faltan el REF/OFFER/PRODUCT_ID de la oferta, una foto con licencia para #proyecto y la decisión de C";

/** Recorded answers of the judge model, as it answered with the prompt below. */
const RECORDED: Record<string, string> = {
  "EVE-18":
    '{"asks": "¿Damos por buena la revisión de los anuncios de Eventos?", "why": "La cuenta de anuncios ya acepta crear anuncios nuevos, así que la campaña puede salir.", "if_yes": "El equipo pasa a preparar la campaña.", "if_no": "El agente vuelve a revisar la cuenta antes de seguir."}',
  // A slip: the model kept the field names and an error number.
  "MAN-9":
    '{"asks": "Necesitamos los datos de la oferta (REF, OFFER y PRODUCT_ID) y una foto con licencia.", "why": "Sin ellos no se puede montar la página de venta; antes daba el error 1885183 con el token de la API.", "if_yes": "La página se publica esta semana.", "if_no": "La página queda en pausa --validate."}',
};

describe("the owner-facing summary", () => {
  it("asks the model for plain words, in the owner's language, with the technical text as data", () => {
    for (const reason of [EVE_18, MAN_9]) {
      const prompt = ownerSummaryPrompt({ language: "Spanish", title: "Ticket", reason });
      expect(prompt).toContain("no technical background");
      expect(prompt).toContain("Write in Spanish");
      expect(prompt).toContain("No ids, ticket keys, codes, error numbers, commands, file names");
      expect(prompt).toContain(reason);
    }
    const ticket = waitingAsksPrompt({ key: "EVE-18", title: "Revisión", comments: [], language: "Spanish" });
    expect(ticket).toContain("plain: the same for the owner");
    expect(ticket).toContain("in Spanish");
  });

  it("has no ids, codes, long numbers, flags or tech words for EVE-18 and MAN-9", () => {
    for (const key of ["EVE-18", "MAN-9"]) {
      const summary = parseOwnerSummary(RECORDED[key] ?? "");
      expect(summary).not.toBeNull();
      for (const part of Object.values(summary ?? {})) expect(part).not.toMatch(TECHNICAL);
      expect(summary?.asks.length).toBeGreaterThan(10);
    }
    const judged = parseWaitingAsks(
      `{"asks": "blocked", "reason": "${MAN_9}", "owner_only": "none", "plain": ${RECORDED["MAN-9"]}}`,
    );
    for (const part of Object.values(judged?.plain ?? {})) expect(part).not.toMatch(TECHNICAL);
  });

  it("takes the technical pieces out of raw text", () => {
    expect(plainText(EVE_18)).not.toMatch(TECHNICAL);
    expect(plainText(MAN_9)).not.toMatch(TECHNICAL);
    expect(plainText("Revisa scripts/validar.py y src/app/main.ts antes")).toBe("Revisa y antes");
    expect(plainText("Una campaña de auto-pago en Colombia")).toBe("Una campaña de auto-pago en Colombia");
  });
});
