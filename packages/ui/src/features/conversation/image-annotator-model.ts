/*
 * The drawing model of the image annotator: the shapes, the colours, and how a scene draws on a
 * canvas and exports as a file. No DOM events here; `ImageAnnotator.tsx` turns pointers into shapes.
 */

export type AnnotatorTool = "pen" | "arrow" | "rectangle" | "ellipse" | "text" | "blur" | "crop" | "move";

export interface AnnotatorPoint {
  x: number;
  y: number;
}

export interface AnnotatorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AnnotatorShape =
  | { kind: "pen"; points: AnnotatorPoint[]; ink: string; width: number }
  | { kind: "arrow"; from: AnnotatorPoint; to: AnnotatorPoint; ink: string; width: number }
  | { kind: "rectangle"; rect: AnnotatorRect; ink: string; width: number }
  | { kind: "ellipse"; rect: AnnotatorRect; ink: string; width: number }
  | { kind: "text"; at: AnnotatorPoint; text: string; ink: string; size: number }
  | { kind: "blur"; rect: AnnotatorRect };

/** What the reader drew and the part of the image they kept. */
export interface AnnotatorScene {
  shapes: AnnotatorShape[];
  crop: AnnotatorRect | null;
}

export const EMPTY_SCENE: AnnotatorScene = { shapes: [], crop: null };

/** The inks. The first is the default: it reads on a screenshot and on a photo alike. */
export const ANNOTATOR_INKS = [
  { id: "red", value: "#ff3b1f" },
  { id: "orange", value: "#ff9412" },
  { id: "yellow", value: "#ffd60a" },
  { id: "green", value: "#31cf76" },
  { id: "blue", value: "#007cf7" },
  { id: "white", value: "#ffffff" },
  { id: "black", value: "#141414" },
] as const;

export type AnnotatorInkId = (typeof ANNOTATOR_INKS)[number]["id"];

/** The one-key tool shortcuts on a computer, without a modifier. */
export const ANNOTATOR_SHORTCUTS: Readonly<Record<string, AnnotatorTool>> = {
  p: "pen",
  a: "arrow",
  r: "rectangle",
  e: "ellipse",
  t: "text",
  b: "blur",
  c: "crop",
  m: "move",
};

/** A canvas larger than this on a side would take too much memory on a phone; the image scales down. */
export const ANNOTATOR_MAX_SIDE = 4096;
/** The closest zoom shows each image pixel this many times larger than fitted. */
export const ANNOTATOR_MAX_ZOOM = 8;
/** A drag shorter than this, in image pixels, is a tap and makes no shape. */
const MIN_SHAPE_SIZE = 4;
/** A pen point closer than this to the one before is dropped, which smooths a shaky finger. */
const MIN_PEN_STEP = 2;
/** The dim over the part of the image outside the crop. */
const CROP_SHADE = "rgba(0, 0, 0, 0.55)";
const CROP_LINE = "rgba(255, 255, 255, 0.9)";
const BLUR_PENDING_LINE = "rgba(255, 255, 255, 0.85)";
const TEXT_OUTLINE_DARK = "rgba(0, 0, 0, 0.7)";
const TEXT_OUTLINE_LIGHT = "rgba(255, 255, 255, 0.85)";
const TEXT_FONT = '"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/** The size the canvas takes for an image: the natural size, scaled down past `ANNOTATOR_MAX_SIDE`. */
export function canvasSizeFor(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= ANNOTATOR_MAX_SIDE)
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const factor = ANNOTATOR_MAX_SIDE / longest;
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
}

/** A stroke as wide on a phone photo as on a screenshot: a share of the shorter side. */
export function strokeWidthFor(width: number, height: number): number {
  return Math.max(3, Math.round(Math.min(width, height) / 160));
}

/** A label that reads at the fitted size of any image. */
export function textSizeFor(width: number, height: number): number {
  return Math.max(18, Math.round(Math.min(width, height) / 22));
}

/** The side of one block of a pixelated area. */
function blurBlockFor(width: number, height: number): number {
  return Math.max(8, Math.round(Math.min(width, height) / 60));
}

export function rectBetween(from: AnnotatorPoint, to: AnnotatorPoint): AnnotatorRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** The rect inside the image. */
export function clampRect(rect: AnnotatorRect, width: number, height: number): AnnotatorRect {
  const x = Math.min(Math.max(rect.x, 0), width);
  const y = Math.min(Math.max(rect.y, 0), height);
  return {
    x,
    y,
    width: Math.min(Math.max(rect.x + rect.width, 0), width) - x,
    height: Math.min(Math.max(rect.y + rect.height, 0), height) - y,
  };
}

export function clampPoint(point: AnnotatorPoint, width: number, height: number): AnnotatorPoint {
  return { x: Math.min(Math.max(point.x, 0), width), y: Math.min(Math.max(point.y, 0), height) };
}

