import { useText } from "../../text";

export { CHANNEL_NAME_MAX, slugChannelName } from "@openbot/contracts/ipc";

/** Durations of agent work: "42s", "3m 12s", "2h 5m". */
export function useWorkspaceDuration(): (ms: number) => string {
  const { t } = useText();
  return (ms) => {
    const total = Math.max(0, Math.round(ms / 1_000));
    if (total < 60) return t("workspace.duration.seconds", { seconds: total });
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return t("workspace.duration.minutes", { minutes, seconds: total % 60 });
    return t("workspace.duration.hours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  };
}

/** The time of a message: "3:42 PM" in the reader's format. */
export function useMessageTime(): (at: number) => string {
  const { format } = useText();
  return (at) => format.date(at, { hour: "numeric", minute: "2-digit" });
}

/**
 * A time near now: the hour today, "Yesterday", the weekday earlier this week, else the date.
 * Nothing for an unknown time; the year only for another year. A time ahead of now on another day is a date: a weekday alone would
 * read as this past week.
 */
export function useRecentTime(): (at: number, now?: number) => string {
  const { t, format } = useText();
  return (at, now = Date.now()) => {
    // A date the host could not give (0, or a text that did not parse) is not 1 January 1970.
    if (!Number.isFinite(at) || at <= 0) return "";
    const day = 86_400_000;
    const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
    if (sameDay) return format.date(at, { hour: "numeric", minute: "2-digit" });
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (new Date(at).toDateString() === yesterday.toDateString()) return t("workspace.day.yesterday");
    if (at < now && now - at < 6 * day) return format.date(at, { weekday: "short" });
    const otherYear = new Date(at).getFullYear() !== new Date(now).getFullYear();
    return format.date(at, { month: "short", day: "numeric", ...(otherYear ? { year: "numeric" } : {}) });
  };
}

/** A cost in dollars with cents, or a tenth of a cent under one cent. */
export function useCost(): (usd: number) => string {
  const { format } = useText();
  return (usd) => format.currencyUsd(usd, { maximumFractionDigits: usd > 0 && usd < 0.01 ? 3 : 2 });
}

/**
 * The day of `at` in `timeZone` (the reader's own zone without one), `YYYY-MM-DD`, as the host dates
 * its rows. The UTC day would be tomorrow for an evening in the Americas.
 */
export function zoneDay(at: number, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}
