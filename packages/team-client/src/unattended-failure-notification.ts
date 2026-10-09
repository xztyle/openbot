import type { AgentEvent } from "@openbot/contracts/ipc";
import type { AppTranslate } from "@openbot/i18n";

/**
 * The agent event `error` codes that mean unattended work failed: an event check that fails again
 * and again, and an event that a check could not hand to its agent. The host sends them in the
 * ordinary `error` event, so every released client already shows them as an error banner.
 */
export const UNATTENDED_FAILURE_ERROR_CODES: readonly string[] = [
  "event_check_failing",
  "event_check_delivery_failed",
  "event_check_turn_failed",
];
function errorBodyKey(code: string) {
  switch (code) {
    case "event_check_failing":
      return "notification.eventCheckFailing";
    case "event_check_delivery_failed":
      return "notification.eventCheckDeliveryFailed";
    case "event_check_turn_failed":
      return "notification.eventCheckTurnFailed";
    default:
      return null;
  }
}

export interface UnattendedFailureSubject {
  body: string;
  agentId: string;
  threadId: string | null;
}

/**
 * The notice for a failed unattended run, or null when the event is something else. It is on at the
 * "all" and "needs-me" levels, because nobody watches the run: a scheduled routine run that failed,
 * an event check that keeps failing, and an event check delivery that failed. The caller still
 * applies the server level "nothing", the mute and the agent's own switch.
 */
export function unattendedFailureSubject(event: AgentEvent, translate: AppTranslate): UnattendedFailureSubject | null {
  if (event.type === "turn-completed")
    return event.origin === "routine" && event.status === "failed"
      ? { body: translate("notification.unattendedRunFailed"), agentId: event.agentId, threadId: event.threadId }
      : null;
  if (event.type !== "error" || !event.agentId) return null;
  const key = errorBodyKey(event.code);
  return key ? { body: translate(key), agentId: event.agentId, threadId: null } : null;
}
