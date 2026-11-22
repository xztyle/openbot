import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/insight";

export const messages = {
  "insight.costs.side": "Chiamate di supporto",
  "insight.costs.idle": "Lavoro senza risposta",
  "insight.costs.sortBy.idle": "Lavoro senza risposta",
  "insight.costs.sortBy.side": "Chiamate di supporto",
  "insight.costs.note":
    "Prezzi di listino API del lavoro degli agenti, non gli addebiti del tuo piano. Le chiamate di supporto sono i piccoli controlli attorno al lavoro: chi deve rispondere, brevi riassunti e revisioni della memoria. Lavoro senza risposta: turni che sono costati qualcosa senza lasciare un messaggio (potrebbero aver cambiato file o ticket).",
  "insight.costs.line": "{turns} turni · {tokens} token · supporto {side}",
} as const satisfies PartialTranslation<typeof source>;
