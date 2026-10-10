import { currentText } from "@openbot/ui/text";

/** What `fetch` throws when the network is gone: Safari, Chrome and Firefox each use their own words. */
const NETWORK_FAILURE =
  /^(load failed|failed to fetch|networkerror when attempting to fetch resource|network request failed)\.?$/iu;
/** What an aborted request says. `AbortSignal.timeout` makes a `TimeoutError`; a directory read wraps it. */
const ABORTED = /^(signal is aborted|the operation was aborted|this operation was aborted|fetch is aborted)/iu;

/**
 * The reader's text for a request that failed because the network is gone or the service did not answer,
 * or null for any other failure. The browser's own words, such as "Load failed", mean nothing to a reader.
 */
export function webNetworkFailureMessage(error: unknown): string | null {
  const { t } = currentText();
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
    return t("webClient.error.timeout");
  if (!(error instanceof Error)) return null;
  if (NETWORK_FAILURE.test(error.message) || (error instanceof TypeError && !navigator.onLine))
    return t("webClient.error.offline");
  if (ABORTED.test(error.message)) return t("webClient.error.timeout");
  return null;
}