/** Whether a drag made a shape, or was a tap. */
export function shapeIsVisible(shape: AnnotatorShape): boolean {
  switch (shape.kind) {
    case "pen":
      return shape.points.length > 1;
    case "arrow":
      return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) >= MIN_SHAPE_SIZE;
    case "text":
      return shape.text.trim().length > 0;
    default:
      return shape.rect.width >= MIN_SHAPE_SIZE && shape.rect.height >= MIN_SHAPE_SIZE;
  }
}

/** Adds a pen point, unless it is too close to the last one. Returns the same array when it is. */
export function extendPen(points: AnnotatorPoint[], point: AnnotatorPoint): AnnotatorPoint[] {
  const last = points[points.length - 1];
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < MIN_PEN_STEP) return points;
  return [...points, point];
}

function roundedRectPath(ctx: CanvasRenderingContext2D, rect: AnnotatorRect, radius: number): void {
  const r = Math.min(radius, rect.width / 2, rect.height / 2);
  ctx.beginPath();
  ctx.moveTo(rect.x + r, rect.y);
  ctx.lineTo(rect.x + rect.width - r, rect.y);
  ctx.arcTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + r, r);
  ctx.lineTo(rect.x + rect.width, rect.y + rect.height - r);
  ctx.arcTo(rect.x + rect.width, rect.y + rect.height, rect.x + rect.width - r, rect.y + rect.height, r);
  ctx.lineTo(rect.x + r, rect.y + rect.height);
  ctx.arcTo(rect.x, rect.y + rect.height, rect.x, rect.y + rect.height - r, r);
  ctx.lineTo(rect.x, rect.y + r);
  ctx.arcTo(rect.x, rect.y, rect.x + r, rect.y, r);
  ctx.closePath();
}

/** A pen stroke through the midpoints of its points: a curve, not a polyline, so a finger reads as a line. */
function penPath(ctx: CanvasRenderingContext2D, points: AnnotatorPoint[]): void {
  const [first, ...rest] = points;
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  if (rest.length === 0) {
    ctx.lineTo(first.x, first.y);
    return;
  }
  let previous = first;
  for (const point of rest) {
    const middle = { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
    ctx.quadraticCurveTo(previous.x, previous.y, middle.x, middle.y);
    previous = point;
  }
  ctx.lineTo(previous.x, previous.y);
}

function drawArrow(ctx: CanvasRenderingContext2D, shape: Extract<AnnotatorShape, { kind: "arrow" }>): void {
  const angle = Math.atan2(shape.to.y - shape.from.y, shape.to.x - shape.from.x);
  const head = Math.max(shape.width * 4, 14);
  const shaftEnd = { x: shape.to.x - Math.cos(angle) * head * 0.6, y: shape.to.y - Math.sin(angle) * head * 0.6 };
  ctx.beginPath();
  ctx.moveTo(shape.from.x, shape.from.y);
  ctx.lineTo(shaftEnd.x, shaftEnd.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(shape.to.x, shape.to.y);
  ctx.lineTo(shape.to.x - Math.cos(angle - Math.PI / 6) * head, shape.to.y - Math.sin(angle - Math.PI / 6) * head);
  ctx.lineTo(shape.to.x - Math.cos(angle + Math.PI / 6) * head, shape.to.y - Math.sin(angle + Math.PI / 6) * head);
  ctx.closePath();
  ctx.fill();
}

function drawText(ctx: CanvasRenderingContext2D, shape: Extract<AnnotatorShape, { kind: "text" }>): void {
  ctx.font = `600 ${shape.size}px ${TEXT_FONT}`;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, shape.size / 7);
  ctx.strokeStyle = shape.ink === "#ffffff" || shape.ink === "#ffd60a" ? TEXT_OUTLINE_DARK : TEXT_OUTLINE_LIGHT;
  const lines = shape.text.split("\n");
  lines.forEach((line, index) => {
    const y = shape.at.y + index * shape.size * 1.25;
    ctx.strokeText(line, shape.at.x, y);
    ctx.fillStyle = shape.ink;
    ctx.fillText(line, shape.at.x, y);
  });
}

/** Pixelates what the canvas shows under `rect`, so a reader cannot make it out. */
function pixelate(ctx: CanvasRenderingContext2D, rect: AnnotatorRect, block: number): void {
  const area = clampRect(rect, ctx.canvas.width, ctx.canvas.height);
  if (area.width < 1 || area.height < 1) return;
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.ceil(area.width / block));
  small.height = Math.max(1, Math.ceil(area.height / block));
  const shrink = small.getContext("2d");
  if (!shrink) return;
  shrink.imageSmoothingEnabled = true;
  shrink.drawImage(ctx.canvas, area.x, area.y, area.width, area.height, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, area.x, area.y, area.width, area.height);
  ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D, shape: AnnotatorShape, pending: boolean): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (shape.kind) {
    case "pen":
      ctx.strokeStyle = shape.ink;
      ctx.lineWidth = shape.width;
      penPath(ctx, shape.points);
      ctx.stroke();
      break;
    case "arrow":
      ctx.strokeStyle = shape.ink;
      ctx.fillStyle = shape.ink;
      ctx.lineWidth = shape.width;
      drawArrow(ctx, shape);
      break;
    case "rectangle":
      ctx.strokeStyle = shape.ink;
      ctx.lineWidth = shape.width;
      roundedRectPath(ctx, shape.rect, shape.width);
      ctx.stroke();
      break;
    case "ellipse":
      ctx.strokeStyle = shape.ink;
      ctx.lineWidth = shape.width;
      ctx.beginPath();
      ctx.ellipse(
        shape.rect.x + shape.rect.width / 2,
        shape.rect.y + shape.rect.height / 2,
        shape.rect.width / 2,
        shape.rect.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    case "text":
      drawText(ctx, shape);
      break;
    case "blur":
      if (pending) {
        // The area a finger is still choosing: an outline, and the pixels once it lifts.
        ctx.strokeStyle = BLUR_PENDING_LINE;
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(shape.rect.x, shape.rect.y, shape.rect.width, shape.rect.height);
      } else pixelate(ctx, shape.rect, blurBlockFor(ctx.canvas.width, ctx.canvas.height));
      break;
  }
  ctx.restore();
}

