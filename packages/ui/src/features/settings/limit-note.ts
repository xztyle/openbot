import type { AppFormat, AppTranslate } from "@openbot/i18n";
import type { LimitNoteState } from "../../form";

/**
 * The `limitNote` of a field with a character limit: the count near the limit, and a plain word
 * when the browser cut text that was typed or pasted past it.
 */
export function limitNoteText(t: AppTranslate, format: AppFormat): (state: LimitNoteState) => string {
  return ({ length, max, cut }) => {
    const limit = format.number(max);
    if (cut) return t("agentSettings.limit.cut", { max: limit });
    if (length >= max) return t("agentSettings.limit.reached", { max: limit });
    return t("agentSettings.limit.count", { length: format.number(length), max: limit });
  };
}
