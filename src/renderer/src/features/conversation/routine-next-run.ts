import type { TextValue } from "@openbot/ui/text";

/** The part of a routine that says when it runs next, whichever API it came from. */
export interface RoutineNextRun {
  active: boolean;
  /** An IANA zone. A routine from an old host may carry none. */
  timezone: string | undefined;
  /** The host's next run, as an ISO instant. An event routine does not carry it. */
  nextRunAt: string | undefined;
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function knownTimeZone(timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/** "Thu, Sep 25 at 8:20 AM", in the zone the routine runs in. */
export function routineNextRunLabel(
  routine: RoutineNextRun,
  text: Pick<TextValue, "t" | "format">,
): string | undefined {
  if (!routine.active || !routine.nextRunAt) return undefined;
  const date = new Date(routine.nextRunAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const timeZone = knownTimeZone(routine.timezone) ?? localTimeZone();
  const day = text.format.date(date, { weekday: "short", month: "short", day: "numeric", timeZone });
  const time = text.format.date(date, { hour: "numeric", minute: "2-digit", timeZone });
  return text.t("routine.card.nextRunAt", { day, time });
}

/** "Warsaw time". The zone the routine runs in, also when it is the viewer's zone. */
export function routineZoneName(timezone: string | undefined, text: Pick<TextValue, "t">): string {
  const timeZone = knownTimeZone(timezone) ?? localTimeZone();
  const city = timeZone.split("/").at(-1)?.replaceAll("_", " ");
  return text.t("routine.card.timeZone", { city: city ?? timeZone });
}

/** "Warsaw time", only when the routine does not run in the viewer's zone. */
export function routineTimeZoneLabel(timezone: string | undefined, text: Pick<TextValue, "t">): string | undefined {
  const timeZone = knownTimeZone(timezone);
  if (!timeZone || timeZone === localTimeZone()) return undefined;
  return routineZoneName(timeZone, text);
}
