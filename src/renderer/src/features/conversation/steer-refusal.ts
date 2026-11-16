import { sourceText } from "@openbot/i18n/source";

/**
 * The host refused a steer because the turn it was for has ended. The message then runs as the next
 * turn, so the refusal is no failure to show (#3206).
 */
export function isSteerTurnChanged(error: unknown): boolean {
  return error instanceof Error && error.message.includes(sourceText("error.backend.steerTurnChanged"));
}
