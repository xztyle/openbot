import type { AppFormat, AppTranslate } from "@openbot/i18n";
import { formatChatTimestamp } from "./chat-timestamp";

/** The time of a marker, or a word for an unknown time. */
export function formatMarkerTime(value: string, t: AppTranslate, format: AppFormat): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("chat.marker.unknownTime");
  return formatChatTimestamp(date, format);
}

/**
 * The time of a row that holds several messages, from the first to the newest. A row sits where its
 * first message sorts, so the newest time alone reads as out of order next to the rows after it.
 * One time when both read the same.
 */
export function formatMarkerTimeRange(
  start: string | undefined,
  end: string,
  t: AppTranslate,
  format: AppFormat,
): string {
  const last = formatMarkerTime(end, t, format);
  if (start === undefined) return last;
  const first = formatMarkerTime(start, t, format);
  if (first === last) return last;
  return t("chat.marker.runGroup.timeRange", { start: first, end: formatRangeEnd(start, end, t, format) });
}

/** The end of a time range names only the time when it is on the same day as the start. */
export function formatRangeEnd(start: string, end: string, t: AppTranslate, format: AppFormat): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || !sameDay(startDate, endDate))
    return formatMarkerTime(end, t, format);
  // A time today already shows without a date, in the same form as the start.
  if (sameDay(endDate, new Date())) return formatChatTimestamp(endDate, format);
  return format.date(endDate, { timeStyle: "short" });
}

function sameDay(first: Date, second: Date): boolean {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}
