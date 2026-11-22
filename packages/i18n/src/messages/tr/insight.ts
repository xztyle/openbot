import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/insight";

export const messages = {
  "insight.costs.side": "Yardımcı çağrılar",
  "insight.costs.idle": "Yanıtsız iş",
  "insight.costs.sortBy.idle": "Yanıtsız iş",
  "insight.costs.sortBy.side": "Yardımcı çağrılar",
  "insight.costs.note":
    "Ajanların işinin API liste fiyatları, planınızın ücretleri değil. Yardımcı çağrılar işin çevresindeki küçük kontrollerdir: kimin yanıtlayacağı, kısa özetler ve hafıza incelemeleri. Yanıtsız iş: bir şeye mal olup mesaj bırakmayan turlar (yine de dosya veya bilet değiştirmiş olabilirler).",
  "insight.costs.line": "{turns} tur · {tokens} token · yardımcı {side}",
  "insight.briefing.alertRule": "Bir ajan para harcayıp satış olmazsa bana haber ver",
  "insight.briefing.alertMinSpend": "Şundan fazla (US$)",
  "insight.briefing.alertDays": "Bu kadar gün boyunca",
} as const satisfies PartialTranslation<typeof source>;
