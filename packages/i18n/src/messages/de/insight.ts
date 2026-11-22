import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/insight";

export const messages = {
  "insight.costs.side": "Hilfsaufrufe",
  "insight.costs.idle": "Arbeit ohne Antwort",
  "insight.costs.sortBy.idle": "Arbeit ohne Antwort",
  "insight.costs.sortBy.side": "Hilfsaufrufe",
  "insight.costs.note":
    "API-Listenpreise der Arbeit der Agenten, nicht die Kosten deines Tarifs. Hilfsaufrufe sind die kleinen Prüfungen rund um die Arbeit: wer antworten soll, kurze Zusammenfassungen und Gedächtnisprüfungen. Arbeit ohne Antwort: Durchläufe, die etwas gekostet und keine Nachricht hinterlassen haben (sie können trotzdem Dateien oder Tickets geändert haben).",
  "insight.costs.line": "{turns} Durchläufe · {tokens} Tokens · Hilfen {side}",
  "insight.briefing.alertRule": "Sag mir Bescheid, wenn ein Agent Geld ausgibt und nichts verkauft wird",
  "insight.briefing.alertMinSpend": "Mehr als (US$)",
  "insight.briefing.alertDays": "So viele Tage lang",
} as const satisfies PartialTranslation<typeof source>;
