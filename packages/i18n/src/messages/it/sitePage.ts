import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/sitePage";

export const messages = {
  "sitePage.error.title": "Impossibile caricare questa pagina",
  "sitePage.error.body":
    "Controlla la connessione e ricarica la pagina. Se ancora non si carica, torna alla pagina iniziale.",
  "sitePage.error.reload": "Ricarica pagina",
  "sitePage.error.home": "Torna alla home",
  "sitePage.join.title": "Unisciti a un server Atelier",
  "sitePage.join.description": "Apri un invito privato a un server in Atelier.",
  "sitePage.join.eyebrow": "Invito privato",
  "sitePage.join.intro":
    "Apri questo invito in Atelier. L’app controlla il server e ti chiede di confermare prima di connettersi.",
  "sitePage.join.invalid":
    "Questo link di invito non è valido o non è completo. Chiedi un nuovo invito al proprietario del server.",
  "sitePage.join.open": "Apri Atelier",
  "sitePage.join.browser": "Apri nel browser",
  "sitePage.join.download": "Scarica Atelier",
  "sitePage.join.notOpened":
    "Se Atelier non si è aperto, installalo con {download}, oppure avvia Atelier una volta perché possa aprire i link di invito. Puoi anche usare {browser}.",
  "sitePage.join.mobile":
    "Se Atelier è installato, tocca {open}. Puoi anche incollare questo link in Aggiungi server nell’app.",
  "sitePage.join.singleUse":
    "Un link monouso funziona una volta e poi scade. Un link permanente funziona finché il proprietario non lo revoca. Atelier mostra la scadenza prima che tu entri.",
  "sitePage.join.email": "Se l’invito è arrivato via email, accedi a Atelier con quell’indirizzo email.",
  "sitePage.join.share": "Questo link dà accesso a un server. Condividilo solo con le persone che vuoi invitare.",
  "sitePage.connect.title": "Torna a Atelier",
  "sitePage.connect.failedTitle": "La connessione non è stata completata",
  "sitePage.connect.openApp": "Apri Atelier",
  "sitePage.connect.tryAgainApp": "Riprova in Atelier",
  "sitePage.connect.tryAgainBrowser": "Riprova nel browser",
  "sitePage.connect.doneInWebClient":
    "La tua scheda di Atelier completa la connessione a {name}. Puoi chiudere questa scheda.",
  "sitePage.connect.doneInApp": "Atelier completa la connessione a {name} sul tuo computer.",
  "sitePage.connect.failure.cancelled": "La connessione a {name} è stata annullata. Non è cambiato nulla.",
  "sitePage.connect.failure.expired": "L’accesso a {name} è scaduto. Avvia di nuovo la connessione.",
  "sitePage.connect.failure.exchange": "{name} non ha confermato la connessione. Riprova.",
  "sitePage.connect.failure.enterprise": "Connetti un workspace Slack, non un’intera organizzazione.",
  "sitePage.connect.failure.takenSlack":
    "Un altro server Atelier risponde già in questo workspace Slack. Disconnettilo su quel server, poi riprova.",
  "sitePage.connect.failure.takenDiscord":
    "Un altro server Atelier risponde già su questo server Discord. Disconnettilo su quel server, poi riprova.",
  "sitePage.connect.failure.unavailable": "Atelier non può connettersi a {name} ora. Riprova più tardi.",
  "sitePage.connect.failure.tabClosed":
    "La scheda di Atelier che ha avviato la connessione a {name} non ha risposto. Apri Atelier nel browser e connetti di nuovo {name}.",
  "sitePage.connect.failure.failed": "{name} non ha completato la connessione. Riprova.",
  "sitePage.connect.restartHint":
    "In Atelier, apri {serverSettings}, poi {connectors}, poi {name}, e seleziona {connect}.",
  "sitePage.connect.notOpened":
    "Avvia Atelier, poi riprova. Se Atelier non è su questo computer, scaricalo e connetti {name} dall’app.",
  "sitePage.openApp.title": "Non si è aperto nulla?",
  "sitePage.openApp.dismiss": "Non ora",
  "sitePage.billing.pageTitle": "Fatturazione Atelier",
  "sitePage.billing.updatedTitle": "Fatturazione aggiornata",
  "sitePage.billing.updatedBody": "Torna a Atelier. Puoi chiudere questa pagina.",
  "sitePage.billing.cancelledTitle": "Pagamento annullato",
  "sitePage.billing.cancelledBody": "Non è stato addebitato nulla. Torna a Atelier.",
  "sitePage.report.pageTitle": "Segnala un sito ospitato — Atelier",
  "sitePage.report.title": "Segnala un sito ospitato",
  "sitePage.report.intro": "Invia una segnalazione su contenuti dannosi o illeciti a un indirizzo openbot.site.",
  "sitePage.report.hostnameLabel": "Indirizzo del sito",
  "sitePage.report.hostnameMissing": "Inserisci l’indirizzo del sito",
  "sitePage.report.reasonLabel": "Motivo",
  "sitePage.report.reason.phishing": "Phishing",
  "sitePage.report.reason.malware": "Malware",
  "sitePage.report.reason.abuse": "Abuso",
  "sitePage.report.reason.copyright": "Copyright",
  "sitePage.report.reason.other": "Altro",
  "sitePage.report.detailsLabel": "Dettagli",
  "sitePage.report.optional": "Facoltativo",
  "sitePage.report.detailsPlaceholder": "Qual è il problema di questo sito?",
  "sitePage.report.send": "Invia segnalazione",
  "sitePage.report.sending": "Invio…",
  "sitePage.report.tooMany": "Troppe segnalazioni. Riprova più tardi.",
  "sitePage.report.sendFailed": "Impossibile inviare la segnalazione. Riprova.",
  "sitePage.report.writeTo": "Puoi anche scrivere a {email}.",
  "sitePage.report.sentTitle": "Segnalazione inviata",
  "sitePage.report.sentBody": "Grazie. Abbiamo ricevuto la tua segnalazione.",
  "sitePage.report.home": "Vai alla pagina iniziale",
} as const satisfies PartialTranslation<typeof source>;
