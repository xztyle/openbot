import { defineMessages } from "../../../message";

export const messages = defineMessages("status.agent", {
  "status.agent.claudeWriteOutside":
    "Write {path}, outside the agent's workspace, the shared folder and the temporary folders.",
  "status.agent.contextCleared": "Context cleared. A new chat starts here.",
  "status.agent.marketplaceSuggested": "Suggested a Marketplace app: {app}.",
  "status.agent.messageDuplicate":
    "An identical message to this agent is still queued or running. OpenBot did not send it again.",
  // The agent's activity line, when a tool step fails. The reason is the provider's own text.
  "status.agent.toolFailed": "A tool step failed: {tool}. {reason}",
  "status.agent.toolFailedNoReason": "A tool step failed ({tool}). Deciding what to try next…",
});
