import type { AppTranslate } from "@openbot/i18n";
import { SAVED_REPLY_LIMIT, SAVED_REPLY_MAX_LENGTH } from "@openbot/ui/features/conversation/saved-reply-limits";

/**
 * Where the list lives: this browser or desktop profile. OpenBot has no per-host settings store that
 * a client can write, and a list of short steering lines is the person's own habit, not the host's
 * state, so it follows the person to every host they open on this device.
 */
export const SAVED_REPLIES_STORAGE_KEY = "openbot.saved-replies.v1";

/**
 * The replies OpenBot ships, in the interface language. They are not stored: a person who never edits
 * the list keeps the current wording and the current language, and the list is theirs from the first save.
 */
export function defaultSavedReplies(t: AppTranslate): string[] {
  return [
    t("composer.savedReplies.default.continue"),
    t("composer.savedReplies.default.approvePlan"),
    t("composer.savedReplies.default.summarize"),
  ];
}

/** Cleans a list read from storage or typed in a dialog: text only, trimmed, no blanks or repeats, bounded. */
export function normalizeSavedReplies(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const replies: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const reply = item.trim().slice(0, SAVED_REPLY_MAX_LENGTH);
    if (reply && !replies.includes(reply)) replies.push(reply);
    if (replies.length === SAVED_REPLY_LIMIT) break;
  }
  return replies;
}

/**
 * The list the person saved, or null when they never did (and so want the defaults). An empty list
 * is a saved choice: the person removed every reply. Storage that is blocked or unreadable is null.
 */
export function readSavedReplies(storage?: Pick<Storage, "getItem">): string[] | null {
  try {
    const raw = (storage ?? window.localStorage).getItem(SAVED_REPLIES_STORAGE_KEY);
    return raw === null ? null : normalizeSavedReplies(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Saves the list, or the choice of the defaults with null. Blocked storage keeps it for this page only. */
export function writeSavedReplies(replies: string[] | null, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const target = storage ?? window.localStorage;
    if (replies === null) target.removeItem(SAVED_REPLIES_STORAGE_KEY);
    else target.setItem(SAVED_REPLIES_STORAGE_KEY, JSON.stringify(normalizeSavedReplies(replies)));
  } catch {
    // The choice holds for this page. A new page starts from what the browser kept.
  }
}
