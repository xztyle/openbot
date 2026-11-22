import { defineMessages } from "../../../message";

export const messages = defineMessages("status.host", {
  // Status lines of the WebRTC host.
  "status.host.registered": "Registered this Atelier for WebRTC access.",
  "status.host.keyRotated": "Server key changed. Paired devices stay paired.",
  "status.host.identityUpdated": "Server identity updated.",
  "status.host.starting": "Starting the WebRTC host…",
  "status.host.ready": "This Atelier is ready for WebRTC connections.",
  "status.host.signalLost": "Other devices cannot reach this Atelier now. It connects again.",
  "status.host.stopping": "Making this Atelier private…",
  "status.host.private": "This Atelier is private.",
});
