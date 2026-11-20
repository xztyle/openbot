import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/messaging";

export const messages = {
  "messaging.help.invalid_token":
    "Slack n’accepte plus Atelier dans cet espace de travail. Il a peut-être été désinstallé. Connectez à nouveau l’espace de travail.",
  "messaging.help.secret_storage_unavailable":
    "Atelier ne peut pas lire les jetons enregistrés sur cet ordinateur. Déconnectez l’espace de travail, puis connectez-le à nouveau.",
  "messaging.help.relay_unavailable":
    "Atelier ne peut pas recevoir les événements Slack sur cet ordinateur. Connectez-vous, donnez un nom à cet ordinateur dans les réglages du serveur et gardez Atelier ouvert.",
  "messaging.discordHelp.invalid_token":
    "Discord n’accepte plus Atelier sur ce serveur Discord. Il a peut-être été retiré. Connectez à nouveau le serveur Discord.",
  "messaging.discordHelp.secret_storage_unavailable":
    "Atelier ne peut pas lire les jetons enregistrés sur cet ordinateur. Déconnectez le serveur Discord, puis connectez-le à nouveau.",
  "messaging.discordHelp.relay_unavailable":
    "Atelier ne peut pas recevoir les événements Discord sur cet ordinateur. Connectez-vous, donnez un nom à cet ordinateur dans les réglages du serveur et gardez Atelier ouvert.",
} as const satisfies PartialTranslation<typeof source>;
