import type { EventCheckSchedule } from "@openbot/contracts/event-checks";
import { nextValidRoutineOccurrence } from "./routine-schedule";

/** Seconds belong only to deterministic checks; released routine schedules stay unchanged. */
export function nextEventCheckOccurrence(schedule: EventCheckSchedule, timezone: string, after: Date): Date {
  if (schedule.kind !== "interval" || schedule.unit !== "seconds")
    return nextValidRoutineOccurrence(schedule, timezone, after);
  const anchor = Date.parse(schedule.anchorAt);
  const duration = schedule.amount * 1000;
  const elapsed = Math.max(-duration, after.getTime() - anchor);
  return new Date(anchor + (Math.floor(elapsed / duration) + 1) * duration);
}
