import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/insight";

export const messages = {
  "insight.costs.side": "Wywołania pomocnicze",
  "insight.costs.idle": "Praca bez odpowiedzi",
  "insight.costs.sortBy.idle": "Praca bez odpowiedzi",
  "insight.costs.sortBy.side": "Wywołania pomocnicze",
  "insight.costs.note":
    "Cenniki API pracy agentów, a nie opłaty twojego planu. Wywołania pomocnicze to małe sprawdzenia wokół pracy: kto ma odpowiedzieć, krótkie podsumowania i przeglądy pamięci. Praca bez odpowiedzi: tury, które coś kosztowały i nie zostawiły wiadomości (mogły jednak zmienić pliki lub zgłoszenia).",
  "insight.costs.line": "{turns} tur · {tokens} tokenów · pomocnicze {side}",
} as const satisfies PartialTranslation<typeof source>;
