import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  // Depolama hataları.
  "error.storage.unsupported": "Depolama bu sunucu tarafından desteklenmiyor.",
  "error.storage.agentMissing": "Ajan mevcut değil.",
  "error.storage.unreadableFile": "OpenBot {path} dosyasını okuyamıyor. Dosya bozuk.",
  "error.storage.hygieneUnsupported": "Bu sunucu depolama temizliğini desteklemiyor.",
  "error.storage.hygieneBusy": "Bir depolama taraması veya temizliği sürüyor. Bittiğinde yeniden deneyin.",
  "error.storage.hygieneNoReport": "Temizlemeden önce depolamayı tarayın.",
} as const satisfies PartialTranslation<typeof source>;
