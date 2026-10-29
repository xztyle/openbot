import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  "error.storage.unsupported": "Questo server non supporta l'archiviazione.",
  "error.storage.agentMissing": "L'agente non esiste.",
  "error.storage.unreadableFile": "OpenBot non riesce a leggere {path}. Il file è danneggiato.",
  "error.storage.hygieneUnsupported": "Questo server non supporta la pulizia dello spazio.",
  "error.storage.hygieneBusy": "È in corso un'analisi o una pulizia dello spazio. Riprova quando è terminata.",
  "error.storage.hygieneNoReport": "Analizza lo spazio prima di pulirlo.",
} as const satisfies PartialTranslation<typeof source>;
