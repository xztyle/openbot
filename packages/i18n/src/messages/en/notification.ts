import { defineMessages } from "../../message";

export const messages = defineMessages("notification", {
  // Desktop notifications, raised by the main process while the window may be closed, and browser
  // notifications, raised by the web client while its tab is open.
  "notification.needsInput": "Needs your input.",
  "notification.needsApproval": "Needs your approval.",
  "notification.finished": "Finished working.",
  "notification.failed": "Stopped with an error.",
  "notification.unattendedRunFailed": "A scheduled run stopped with an error.",
  "notification.eventCheckFailing": "An event check keeps failing.",
  "notification.eventCheckTurnFailed": "An event check turn stopped with an error.",
  "notification.eventCheckDeliveryFailed": "An event check could not give an event to the agent.",
  "notification.usageLimit.title": "{provider} account reached its limit",
  "notification.usageLimit.body": {
    one: "{count} agent waits. OpenBot will try again later.",
    other: "{count} agents wait. OpenBot will try again later.",
  },
  "notification.usageLimit.bodyResets": {
    one: "{count} agent waits. Resets {reset}.",
    other: "{count} agents wait. Resets {reset}.",
  },
  "notification.test": "Notifications are working.",
  "notification.welcome": "OpenBot will tell you here when an agent needs you.",
  // The toast region in each window.
  "notification.toast.region": "Notifications",
  "notification.toast.close": "Close notification",
});
