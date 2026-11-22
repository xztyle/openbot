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

/** A time near now: the hour today, the weekday this week, else the date. Nothing for an unknown time. */
export function useRecentTime(): (at: number, now?: number) => string {
  const { format } = useText();
  return (at, now = Date.now()) => {
    // A date the host could not give (0, or a text that did not parse) is not 1 January 1970.
    if (!Number.isFinite(at) || at <= 0) return "";
    const day = 86_400_000;
    const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
    if (sameDay) return format.date(at, { hour: "numeric", minute: "2-digit" });
    if (now - at < 6 * day) return format.date(at, { weekday: "short" });
    return format.date(at, { month: "short", day: "numeric" });
  };
}

/** A cost in dollars with cents, or a tenth of a cent under one cent. */
export function useCost(): (usd: number) => string {
  const { format } = useText();
  return (usd) => format.currencyUsd(usd, { maximumFractionDigits: usd > 0 && usd < 0.01 ? 3 : 2 });
}
