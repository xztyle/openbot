import { currentText } from "./text";
import { toast } from "./toast";

/**
 * Copies text from a button or a menu item that has no copied state of its own: the result is a
 * toast, so a refused clipboard is not silent.
 */
export function copyTextWithToast(text: string): void {
  const { t } = currentText();
  const write = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("no clipboard"));
  void write.then(
    () => toast.success(t("common.copied")),
    () => toast.error(t("app.clipboard.copyFailed")),
  );
}
