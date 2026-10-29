import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  "error.storage.unsupported": "Ten serwer nie obsługuje magazynu.",
  "error.storage.agentMissing": "Agent nie istnieje.",
  "error.storage.unreadableFile": "OpenBot nie może odczytać pliku {path}. Plik jest uszkodzony.",
  "error.storage.hygieneUnsupported": "Ten serwer nie obsługuje czyszczenia pamięci.",
  "error.storage.hygieneBusy": "Trwa skanowanie lub czyszczenie pamięci. Spróbuj ponownie, gdy się zakończy.",
  "error.storage.hygieneNoReport": "Przeskanuj pamięć, zanim ją wyczyścisz.",
} as const satisfies PartialTranslation<typeof source>;
