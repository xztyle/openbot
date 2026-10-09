const NOTIFICATION_TEXT_STORAGE_KEY = "openbot.web.notification-text";

/** The choice for this page after the browser did not save it. It wins over an older saved value. */
let unsavedPreference: boolean | undefined;

/**
 * Whether a browser notification shows the question or the approval reason of an agent. Off unless
 * the user turned it on: a notification can show on a lock screen. Reading `window.localStorage`
 * throws when the browser blocks storage, so it is read inside the guard.
 */
export function isNotificationTextEnabled(storage?: Pick<Storage, "getItem">): boolean {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return (storage ?? window.localStorage).getItem(NOTIFICATION_TEXT_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setNotificationTextEnabled(enabled: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? window.localStorage).setItem(NOTIFICATION_TEXT_STORAGE_KEY, String(enabled));
    unsavedPreference = undefined;
  } catch {
    // Blocked or full storage keeps the switch for this page only.
    unsavedPreference = enabled;
  }
}
