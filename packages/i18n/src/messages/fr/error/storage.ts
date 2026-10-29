import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  // Storage errors.
  "error.storage.unsupported": "Ce serveur ne prend pas en charge le stockage.",
  "error.storage.agentMissing": "L’agent n’existe pas.",
  "error.storage.unreadableFile": "OpenBot ne peut pas lire {path}. Le fichier est endommagé.",
  "error.storage.hygieneUnsupported": "Ce serveur ne prend pas en charge le nettoyage du stockage.",
  "error.storage.hygieneBusy": "Une analyse ou un nettoyage du stockage est en cours. Réessayez quand il sera terminé.",
  "error.storage.hygieneNoReport": "Analysez le stockage avant de le nettoyer.",
} as const satisfies PartialTranslation<typeof source>;
