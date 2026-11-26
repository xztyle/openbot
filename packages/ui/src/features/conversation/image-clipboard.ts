/**
 * Puts an image on the clipboard from the image viewer, the context menu of an image and, later, the
 * image editor. One path for the desktop app, the web client and the phone: the browser's clipboard.
 */

/** Whether this browser can put an image on the clipboard. */
export function canCopyImage(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/**
 * The image as PNG, which every browser accepts on the clipboard. A JPEG, a WebP or an SVG is drawn
 * again through an image element, which decodes every kind the page can show.
 */
async function pngOf(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image ${response.status}`);
  const blob = await response.blob();
  if (blob.type === "image/png") return blob;
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("no png"))), "image/png"),
  );
}

/**
 * Reads the image at `url` and puts it on the clipboard as PNG. Throws when the image cannot be read or
 * the clipboard refuses. Safari lets a page write the clipboard only in the tap that asked for it, so
 * the `ClipboardItem` is made at once with the pending image.
 */
export async function copyImageToClipboard(url: string): Promise<void> {
  if (!canCopyImage()) throw new Error("no clipboard");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": pngOf(url) })]);
}
