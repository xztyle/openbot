import { defineMessages } from "../../message";

export const messages = defineMessages("queue", {
  "queue.label": "Message queue",
  "queue.moved": "Moved queued message to position {position} of {total}.",
  "queue.attachment": "Attachment",
  "queue.hold.named": "Waiting - {name} is working in {channel}",
  "queue.hold.unnamed": "Waiting - this agent is working in {channel}",
  "queue.item.label": "Queued message {position}: {preview}",
  "queue.item.labelEditing": "Queued message {position}, editing: {preview}",
  "queue.item.editing": "Editing",
  "queue.item.steerLabel": "Steer queued message {position}",
  "queue.item.steerTooltip": "Steer message",
  "queue.item.steering": "Steering",
  "queue.item.steer": "Steer",
  "queue.item.notSteered": "Not steered",
  "queue.item.steerFallback.providerUnsupported":
    "This provider cannot steer a running turn, so the message waits in the queue.",
  "queue.item.steerFallback.steerFailed": "Steering did not succeed, so the message waits in the queue.",
  "queue.item.deleteLabel": "Delete queued message {position}",
  "queue.item.deleteTooltip": "Delete message",
  "queue.item.editLabel": "Edit queued message {position}",
  "queue.item.editTooltip": "Edit message",
  "queue.deleteHeld.title": "Delete queued message?",
  "queue.deleteHeld.body": "Another device is editing this message. The agent will not receive it.",
  "queue.deleteHeld.keep": "Keep",
  "queue.stopAndClear.action": "Stop and clear queue",
  "queue.stopAndClear.title": "Stop the agent and clear the queue?",
  "queue.stopAndClear.body": {
    one: "The agent stops its current work and the queued message is cancelled. It stays in the chat marked Cancelled.",
    other:
      "The agent stops its current work and {count} queued messages are cancelled. They stay in the chat marked Cancelled.",
  },
  "queue.stopAndClear.confirm": "Stop and clear",
  "queue.stopAndClear.keep": "Keep working",
});
