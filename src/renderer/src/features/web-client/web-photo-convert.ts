import { MOBILE_ATTACHMENT_BYTES } from "@openbot/team-client/remote-peer";

/** The photo formats of an iPhone. The host does not take them; a browser that can draw them makes a JPEG. */
const PHOTO_NAME = /\.(?:heic|heif)$/iu;
const PHOTO_TYPES: ReadonlySet<string> = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);
const JPEG_QUALITY = 0.9;
/** A JPEG that is still over the upload limit is drawn again with its long side at this size. */
const SMALLER_SIDE = 4032;
/** Safari on an iPhone draws nothing on a larger canvas, so a 48 MP photo is drawn smaller. */
const CANVAS_PIXELS = 16_000_000;

export function isIphonePhoto(file: File): boolean {
  return PHOTO_NAME.test(file.name) || PHOTO_TYPES.has(file.type.toLowerCase());
}

/**
 * An iPhone photo as a JPEG, as Safari makes one when a photo comes from the photo library. A photo
 * picked in the Files app, or dropped from a Mac, comes as HEIC, which the host refuses. Safari draws
 * HEIC, so the photo goes up as a JPEG with the same name. A browser that cannot draw it, or any
 * other file, gives the file back as it is, and the upload plan names it as a type the host refuses.
 */
export async function convertIphonePhotos(files: readonly File[]): Promise<File[]> {
  const converted: File[] = [];
  // One at a time: a phone has little memory for several full-size canvases.
  for (const file of files) converted.push(isIphonePhoto(file) ? await asJpeg(file).catch(() => file) : file);
  return converted;
}

async function asJpeg(file: File): Promise<File> {
  const image = await decoded(file);
  try {
    const scale = Math.min(1, Math.sqrt(CANVAS_PIXELS / (image.naturalWidth * image.naturalHeight)));
    let blob = await draw(image, scale);
    const longSide = Math.max(image.naturalWidth, image.naturalHeight) * scale;
    if (blob.size > MOBILE_ATTACHMENT_BYTES && longSide > SMALLER_SIDE)
      blob = await draw(image, (scale * SMALLER_SIDE) / longSide);
    const name = PHOTO_NAME.test(file.name) ? file.name.replace(PHOTO_NAME, ".jpeg") : `${file.name}.jpeg`;
    return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
  } finally {
    URL.revokeObjectURL(image.src);
  }
}

/** An image element draws the photo the right way up: it reads the orientation in the file. */
async function decoded(file: File): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = URL.createObjectURL(file);
  try {
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(image.src);
    throw error;
  }
  if (!image.naturalWidth || !image.naturalHeight) {
    URL.revokeObjectURL(image.src);
    throw new Error("The photo has no size.");
  }
  return image;
}

function draw(image: HTMLImageElement, scale: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("No canvas."));
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("No JPEG."))), "image/jpeg", JPEG_QUALITY),
  );
}
