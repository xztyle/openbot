import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/notification";

export const messages = {
  "notification.needsInput": "Potrzebuje twojej odpowiedzi.",
  "notification.needsApproval": "Potrzebuje twojego zatwierdzenia.",
  "notification.needsBrowserStep": "Potrzebuje dokończenia kroku w przeglądarce.",
  "notification.needsApprovalFor": "Potrzebuje twojego zatwierdzenia: {action}",
  "notification.finished": "Zakończono pracę.",
  // A workflow step that waits for a person to approve or reject it.
  "notification.workflowApproval": "Krok czeka na Twoje zatwierdzenie.",
  // A workflow output step that tells the user its result.
  "notification.workflowOutput": "Przepływ pracy ma nowy wynik.",
  "notification.failed": "Zatrzymano z powodu błędu.",
  "notification.channelTitle": "{agent} w kanale {channel}",
  "notification.teammateTitle": "{agent}: {teammate} cię potrzebuje",
  "notification.channelMessage": "Nowa wiadomość.",
  "notification.conversationTitle": "{author} w {conversation}",
  "notification.mentionedYou": "Wspomniał(a) o Tobie.",
  "notification.directMessage": "Wysłał(a) Ci wiadomość.",
  "notification.threadReply": "Odpowiedział(a) w obserwowanym wątku.",
  "notification.newMessages": {
    one: "{count} nowa wiadomość.",
    few: "{count} nowe wiadomości.",
    many: "{count} nowych wiadomości.",
    other: "{count} nowej wiadomości.",
  },
  "notification.usageLimit.title": "Konto {provider} osiągnęło limit",
  "notification.usageLimit.body": {
    one: "{count} agent czeka. Atelier spróbuje ponownie później.",
    few: "{count} agentów czeka. Atelier spróbuje ponownie później.",
    many: "{count} agentów czeka. Atelier spróbuje ponownie później.",
    other: "{count} agenta czeka. Atelier spróbuje ponownie później.",
  },
  "notification.usageLimit.bodyResets": {
    one: "{count} agent czeka. Reset: {reset}.",
    few: "{count} agentów czeka. Reset: {reset}.",
    many: "{count} agentów czeka. Reset: {reset}.",
    other: "{count} agenta czeka. Reset: {reset}.",
  },
  "notification.test": "Powiadomienia działają.",
  "notification.welcome": "Atelier powiadomi cię tutaj, gdy agent będzie cię potrzebować.",
  "notification.toast.region": "Powiadomienia",
  "notification.toast.close": "Zamknij powiadomienie",
} as const satisfies PartialTranslation<typeof source>;
