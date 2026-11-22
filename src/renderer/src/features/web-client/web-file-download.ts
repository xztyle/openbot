import { onCleanup } from "solid-js";

/**
 * How long a saved file's object URL stays valid. Safari reads the file some time after the click
 * returns, and asks first on an iPhone, so the URL outlives the click by a good margin. After that
 * it is revoked, so the bytes of every file saved in a session do not stay in a phone's memory.
 */
export const SAVED_FILE_URL_MS = 60_000;

/**
 * Saves a file that the host sent, with a link click. Each object URL is revoked a minute after its
 * click, or when the owner is disposed.
 */
export function createWebFileSaver(): (file: { name: string; base64: string }) => void {
  const urls = new Map<string, ReturnType<typeof setTimeout>>();
  onCleanup(() => {
    for (const [url, timer] of urls) {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    urls.clear();
  });
  return (file) => {
    const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    urls.set(
      url,
      setTimeout(() => {
        urls.delete(url);
        URL.revokeObjectURL(url);
      }, SAVED_FILE_URL_MS),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
  };
}
