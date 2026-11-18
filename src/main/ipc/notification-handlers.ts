// The desktop notification switch and the test notification Settings offers.

import type { AppTranslate } from "@openbot/i18n";
import { sourceText } from "@openbot/i18n/source";
import { type IpcMainInvokeEvent, Notification } from "electron";
import { runCauseEffect } from "../../backend/effect-boundary";
import { notificationSettingsUrl, showRetainedNotification } from "../desktop-notifications";
import type { NotificationPreferenceStore } from "../notification-preference-store";
import { parseBadgeCount, parseNotificationPreference } from "./app-inputs";
import { authorizedHandler, handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export interface NotificationIpcDependencies {
  notificationPreference: NotificationPreferenceStore;
  translate: AppTranslate;
  /** Asks the operating system for permission if OpenBot has not asked yet. */
  requestPermission: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  /** The web contents id of the main window, or null while it has none. */
  mainRendererId: () => number | null;
  /** Shows the count on the Dock or taskbar icon; 0 clears it. */
  setBadgeCount: (count: number) => void;
}

export function notificationIpcHandlers({
  notificationPreference,
  translate,
  requestPermission,
  openExternal,
  mainRendererId,
  setBadgeCount,
}: NotificationIpcDependencies): Pick<IpcGroupHandlers, "notifications"> {
  // Every window of the app shares one origin; the Dynamic Island and the browser dock overlay must
  // not set the count of the main window.
  const fromMainRenderer = (event: IpcMainInvokeEvent) => {
    if (event.sender.id !== mainRendererId()) throw new Error("Rejected badge IPC request outside the main renderer.");
  };
  return {
    notifications: {
      getPreference: handler(() => notificationPreference.get()),
      setPreference: payloadHandler(parseNotificationPreference, async (preference) => {
        const saved = await runCauseEffect(notificationPreference.set(preference));
        // A user who had the switch off at first start was never asked; turning it on asks now.
        await requestPermission();
        return saved;
      }),
      // Shown even when the window has focus and the switch is off: the user asked for this one, and
      // it is how they find out whether the operating system lets OpenBot show notifications at all.
      test: handler(() => {
        if (!Notification.isSupported()) throw new Error(sourceText("error.app.notificationsUnsupported"));
        showRetainedNotification(new Notification({ title: "OpenBot", body: translate("notification.test") }));
      }),
      openSettings: handler(async () => {
        const url = notificationSettingsUrl(process.platform);
        if (!url) throw new Error(sourceText("error.app.notificationSettingsMissing"));
        await openExternal(url);
      }),
      setBadgeCount: authorizedHandler(fromMainRenderer, parseBadgeCount, (_event, count) => setBadgeCount(count)),
    },
  };
}
