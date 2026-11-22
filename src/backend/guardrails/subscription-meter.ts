import type { SubscriptionPoolMeter, SubscriptionWindowMeter } from "@openbot/contracts/guardrails";
import type { AccountUsageWindow } from "@openbot/contracts/ipc";

/** The longest window that counts as a short one, such as five hours: one day, as the pool counts it. */
const SHORT_WINDOW_MINUTES = 24 * 60;
/** A window that resets within this time is not nearly run out: its capacity comes back soon. */
const RESET_SOON_SECONDS = 15 * 60;
/** The pace of a window is read only after this much of it has passed, so one early turn is not a trend. */
const MIN_ELAPSED_SECONDS = 10 * 60;

/** One account of a provider, with the windows of its last reading. */
export interface MeterAccount {
  provider: string;
  accountId: string;
  label?: string | undefined;
  pooled: boolean;
  inUse: boolean;
  windows: readonly AccountUsageWindow[];
  agents: number;
}

/** The percent used now: a window whose reset is past is empty until the next reading. */
export function usedNow(window: AccountUsageWindow, nowSeconds: number): number {
  return window.resetsAt !== null && window.resetsAt <= nowSeconds ? 0 : window.usedPercent;
}

/**
 * When the window reaches 100% at its pace since it started, in epoch seconds, or null when it lasts
 * to its reset or its pace is unknown. The pace since the window's start needs no history, so the
 * forecast holds after a restart; a burst of work late in the window shows on the next reading.
 */
export function forecastExhaustion(window: AccountUsageWindow, nowSeconds: number): number | null {
  const used = usedNow(window, nowSeconds);
  if (used >= 100) return nowSeconds;
  if (window.resetsAt === null || window.windowDurationMins === null || window.resetsAt <= nowSeconds) return null;
  const elapsed = nowSeconds - (window.resetsAt - window.windowDurationMins * 60);
  if (elapsed < MIN_ELAPSED_SECONDS || used <= 0) return null;
  const at = nowSeconds + ((100 - used) / used) * elapsed;
  return at < window.resetsAt ? Math.round(at) : null;
}

/** True when a window is used to `threshold` and does not reset soon. */
export function windowNearlyExhausted(window: AccountUsageWindow, threshold: number, nowSeconds: number): boolean {
  if (usedNow(window, nowSeconds) < threshold) return false;
  return window.resetsAt === null || window.resetsAt - nowSeconds > RESET_SOON_SECONDS;
}

export function meterRow(account: MeterAccount, threshold: number, nowSeconds: number): SubscriptionPoolMeter {
  const windows: SubscriptionWindowMeter[] = account.windows.map((window) => ({
    kind:
      window.windowDurationMins === null
        ? "other"
        : window.windowDurationMins <= SHORT_WINDOW_MINUTES
          ? "short"
          : "long",
    usedPercent: usedNow(window, nowSeconds),
    windowDurationMins: window.windowDurationMins,
    resetsAt: window.resetsAt,
    exhaustsAt: forecastExhaustion(window, nowSeconds),
  }));
  return {
    provider: account.provider,
    accountId: account.accountId,
    ...(account.label ? { label: account.label.slice(0, 200) } : {}),
    pooled: account.pooled,
    inUse: account.inUse,
    windows,
    nearlyExhausted: account.windows.some((window) => windowNearlyExhausted(window, threshold, nowSeconds)),
    agents: account.agents,
  };
}
