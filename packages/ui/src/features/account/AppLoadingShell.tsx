import { useText } from "../../text";

/**
 * The background of the app loading screen, without the crew. The server sends it: the crew's faces
 * watch their size and the reader's motion setting in the browser, so the Worker does not import
 * `AppLoadingScreen`.
 */
export function AppLoadingShell() {
  const { t } = useText();
  return (
    <main class="app-loading" role="status" aria-live="polite" aria-busy="true">
      <span class="sr-only">{t("webClient.loading")}</span>
    </main>
  );
}
