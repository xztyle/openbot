import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/sitePage";

export const messages = {
  "sitePage.error.title": "Nie można załadować tej strony",
  "sitePage.error.body": "Sprawdź połączenie i odśwież stronę. Jeśli nadal się nie ładuje, wróć do strony głównej.",
  "sitePage.error.reload": "Odśwież stronę",
  "sitePage.error.home": "Wróć na start",
  "sitePage.join.title": "Dołącz do serwera Atelier",
  "sitePage.join.description": "Otwórz prywatne zaproszenie do serwera w Atelier.",
  "sitePage.join.eyebrow": "Prywatne zaproszenie",
  "sitePage.join.intro":
    "Otwórz to zaproszenie w Atelier. Aplikacja sprawdzi serwer i poprosi o potwierdzenie przed połączeniem.",
  "sitePage.join.invalid":
    "Ten link z zaproszeniem jest nieprawidłowy lub niekompletny. Poproś właściciela serwera o nowe zaproszenie.",
  "sitePage.join.open": "Otwórz Atelier",
  "sitePage.join.browser": "Otwórz w przeglądarce",
  "sitePage.join.download": "Pobierz Atelier",
  "sitePage.join.notOpened":
    "Jeśli Atelier się nie otworzył, zainstaluj go przyciskiem {download} albo uruchom Atelier raz, aby mógł otwierać linki z zaproszeniami. Możesz też użyć przycisku {browser}.",
  "sitePage.join.mobile":
    "Jeśli Atelier jest zainstalowany, stuknij {open}. Możesz też wkleić ten link w Dodaj serwer w aplikacji.",
  "sitePage.join.singleUse":
    "Link jednorazowy działa raz, a potem wygasa. Link stały działa, dopóki właściciel go nie unieważni. Atelier pokazuje datę wygaśnięcia, zanim dołączysz.",
  "sitePage.join.email": "Jeśli zaproszenie przyszło e-mailem, zaloguj się do Atelier tym adresem e-mail.",
  "sitePage.join.share": "Ten link daje dostęp do serwera. Udostępniaj go tylko osobom, które chcesz zaprosić.",
  "sitePage.connect.title": "Wróć do Atelier",
  "sitePage.connect.failedTitle": "Połączenie nie zostało zakończone",
  "sitePage.connect.openApp": "Otwórz Atelier",
  "sitePage.connect.tryAgainApp": "Spróbuj w Atelier",
  "sitePage.connect.tryAgainBrowser": "Spróbuj w przeglądarce",
  "sitePage.connect.doneInWebClient": "Twoja karta Atelier kończy połączenie z {name}. Możesz zamknąć tę kartę.",
  "sitePage.connect.doneInApp": "Atelier kończy połączenie z {name} na Twoim komputerze.",
  "sitePage.connect.failure.cancelled": "Połączenie z {name} zostało anulowane. Nic się nie zmieniło.",
  "sitePage.connect.failure.expired": "Logowanie do {name} wygasło. Rozpocznij połączenie ponownie.",
  "sitePage.connect.failure.exchange": "{name} nie potwierdził połączenia. Spróbuj ponownie.",
  "sitePage.connect.failure.enterprise": "Połącz jeden obszar roboczy Slack, a nie całą organizację.",
  "sitePage.connect.failure.takenSlack":
    "Inny serwer Atelier już odpowiada w tym obszarze roboczym Slack. Odłącz go na tamtym serwerze, a potem spróbuj ponownie.",
  "sitePage.connect.failure.takenDiscord":
    "Inny serwer Atelier już odpowiada na tym serwerze Discord. Odłącz go na tamtym serwerze, a potem spróbuj ponownie.",
  "sitePage.connect.failure.unavailable": "Atelier nie może teraz połączyć się z {name}. Spróbuj później.",
  "sitePage.connect.failure.tabClosed":
    "Karta Atelier, która rozpoczęła połączenie z {name}, nie odpowiedziała. Otwórz Atelier w przeglądarce i ponownie połącz {name}.",
  "sitePage.connect.failure.failed": "{name} nie zakończył połączenia. Spróbuj ponownie.",
  "sitePage.connect.restartHint":
    "W Atelier otwórz {serverSettings}, potem {connectors}, potem {name} i wybierz {connect}.",
  "sitePage.connect.notOpened":
    "Uruchom Atelier, a potem spróbuj ponownie. Jeśli Atelier nie jest zainstalowany na tym komputerze, pobierz go i połącz {name} w aplikacji.",
  "sitePage.openApp.title": "Nic się nie otworzyło?",
  "sitePage.openApp.dismiss": "Nie teraz",
  "sitePage.billing.pageTitle": "Płatności Atelier",
  "sitePage.billing.updatedTitle": "Płatności zaktualizowane",
  "sitePage.billing.updatedBody": "Wróć do Atelier. Możesz zamknąć tę stronę.",
  "sitePage.billing.cancelledTitle": "Płatność anulowana",
  "sitePage.billing.cancelledBody": "Nic nie zostało pobrane. Wróć do Atelier.",
  "sitePage.report.pageTitle": "Zgłoś hostowaną stronę — Atelier",
  "sitePage.report.title": "Zgłoś hostowaną stronę",
  "sitePage.report.intro": "Wyślij zgłoszenie o szkodliwych lub nielegalnych treściach pod adresem openbot.site.",
  "sitePage.report.hostnameLabel": "Adres strony",
  "sitePage.report.hostnameMissing": "Wpisz adres strony",
  "sitePage.report.reasonLabel": "Powód",
  "sitePage.report.reason.phishing": "Phishing",
  "sitePage.report.reason.malware": "Złośliwe oprogramowanie",
  "sitePage.report.reason.abuse": "Nadużycie",
  "sitePage.report.reason.copyright": "Prawa autorskie",
  "sitePage.report.reason.other": "Inne",
  "sitePage.report.detailsLabel": "Szczegóły",
  "sitePage.report.optional": "Opcjonalnie",
  "sitePage.report.detailsPlaceholder": "Co jest nie tak z tą stroną?",
  "sitePage.report.send": "Wyślij zgłoszenie",
  "sitePage.report.sending": "Wysyłanie…",
  "sitePage.report.tooMany": "Za dużo zgłoszeń. Spróbuj później.",
  "sitePage.report.sendFailed": "Nie można wysłać zgłoszenia. Spróbuj ponownie.",
  "sitePage.report.writeTo": "Możesz też napisać na {email}.",
  "sitePage.report.sentTitle": "Zgłoszenie wysłane",
  "sitePage.report.sentBody": "Dziękujemy. Otrzymaliśmy Twoje zgłoszenie.",
  "sitePage.report.home": "Przejdź do strony głównej",
} as const satisfies PartialTranslation<typeof source>;
