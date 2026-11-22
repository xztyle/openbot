import { translateFor } from "@openbot/i18n";
import { describe, expect, it } from "vitest";
import { ownerAwayWelcomeParts } from "./owner-away-store";

// Failure mode: the toast when the owner comes back reads "1 held requests" or "0 held requests,
// 3 notifications" instead of naming only what waited, in the right number.
describe("ownerAwayWelcomeParts", () => {
  const t = translateFor("en");
  const welcome = (held: number, suppressed: number) =>
    t("workspace.away.welcome", { what: ownerAwayWelcomeParts({ held, suppressed }, t) });

  it("names one of each in the singular", () => {
    expect(welcome(1, 1)).toBe("While you were away: 1 held request, 1 notification.");
  });

  it("leaves out a count of zero", () => {
    expect(welcome(0, 3)).toBe("While you were away: 3 notifications.");
    expect(welcome(2, 0)).toBe("While you were away: 2 held requests.");
  });

  it("is plural in Spanish too", () => {
    const es = translateFor("es");
    expect(es("workspace.away.welcome", { what: ownerAwayWelcomeParts({ held: 1, suppressed: 4 }, es) })).toBe(
      "Mientras no estabas: 1 solicitud en espera, 4 notificaciones.",
    );
  });
});