function drawCropShade(ctx: CanvasRenderingContext2D, crop: AnnotatorRect): void {
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.fillStyle = CROP_SHADE;
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(crop.x, crop.y + crop.height, crop.width, -crop.height);
  ctx.fill("evenodd");
  ctx.strokeStyle = CROP_LINE;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 6]);
  ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
  ctx.restore();
}

/**
 * Draws the image with the scene over it. The blurs come first and the strokes over them, so a
 * blur hides image content and never a mark. A crop shows as a shade outside its area; `exportScene`
 * cuts the image there.
 */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  scene: AnnotatorScene,
  pending: AnnotatorShape | null,
  pendingCrop: AnnotatorRect | null,
): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  for (const shape of scene.shapes) if (shape.kind === "blur") drawShape(ctx, shape, false);
  for (const shape of scene.shapes) if (shape.kind !== "blur") drawShape(ctx, shape, false);
  if (pending) drawShape(ctx, pending, true);
  const crop = pendingCrop ?? scene.crop;
  if (crop && crop.width > 0 && crop.height > 0) drawCropShade(ctx, crop);
}

/** The type the annotated file takes: a JPEG stays a JPEG, so a photo stays small; anything else is a PNG. */
export function exportMimeType(sourceType: string): "image/jpeg" | "image/png" {
  return sourceType === "image/jpeg" ? "image/jpeg" : "image/png";
}

/** `captura.png` with `anotada` becomes `captura-anotada.png`. The extension follows the type. */
export function annotatedFileName(name: string, suffix: string, mimeType: "image/jpeg" | "image/png"): string {
  const base = name.replace(/\.[^./\\]+$/u, "").trim() || "image";
  const extension = mimeType === "image/jpeg" ? "jpg" : "png";
  return `${base}-${suffix}.${extension}`;
}

/** Renders the scene into a file, cut to the crop. */
export async function exportScene(
  image: CanvasImageSource,
  size: { width: number; height: number },
  scene: AnnotatorScene,
  name: string,
  mimeType: "image/jpeg" | "image/png",
): Promise<File> {
  const full = document.createElement("canvas");
  full.width = size.width;
  full.height = size.height;
  const ctx = full.getContext("2d");
  if (!ctx) throw new Error("No canvas context.");
  drawScene(ctx, image, { shapes: scene.shapes, crop: null }, null, null);
  let output = full;
  const crop = scene.crop ? clampRect(scene.crop, size.width, size.height) : null;
  if (crop && crop.width >= 1 && crop.height >= 1) {
    const cut = document.createElement("canvas");
    cut.width = Math.round(crop.width);
    cut.height = Math.round(crop.height);
    cut.getContext("2d")?.drawImage(full, crop.x, crop.y, crop.width, crop.height, 0, 0, cut.width, cut.height);
    output = cut;
  }
  const blob = await new Promise<Blob | null>((done) => output.toBlob(done, mimeType, 0.92));
  if (!blob) throw new Error("The canvas made no image.");
  return new File([blob], name, { type: mimeType });
}

/** Reads a drawable image from its bytes. A type the browser cannot draw rejects. */
export async function decodeImage(blob: Blob): Promise<{ image: CanvasImageSource; width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { image: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // An SVG, which `createImageBitmap` refuses in some browsers, loads through an element below.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const element = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("The image did not decode."));
      img.src = url;
    });
    return { image: element, width: element.naturalWidth, height: element.naturalHeight };
  } finally {
    // The element keeps the decoded pixels; the URL is only needed to load them.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
