// The desktop notification switch and the event main sends when the user clicks a notification.

export interface NotificationPreference {
  desktopNotifications: boolean;
  /**
   * Puts the question or the approval reason of an agent in the notification body. Absent means off:
   * a notification can show on a lock screen.
   */
  showText?: boolean;
}

// The conversation a clicked notification was about. The renderer opens it.
export interface NotificationOpenedEvent {
  serverId: string;
  agentId: string;
  threadId: string | null;
}
