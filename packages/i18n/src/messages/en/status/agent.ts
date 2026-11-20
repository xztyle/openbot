import { defineMessages } from "../../../message";

export const messages = defineMessages("status.agent", {
  "status.agent.claudeWriteOutside":
    "Write {path}, outside the agent's workspace, the shared folder and the temporary folders.",
  "status.agent.contextCleared": "Context cleared. A new chat starts here.",
  "status.agent.modelSwitchedForLimit": "Usage limit reached. Switched to {model}.",
  "status.agent.modelReturnedAfterLimit": "Usage limit ended. Switched back to {model}.",
  "status.agent.modelSwitchedForError": "Provider error. Switched to {model}.",
  "status.agent.modelReturnedAfterError": "Switched back to {model} after the provider error.",
  "status.agent.marketplaceSuggested": "Suggested a Marketplace app: {app}.",
  "status.agent.messageDuplicate":
    "An identical message to this agent is still queued or running. Atelier did not send it again.",
  "status.agent.messageHeld":
    "Sent as fyi: it does not wake the recipients, who read it in their next turn. When a recipient must act on it now, send it again without fyi.",
  "status.agent.toolFailed": "A tool step failed: {tool}. {reason}",
  "status.agent.toolFailedNoReason": "A tool step failed ({tool}). Deciding what to try next…",
  "status.agent.channelMemberAdded": "{agent} added {member} to the channel. {person} asked for it.",
  "status.agent.channelMemberRemoved": "{agent} removed {member} from the channel. {person} asked for it.",
  "status.agent.channelInstructionsChanged": "{agent} changed the channel instructions. {person} asked for it.",
  "status.agent.channelRoutineCreated": "{agent} created the routine {routine}. {person} asked for it.",
  "status.agent.channelRoutineUpdated": "{agent} changed the routine {routine}. {person} asked for it.",
  "status.agent.channelRoutineDeleted": "{agent} deleted the routine {routine}. {person} asked for it.",
  "status.agent.channelCreatedByAgent": "{agent} created this channel.",
  "status.agent.channelSettingsChangedByAgent": "{agent} changed the channel settings.",
  "status.agent.channelArchivedByAgent": "{agent} archived this channel.",
  "status.agent.channelRestoredByAgent": "{agent} restored this channel.",
  "status.agent.channelMembersAddedByAgent": "{agent} added {members} to the channel.",
  "status.agent.channelMembersRemovedByAgent": "{agent} removed {members} from the channel.",
  "status.agent.channelMembersChangedByAgent": "{agent} changed how {members} answer in the channel.",
  "status.agent.screenCaptureScreen": "Capture the main screen and send the image to the agent's model.",
  "status.agent.screenCaptureChannel":
    "The image shows in the channel {channel}, and each member of this server who reads the channel can see it.",
  "status.agent.screenCaptureDisplay": "Capture the display {name} and send the image to the agent's model.",
  "status.agent.screenCaptureWindow": "Capture the window {name} and send the image to the agent's model.",
  "status.agent.screenCaptureRegion":
    "Capture the screen area at {x}, {y}, {width} × {height} points and send the image to the agent's model.",
  "status.agent.vaultCardFill":
    "Fill the saved card {card} on {site}. After you approve, agents can fill this card on this site with no approval. Remove the site in Server settings > Vault.",
  "status.agent.vaultCardFillFrames": "The card fields are in frames from {origins}.",
  "status.agent.secretKeyFill":
    "Fill the saved key {name} into the password field on {site}. After you approve, agents can fill this key on this site with no approval. Remove the key in Secrets to remove the approval.",
  "status.agent.secretKeyCodeFill":
    "Fill a two-step code from the saved key {name} into the code field on {site}. After you approve, agents can fill codes from this key on this site with no approval. Remove the key in Secrets to remove the approval.",
  "status.agent.screenCaptureProgress": "Asking to capture the screen…",
  "status.agent.screenCaptureReviewing": "Reviewing the screen capture…",
  "status.agent.memoriesSearching": "Searching its memories…",
  "status.agent.memoriesSearched": {
    one: "Searched its memories: {count} found",
    other: "Searched its memories: {count} found",
  },
  "status.agent.memoriesUpdating": "Updating its memories…",
  "status.agent.skillUsing": "Using the skill {name}…",
  "status.agent.skillReading": "Reading a skill…",
  "status.agent.memoryChanges": "Memory: {saved} saved, {updated} updated, {forgotten} forgotten.",
  "status.agent.mcpServerAdd":
    "Add the MCP server {name}: {target}. Every agent on this server gets its tools. Atelier connects to it to test it.",
  "status.agent.mcpServerChange":
    "Change the MCP server {name} to {target}. Every agent on this server gets its tools. Atelier connects to it to test it.",
  "status.agent.mcpServerEnable": "Turn on the MCP server {name} for every agent on this server.",
  "status.agent.mcpServerDisable": "Turn off the MCP server {name} for every agent on this server.",
  "status.agent.mcpServerRemove": "Remove the MCP server {name} and its sign-in from every agent on this server.",
  "status.agent.mcpSignInRequested": "The MCP server {name} needs a sign-in. Sign in from Server settings, MCP.",
  "status.agent.vaultAdded": "Saved to Vault: {name}",
  "status.agent.vaultUpdated": "Changed in Vault: {name}",
  "status.agent.vaultDeleted": "Deleted from Vault: {name}",
});
