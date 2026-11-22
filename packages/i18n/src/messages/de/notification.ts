import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/notification";

export const messages = {
  "notification.needsInput": "Braucht deine Eingabe.",
  "notification.needsApproval": "Braucht deine Genehmigung.",
  "notification.needsBrowserStep": "Braucht dich für einen Schritt im Browser.",
  "notification.needsApprovalFor": "Braucht deine Genehmigung: {action}",
  "notification.finished": "Arbeit abgeschlossen.",
  // A workflow step that waits for a person to approve or reject it.
  "notification.workflowApproval": "Ein Schritt wartet auf deine Freigabe.",
  // A workflow output step that tells the user its result.
  "notification.workflowOutput": "Ein Workflow hat ein neues Ergebnis.",
  "notification.failed": "Mit einem Fehler gestoppt.",
  "notification.channelTitle": "{agent} in {channel}",
  "notification.teammateTitle": "{agent}: {teammate} braucht dich",
  "notification.channelMessage": "Hat eine Nachricht gesendet.",
  "notification.conversationTitle": "{author} in {conversation}",
  "notification.mentionedYou": "Hat dich erwähnt.",
  "notification.directMessage": "Hat dir eine Nachricht gesendet.",
  "notification.threadReply": "Hat in einem Thread geantwortet, dem du folgst.",
  "notification.newMessages": { one: "{count} neue Nachricht.", other: "{count} neue Nachrichten." },
  "notification.usageLimit.title": "Das {provider}-Konto hat sein Limit erreicht",
  "notification.usageLimit.body": {
    one: "{count} Agent wartet. Atelier versucht es später erneut.",
    other: "{count} Agenten warten. Atelier versucht es später erneut.",
  },
  "notification.usageLimit.bodyResets": {
    one: "{count} Agent wartet. Das Limit wird {reset} zurückgesetzt.",
    other: "{count} Agenten warten. Das Limit wird {reset} zurückgesetzt.",
  },
  "notification.test": "Benachrichtigungen funktionieren.",
  "notification.welcome": "Atelier informiert dich hier, wenn ein Agent dich braucht.",
  "notification.toast.region": "Benachrichtigungen",
  "notification.toast.close": "Benachrichtigung schließen",
  "notification.digest.title": { one: "{count} Update deiner Agenten", other: "{count} Updates deiner Agenten" },
  "notification.digest.fromOne": "Von {agent}.",
  "notification.digest.fromMany": { one: "Von {agent} und {count} weiteren.", other: "Von {agent} und {count} weiteren." },
} as const satisfies PartialTranslation<typeof source>;
