import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  "error.storage.unsupported": "Este servidor no admite almacenamiento.",
  "error.storage.agentMissing": "El agente no existe.",
  "error.storage.unreadableFile": "OpenBot no puede leer {path}. El archivo está dañado.",
  "error.storage.hygieneUnsupported": "Este servidor no admite la limpieza del almacenamiento.",
  "error.storage.hygieneBusy":
    "Hay un análisis o una limpieza del almacenamiento en curso. Vuelve a intentarlo cuando termine.",
  "error.storage.hygieneNoReport": "Analiza el almacenamiento antes de limpiarlo.",
} as const satisfies PartialTranslation<typeof source>;
