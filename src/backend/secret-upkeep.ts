import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import type { LedgerReminder, SecretLedger } from "./secret-ledger";

const logger = createOpenBotLogger("secret-upkeep");
/** How often the keys are looked over. An expiry also gets a timer of its own. */
const SWEEP_INTERVAL_MS = 5 * 60_000;
/** The longest a timer waits: a later expiry gets the next sweep's timer. */
const LONGEST_TIMER_MS = 6 * 60 * 60_000;

/**
 * Looks the keys over now and every few minutes: an expired key stops being served at its time, the
 * bin forgets old keys, and each reminder that is due goes to `remind` once. Returns the stop.
 */
export function startSecretUpkeep(ledger: SecretLedger, remind: (reminder: LedgerReminder) => void): () => void {
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  const sweep = () => {
    try {
      for (const reminder of ledger.sweep()) remind(reminder);
    } catch (error) {
      logger.warn("The keys upkeep failed.", { error: toLogValue(error) });
    }
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    const next = ledger.nextExpiry();
    if (next === null) return;
    const wait = Math.max(1_000, Math.min(next - Date.now() + 500, LONGEST_TIMER_MS));
    if (wait < SWEEP_INTERVAL_MS) {
      expiryTimer = setTimeout(sweep, wait);
      expiryTimer.unref?.();
    }
  };
  sweep();
  const interval = setInterval(sweep, SWEEP_INTERVAL_MS);
  interval.unref?.();
  return () => {
    clearInterval(interval);
    if (expiryTimer) clearTimeout(expiryTimer);
  };
}
