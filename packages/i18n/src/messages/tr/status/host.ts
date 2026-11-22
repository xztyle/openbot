import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/host";

export const messages = {
  "status.host.registered": "Bu Atelier, WebRTC erişimi için kaydedildi.",
  "status.host.keyRotated": "Sunucu anahtarı değiştirildi. Eşlenmiş cihazlar eşli kalır.",
  "status.host.identityUpdated": "Sunucu kimliği güncellendi.",
  "status.host.starting": "WebRTC ana makinesi başlatılıyor…",
  "status.host.ready": "Bu Atelier, WebRTC bağlantıları için hazır.",
  "status.host.signalLost": "Diğer cihazlar şu anda bu Atelier sunucusuna ulaşamıyor. Yeniden bağlanıyor.",
  "status.host.stopping": "Bu Atelier özel yapılıyor…",
  "status.host.private": "Bu Atelier özel.",
} as const satisfies PartialTranslation<typeof source>;
