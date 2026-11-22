import { DEFAULT_OWNER_AWAY_SETTINGS, type OwnerAwayState } from "@openbot/contracts/team-protocol/owner-away-v1";
import { translateFor } from "@openbot/i18n";
import { describe, expect, it } from "vitest";
import { ownerAwayQuietNow, ownerAwayWelcomeParts } from "./owner-away-store";

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

// Failure mode: with push off, the owner's browser tab still pops a notification and plays a cue for
// each agent event during focus or quiet hours, which the host holds back for push.
describe("ownerAwayQuietNow", () => {
  const NOW = Date.parse("2026-11-22T12:00:00Z");
  const state = (quiet: OwnerAwayState["quiet"]): OwnerAwayState => ({
    settings: DEFAULT_OWNER_AWAY_SETTINGS,
    systemTimezone: "Europe/Madrid",
    focusUntil: quiet?.kind === "focus" ? quiet.until : null,
    quiet,
    held: [],
    suppressed: { count: 0, since: null },
  });

  it("is quiet in focus and quiet hours until they end", () => {
    expect(ownerAwayQuietNow(state({ kind: "focus", until: NOW + 60_000 }), NOW)).toBe(true);
    expect(ownerAwayQuietNow(state({ kind: "quiet-hours", until: NOW + 60_000 }), NOW)).toBe(true);
    // The last read said focus, but its end has passed since.
    expect(ownerAwayQuietNow(state({ kind: "focus", until: NOW - 1 }), NOW)).toBe(false);
  });

  it("is not quiet without a state or without quiet time", () => {
    expect(ownerAwayQuietNow(null, NOW)).toBe(false);
    expect(ownerAwayQuietNow(state(null), NOW)).toBe(false);
  });
});
