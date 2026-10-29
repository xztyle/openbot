import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  "error.storage.unsupported": "Este servidor não oferece suporte a armazenamento.",
  "error.storage.agentMissing": "O agente não existe.",
  "error.storage.unreadableFile": "O OpenBot não consegue ler {path}. O arquivo está danificado.",
  "error.storage.hygieneUnsupported": "Este servidor não oferece suporte à limpeza do armazenamento.",
  "error.storage.hygieneBusy":
    "Uma análise ou limpeza do armazenamento está em andamento. Tente de novo quando terminar.",
  "error.storage.hygieneNoReport": "Analise o armazenamento antes de limpá-lo.",
} as const satisfies PartialTranslation<typeof source>;
