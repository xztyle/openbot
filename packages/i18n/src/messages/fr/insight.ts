import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/insight";

export const messages = {
  "insight.costs.side": "Appels annexes",
  "insight.costs.idle": "Travail sans réponse",
  "insight.costs.sortBy.idle": "Travail sans réponse",
  "insight.costs.sortBy.side": "Appels annexes",
  "insight.costs.note":
    "Prix publics de l'API pour le travail des agents, pas les frais de votre forfait. Les appels annexes sont les petites vérifications autour du travail : qui doit répondre, résumés courts et revues de mémoire. Travail sans réponse : tours qui ont coûté quelque chose sans laisser de message (ils ont pu modifier des fichiers ou des tickets).",
  "insight.costs.line": "{turns} tours · {tokens} jetons · annexes {side}",
} as const satisfies PartialTranslation<typeof source>;
