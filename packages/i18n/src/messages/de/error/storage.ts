import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  "error.storage.unsupported": "Dieser Server unterstützt keinen Speicher.",
  "error.storage.agentMissing": "Der Agent existiert nicht.",
  "error.storage.unreadableFile": "OpenBot kann {path} nicht lesen. Die Datei ist beschädigt.",
  "error.storage.hygieneUnsupported": "Dieser Server unterstützt keine Speicherbereinigung.",
  "error.storage.hygieneBusy": "Eine Speicherprüfung oder Bereinigung läuft. Versuche es danach erneut.",
  "error.storage.hygieneNoReport": "Prüfe den Speicher, bevor du ihn bereinigst.",
} as const satisfies PartialTranslation<typeof source>;
