import { defineMessages } from "../../message";

export const messages = defineMessages("notification", {
  // Desktop notifications, raised by the main process while the window may be closed, and browser
  // notifications, raised by the web client while its tab is open.
  "notification.needsInput": "Needs your input.",
  "notification.needsApproval": "Needs your approval.",
  "notification.needsBrowserStep": "Needs you to finish a step in the browser.",
  "notification.needsApprovalFor": "Needs your approval: {action}",
  "notification.finished": "Finished working.",
  // A workflow step that waits for a person to approve or reject it.
  "notification.workflowApproval": "A step waits for your approval.",
  // A workflow output step that tells the user its result.
  "notification.workflowOutput": "A workflow has a new result.",
  "notification.failed": "Stopped with an error.",
  "notification.unattendedRunFailed": "A scheduled run stopped with an error.",
  "notification.eventCheckFailing": "An event check keeps failing.",
  "notification.eventCheckTurnFailed": "An event check turn stopped with an error.",
  "notification.eventCheckDeliveryFailed": "An event check could not give an event to the agent.",
  // The title of a notification about an agent in a channel: the agent and the channel name.
  "notification.channelTitle": "{agent} in {channel}",
  // The title of a notification about a teammate's request, shown in the chat of the agent that
  // gave it the work: that agent, then the teammate.
  "notification.teammateTitle": "{agent}: {teammate} needs you",
  // The body of a channel reply notification when the preview of agent words is off.
  "notification.channelMessage": "Sent a message.",
  // Web push about a message of a channel, DM or group. The title names the author and the
  // conversation; the body says what the message is to the reader. No text of the message shows.
  "notification.conversationTitle": "{author} in {conversation}",
  "notification.mentionedYou": "Mentioned you.",
  "notification.directMessage": "Sent you a message.",
  "notification.threadReply": "Replied in a thread you follow.",
  // One notice for several messages of one conversation that came within a short time.
  "notification.newMessages": { one: "{count} new message.", other: "{count} new messages." },
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
