import { currentText } from "@openbot/ui/text";

/**
 * Writes text to the clipboard. When the async clipboard is missing or refuses the write, such as
 * when the document has no focus, a hidden text area and the copy command are used. Throws when
 * both fail.
 */
export async function writeClipboardText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // The copy command below is the fallback.
  }
  // Inside the open dialog, if there is one: a modal traps the focus, and a text area outside it would
  // make the trap pull the focus back, which moves the focus ring.
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = previous?.closest<HTMLElement>("[role='dialog']") ?? document.body;
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  host.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error(currentText().t("app.clipboard.copyFailed"));
  } finally {
    input.remove();
    previous?.focus({ preventScroll: true });
  }
}

/**
 * Writes text that is still on its way, such as a secret the host reads first. Safari lets a page
 * write the clipboard only in the tap that asked for it, and a network read in between ends that
 * tap: a `ClipboardItem` made in the tap with the pending text keeps it. Without one, the text is
 * awaited and written as {@link writeClipboardText} does. A failure of `text` is thrown as it is.
 */
export async function writeClipboardTextLater(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) }),
      ]);
      return;
    } catch {
      // A refused write falls back below; a failed read is thrown again there.
    }
  }
  await writeClipboardText(await text);
}
