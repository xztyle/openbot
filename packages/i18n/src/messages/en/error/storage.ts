import { defineMessages } from "../../../message";

export const messages = defineMessages("error.storage", {
  // Storage errors.
  "error.storage.unsupported": "Storage is not supported by this server.",
  "error.storage.agentMissing": "The agent does not exist.",
  "error.storage.unreadableFile": "OpenBot cannot read {path}. The file is damaged.",
  "error.storage.hygieneUnsupported": "Storage cleanup is not supported by this server.",
  "error.storage.hygieneBusy": "A storage scan or cleanup is running. Try again when it is done.",
  "error.storage.hygieneNoReport": "Scan the storage before you clean it up.",
});
