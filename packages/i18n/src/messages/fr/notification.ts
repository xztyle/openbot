import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/notification";

export const messages = {
  // Desktop notifications, raised by the main process while the window may be closed, and browser
  // notifications, raised by the web client while its tab is open.
  "notification.needsInput": "Nécessite votre réponse.",
  "notification.needsApproval": "Nécessite votre approbation.",
  "notification.needsBrowserStep": "Vous devez terminer une étape dans le navigateur.",
  "notification.needsApprovalFor": "Nécessite votre approbation : {action}",
  "notification.finished": "Travail terminé.",
  // A workflow step that waits for a person to approve or reject it.
  "notification.workflowApproval": "Une étape attend votre approbation.",
  // A workflow output step that tells the user its result.
  "notification.workflowOutput": "Un workflow a un nouveau résultat.",
  "notification.failed": "Arrêté à cause d’une erreur.",
  "notification.channelTitle": "{agent} dans {channel}",
  "notification.teammateTitle": "{agent} : {teammate} a besoin de vous",
  "notification.channelMessage": "A envoyé un message.",
  "notification.conversationTitle": "{author} dans {conversation}",
  "notification.mentionedYou": "Vous a mentionné.",
  "notification.directMessage": "Vous a envoyé un message.",
  "notification.threadReply": "A répondu dans un fil que vous suivez.",
  "notification.newMessages": { one: "{count} nouveau message.", other: "{count} nouveaux messages." },
  "notification.usageLimit.title": "Le compte {provider} a atteint sa limite",
  "notification.usageLimit.body": {
    one: "{count} agent attend. Atelier réessaiera plus tard.",
    other: "{count} agents attendent. Atelier réessaiera plus tard.",
  },
  "notification.usageLimit.bodyResets": {
    one: "{count} agent attend. La limite se réinitialise {reset}.",
    other: "{count} agents attendent. La limite se réinitialise {reset}.",
  },
  "notification.test": "Les notifications fonctionnent.",
  "notification.welcome": "Atelier vous préviendra ici quand un agent aura besoin de vous.",
  // The toast region in each window.
  "notification.toast.region": "Notifications",
  "notification.toast.close": "Fermer la notification",
  "notification.digest.title": { one: "{count} nouvelle de vos agents", other: "{count} nouvelles de vos agents" },
  "notification.digest.fromOne": "De {agent}.",
  "notification.digest.fromMany": { one: "De {agent} et {count} autre.", other: "De {agent} et {count} autres." },
} as const satisfies PartialTranslation<typeof source>;
