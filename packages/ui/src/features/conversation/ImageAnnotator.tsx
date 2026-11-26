import type { AppTextKey } from "@openbot/i18n";
import {
  Button,
  Check,
  Circle,
  Crop,
  Dialog,
  Download,
  EyeOff,
  Hand,
  Input,
  MoveUpRight,
  Pencil,
  Redo2,
  Send,
  Spinner,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, onSettled, Show, untrack } from "solid-js";
import { useText } from "../../text";
import {
  ANNOTATOR_INKS,
  ANNOTATOR_MAX_ZOOM,
  ANNOTATOR_SHORTCUTS,
  type AnnotatorInkId,
  type AnnotatorPoint,
  type AnnotatorRect,
  type AnnotatorScene,
  type AnnotatorShape,
  type AnnotatorTool,
  annotatedFileName,
  canvasSizeFor,
  clampPoint,
  clampRect,
  decodeImage,
  drawScene,
  EMPTY_SCENE,
  exportMimeType,
  exportScene,
  extendPen,
  rectBetween,
  shapeIsVisible,
  strokeWidthFor,
  textSizeFor,
} from "./image-annotator-model";
import type { Camera } from "./ZoomControls";

/** The image the annotator opens: its name, its type, and a way to read its bytes. */
export interface ImageAnnotatorSource {
  name: string;
  mimeType: string;
  load(): Promise<Blob>;
}

export interface ImageAnnotatorProps {
  source: ImageAnnotatorSource;
  /**
   * Puts the annotated image in the message box. Absent, the annotator offers Save only. A rejection
   * keeps the annotator open and shows the error.
   */
  onSend?: ((file: File) => Promise<void> | void) | undefined;
  /** `done` for an image that is in the message box already: the result takes its place. */
  sendLabel?: "send" | "done" | undefined;
  /** Saves the file. Absent, the browser downloads it. */
  onSave?: ((file: File) => Promise<void> | void) | undefined;
  onClose: () => void;
}

interface Tool {
  id: AnnotatorTool;
  label: AppTextKey;
  icon: () => JSX.Element;
}

const TOOLS: readonly Tool[] = [
  { id: "pen", label: "chat.annotate.tool.pen", icon: () => <Pencil aria-hidden="true" /> },
  { id: "arrow", label: "chat.annotate.tool.arrow", icon: () => <MoveUpRight aria-hidden="true" /> },
  { id: "rectangle", label: "chat.annotate.tool.rectangle", icon: () => <Square aria-hidden="true" /> },
  { id: "ellipse", label: "chat.annotate.tool.ellipse", icon: () => <Circle aria-hidden="true" /> },
  { id: "text", label: "chat.annotate.tool.text", icon: () => <Type aria-hidden="true" /> },
  { id: "blur", label: "chat.annotate.tool.blur", icon: () => <EyeOff aria-hidden="true" /> },
  { id: "crop", label: "chat.annotate.tool.crop", icon: () => <Crop aria-hidden="true" /> },
  { id: "move", label: "chat.annotate.tool.move", icon: () => <Hand aria-hidden="true" /> },
];

const INK_LABEL = {
  red: "chat.annotate.ink.red",
  orange: "chat.annotate.ink.orange",
  yellow: "chat.annotate.ink.yellow",
  green: "chat.annotate.ink.green",
  blue: "chat.annotate.ink.blue",
  white: "chat.annotate.ink.white",
  black: "chat.annotate.ink.black",
} as const satisfies Record<AnnotatorInkId, AppTextKey>;

/** The key of a tool's shortcut, for its tooltip. */
function shortcutOf(tool: AnnotatorTool): string {
  const found = Object.entries(ANNOTATOR_SHORTCUTS).find(([, candidate]) => candidate === tool);
  return found ? found[0].toUpperCase() : "";
}

const FIT: Camera = { x: 0, y: 0, scale: 1 };
/** How fast Ctrl and the wheel zoom, per pixel of wheel movement. */
const WHEEL_ZOOM_RATE = 0.01;

type Phase = { status: "loading" } | { status: "ready" } | { status: "failed"; message: string };

/**
 * A quick editor over an image: pen, arrow, rectangle, ellipse, text, a blur that hides private
 * details, and a crop. One finger draws; two zoom and pan. The result goes to the message box or
 * downloads; the original is never changed.
 */
export function ImageAnnotator(props: ImageAnnotatorProps) {
  const { t, errorMessage } = useText();
  const [phase, setPhase] = createSignal<Phase>({ status: "loading" });
  let image: CanvasImageSource | undefined;
  let size = { width: 1, height: 1 };
  const [canvasSize, setCanvasSize] = createSignal({ width: 1, height: 1 });
  const [fitted, setFitted] = createSignal({ width: 0, height: 0 });
  const [tool, setTool] = createSignal<AnnotatorTool>("pen");
  const [ink, setInk] = createSignal<AnnotatorInkId>("red");
  // The scene is replaced whole on every change, so the history can hold the earlier ones.
  const [scene, setScene] = createSignal<AnnotatorScene>(EMPTY_SCENE);
  const [past, setPast] = createSignal<readonly AnnotatorScene[]>([]);
  const [future, setFuture] = createSignal<readonly AnnotatorScene[]>([]);
  const [textEntry, setTextEntry] = createSignal<{ at: AnnotatorPoint; value: string } | null>(null);
  const [busy, setBusy] = createSignal<"send" | "save" | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [zoomed, setZoomed] = createSignal(false);

  let stage: HTMLDivElement | undefined;
  let frame: HTMLDivElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let textInput: HTMLInputElement | undefined;
  // What a finger draws now. It is not reactive: the canvas redraws from it on each frame.
  let pending: AnnotatorShape | null = null;
  let pendingCrop: AnnotatorRect | null = null;
  let drawing: { pointerId: number; start: AnnotatorPoint } | undefined;
  let camera: Camera = FIT;
  const pointers = new Map<number, AnnotatorPoint>();
  let gesture: { camera: Camera; point: AnnotatorPoint; distance: number } | undefined;
  let spaceHeld = false;
  let animationFrame = 0;

  const inkValue = () => ANNOTATOR_INKS.find((entry) => entry.id === ink())?.value ?? ANNOTATOR_INKS[0].value;
  const strokeWidth = () => strokeWidthFor(size.width, size.height);
  const textSize = () => textSizeFor(size.width, size.height);
  const hasContent = () => scene().shapes.length > 0 || scene().crop !== null;
  const failure = () => {
    const current = phase();
    return current.status === "failed" ? current : undefined;
  };

  const requestDraw = () => {
    if (animationFrame) return;
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = 0;
      const context = canvas?.getContext("2d");
      if (!context || !image) return;
      drawScene(context, image, scene(), pending, pendingCrop);
    });
  };
  createEffect(
    () => scene(),
    () => requestDraw(),
  );

  const commit = (next: AnnotatorScene) => {
    setPast((history) => [...history, scene()]);
    setFuture([]);
    setScene(next);
  };
  const addShape = (shape: AnnotatorShape) => commit({ ...scene(), shapes: [...scene().shapes, shape] });
  const undo = () => {
    const previous = past().at(-1);
    if (!previous) return;
    setPast((history) => history.slice(0, -1));
    setFuture((ahead) => [scene(), ...ahead]);
    setScene(previous);
  };
  const redo = () => {
    const next = future()[0];
    if (!next) return;
    setFuture((ahead) => ahead.slice(1));
    setPast((history) => [...history, scene()]);
    setScene(next);
  };
  const clear = () => {
    if (hasContent()) commit(EMPTY_SCENE);
  };

  /** The fitted size of the canvas inside the stage. */
  const fitImage = () => {
    if (!stage) return;
    const room = { width: stage.clientWidth, height: stage.clientHeight };
    const scale = Math.min(room.width / size.width, room.height / size.height, 1e9);
    setFitted({ width: Math.max(1, size.width * scale), height: Math.max(1, size.height * scale) });
    move(camera);
  };

  /** The image stays within the stage: a zoomed image keeps its edges outside, a fitted one is centred. */
  const settled = (from: Camera): Camera => {
    const scale = Math.min(Math.max(from.scale, 1), ANNOTATOR_MAX_ZOOM);
    const axis = (position: number, length: number, room: number) => {
      const slack = Math.max(0, (length * scale - room) / 2);
      return Math.min(Math.max(position, -slack), slack);
    };
    return {
      scale,
      x: axis(from.x, fitted().width, stage?.clientWidth ?? 0),
      y: axis(from.y, fitted().height, stage?.clientHeight ?? 0),
    };
  };
  const move = (next: Camera) => {
    camera = settled(next);
    setZoomed(camera.scale > 1.001);
    if (frame) frame.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  };
  const zoomAround = (from: Camera, point: AnnotatorPoint, scale: number): Camera => {
    const next = Math.min(Math.max(scale, 1), ANNOTATOR_MAX_ZOOM);
    return {
      scale: next,
      x: point.x - ((point.x - from.x) * next) / from.scale,
      y: point.y - ((point.y - from.y) * next) / from.scale,
    };
  };
  /** A window point from the centre of the stage, where the fitted image is centred. */
  const stagePoint = (event: { clientX: number; clientY: number }): AnnotatorPoint => {
    const rect = stage?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  /** A window point in image pixels, through the zoom. */
  const imagePoint = (event: { clientX: number; clientY: number }): AnnotatorPoint => {
    const rect = canvas?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return { x: 0, y: 0 };
    return clampPoint(
      {
        x: ((event.clientX - rect.left) / rect.width) * size.width,
        y: ((event.clientY - rect.top) / rect.height) * size.height,
      },
      size.width,
      size.height,
    );
  };

  const startGesture = () => {
    const [first, second] = [...pointers.values()];
    gesture = first
      ? {
          camera,
          point: second ? { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } : first,
          distance: second ? Math.hypot(second.x - first.x, second.y - first.y) : 0,
        }
      : undefined;
  };
  const cancelDrawing = () => {
    drawing = undefined;
    pending = null;
    pendingCrop = null;
    requestDraw();
  };

  const commitText = () => {
    const entry = textEntry();
    if (!entry) return;
    const text = entry.value.trim();
    if (text) addShape({ kind: "text", at: entry.at, text, ink: inkValue(), size: textSize() });
    setTextEntry(null);
  };

  const beginShape = (start: AnnotatorPoint) => {
    const current = tool();
    const width = strokeWidth();
    const color = inkValue();
    switch (current) {
      case "pen":
        pending = { kind: "pen", points: [start], ink: color, width };
        break;
      case "arrow":
        pending = { kind: "arrow", from: start, to: start, ink: color, width };
        break;
      case "rectangle":
      case "ellipse":
        pending = { kind: current, rect: rectBetween(start, start), ink: color, width };
        break;
      case "blur":
        pending = { kind: "blur", rect: rectBetween(start, start) };
        break;
      case "crop":
        pendingCrop = rectBetween(start, start);
        break;
      default:
        break;
    }
  };
  const extendShape = (start: AnnotatorPoint, point: AnnotatorPoint) => {
    if (pendingCrop) pendingCrop = clampRect(rectBetween(start, point), size.width, size.height);
    else if (!pending) return;
    else if (pending.kind === "pen") pending = { ...pending, points: extendPen(pending.points, point) };
    else if (pending.kind === "arrow") pending = { ...pending, to: point };
    else if (pending.kind !== "text") pending = { ...pending, rect: rectBetween(start, point) };
    requestDraw();
  };
  const finishShape = () => {
    if (pendingCrop) {
      if (pendingCrop.width >= 8 && pendingCrop.height >= 8) commit({ ...scene(), crop: pendingCrop });
    } else if (pending && shapeIsVisible(pending)) addShape(pending);
    cancelDrawing();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.target instanceof Element && event.target.closest("button, input, textarea")) return;
    if (phase().status !== "ready") return;
    event.preventDefault();
    pointers.set(event.pointerId, stagePoint(event));
    stage?.setPointerCapture(event.pointerId);
    if (pointers.size >= 2) {
      // A second finger turns a stroke into a pinch: the stroke goes away.
      cancelDrawing();
      startGesture();
      return;
    }
    if (tool() === "move" || event.button === 1 || spaceHeld) {
      startGesture();
      return;
    }
    if (textEntry()) {
      // A tap outside the label places it; the next tap draws.
      commitText();
      return;
    }
    const start = imagePoint(event);
    if (tool() === "text") {
      setTextEntry({ at: start, value: "" });
      return;
    }
    drawing = { pointerId: event.pointerId, start };
    beginShape(start);
    requestDraw();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, stagePoint(event));
    if (gesture) {
      const [first, second] = [...pointers.values()];
      if (!first) return;
      const point = second ? { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } : first;
      const from =
        second && gesture.distance
          ? zoomAround(
              gesture.camera,
              gesture.point,
              (gesture.camera.scale * Math.hypot(second.x - first.x, second.y - first.y)) / gesture.distance,
            )
          : gesture.camera;
      move({ ...from, x: from.x + point.x - gesture.point.x, y: from.y + point.y - gesture.point.y });
      return;
    }
    if (drawing?.pointerId === event.pointerId) extendShape(drawing.start, imagePoint(event));
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    if (drawing?.pointerId === event.pointerId) finishShape();
    if (gesture) {
      if (pointers.size > 0) startGesture();
      else gesture = undefined;
    }
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      move(zoomAround(camera, stagePoint(event), camera.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE)));
      return;
    }
    if (!zoomed()) return;
    const sideways = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
    const down = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
    move({ ...camera, x: camera.x - sideways, y: camera.y - down });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const inText = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "z" && !inText) {
        if (event.shiftKey) redo();
        else undo();
        event.preventDefault();
      } else if (key === "y" && !inText) {
        redo();
        event.preventDefault();
      }
      return;
    }
    if (inText || event.altKey) return;
    if (event.key === " ") {
      spaceHeld = true;
      event.preventDefault();
      return;
    }
    const picked = ANNOTATOR_SHORTCUTS[event.key.toLowerCase()];
    if (picked) {
      setTool(picked);
      event.preventDefault();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === " ") spaceHeld = false;
  };
  /** Escape ends a label or a stroke first; with nothing open, it closes the annotator. */
  const onEscape = (event: KeyboardEvent) => {
    if (textEntry()) {
      setTextEntry(null);
      event.preventDefault();
    } else if (drawing || gesture) {
      cancelDrawing();
      gesture = undefined;
      pointers.clear();
      event.preventDefault();
    }
  };

  const output = async (): Promise<File> => {
    if (!image) throw new Error(t("chat.annotate.failed"));
    const mimeType = exportMimeType(props.source.mimeType);
    return exportScene(
      image,
      size,
      scene(),
      annotatedFileName(props.source.name, t("chat.annotate.fileSuffix"), mimeType),
      mimeType,
    );
  };
  const send = async () => {
    const deliver = props.onSend;
    if (!deliver || busy()) return;
    commitText();
    setBusy("send");
    setError(null);
    try {
      await deliver(await output());
      props.onClose();
    } catch (cause) {
      setError(errorMessage(cause, t("chat.annotate.sendFailed")));
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    if (busy()) return;
    commitText();
    setBusy("save");
    setError(null);
    try {
      const file = await output();
      if (props.onSave) await props.onSave(file);
      else {
        const url = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.rel = "noopener";
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    } catch (cause) {
      setError(errorMessage(cause, t("chat.annotate.saveFailed")));
    } finally {
      setBusy(null);
    }
  };

  onSettled(() => {
    let live = true;
    void untrack(() => props.source)
      .load()
      .then(decodeImage)
      .then((decoded) => {
        if (!live) return;
        image = decoded.image;
        size = canvasSizeFor(decoded.width, decoded.height);
        setCanvasSize(size);
        setPhase({ status: "ready" });
        fitImage();
        requestDraw();
      })
      .catch((cause: unknown) => {
        if (live) setPhase({ status: "failed", message: errorMessage(cause, t("chat.annotate.failed")) });
      });
    const area = stage;
    const observer = area ? new ResizeObserver(() => fitImage()) : undefined;
    if (area && observer) observer.observe(area);
    area?.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    return () => {
      live = false;
      observer?.disconnect();
      area?.removeEventListener("wheel", onWheel);
      window.removeEventListener("keyup", onKeyUp);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      if (image && "close" in image && typeof image.close === "function") image.close();
    };
  });
  // The label field takes the focus as it opens, so a phone shows its keyboard at once.
  createEffect(
    () => textEntry() !== null,
    (open) => {
      if (open) window.requestAnimationFrame(() => textInput?.focus());
    },
  );

  const sendLabel = () => (props.sendLabel === "done" ? t("common.done") : t("chat.annotate.send"));
  const textEntryStyle = () => {
    const entry = textEntry();
    const scale = fitted().width / size.width;
    return {
      left: `${(entry?.at.x ?? 0) * scale}px`,
      top: `${(entry?.at.y ?? 0) * scale}px`,
      "--annotator-label-size": `${Math.max(14, textSize() * scale)}px`,
      "--annotator-ink": inkValue(),
    };
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="image-annotator-backdrop" />
        <Dialog.Content
          class="image-annotator"
          data-dialog-surface="unstyled"
          data-tool={tool()}
          data-zoomed={zoomed() ? "" : undefined}
          onKeyDown={onKeyDown}
          onEscapeKeyDown={onEscape}
        >
          <Dialog.Title class="sr-only">{t("chat.annotate.title")}</Dialog.Title>
          <header class="image-annotator-header">
            <span class="image-annotator-name" title={props.source.name}>
              {props.source.name}
            </span>
            <div class="image-annotator-history" role="toolbar" aria-label={t("chat.annotate.history")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                class="image-annotator-action"
                aria-label={t("common.undo")}
                title={t("chat.annotate.withShortcut", { label: t("common.undo"), key: "⌘Z" })}
                disabled={past().length === 0}
                onClick={undo}
              >
                <Undo2 aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                class="image-annotator-action"
                aria-label={t("chat.annotate.redo")}
                title={t("chat.annotate.withShortcut", { label: t("chat.annotate.redo"), key: "⇧⌘Z" })}
                disabled={future().length === 0}
                onClick={redo}
              >
                <Redo2 aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                class="image-annotator-action"
                aria-label={t("chat.annotate.clear")}
                title={t("chat.annotate.clear")}
                disabled={!hasContent()}
                onClick={clear}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              class="image-annotator-action"
              aria-label={t("common.close")}
              title={t("common.close")}
              data-cuelume-tap="close"
              onClick={() => props.onClose()}
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          <div
            ref={(element) => (stage = element)}
            class="image-annotator-stage"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <Show when={phase().status === "loading"}>
              <div class="image-annotator-wait" role="status">
                <Spinner size="sm" />
                <span>{t("chat.annotate.loading")}</span>
              </div>
            </Show>
            <Show when={failure()}>
              {(failed) => (
                <div class="image-annotator-wait" role="alert">
                  <span>{failed().message}</span>
                  <Button type="button" variant="outline" onClick={() => props.onClose()}>
                    {t("common.close")}
                  </Button>
                </div>
              )}
            </Show>
            <div
              ref={(element) => (frame = element)}
              class="image-annotator-frame"
              style={{
                width: `${fitted().width}px`,
                height: `${fitted().height}px`,
                visibility: phase().status === "ready" ? "visible" : "hidden",
              }}
            >
              <canvas
                ref={(element) => (canvas = element)}
                class="image-annotator-canvas"
                width={canvasSize().width}
                height={canvasSize().height}
                role="img"
                aria-label={t("chat.annotate.canvas", { name: props.source.name })}
              />
              <Show when={textEntry()}>
                {(entry) => (
                  <div class="image-annotator-label" style={textEntryStyle()}>
                    <Input
                      ref={(element) => (textInput = element)}
                      class="image-annotator-label-input"
                      type="text"
                      value={entry().value}
                      placeholder={t("chat.annotate.textPlaceholder")}
                      aria-label={t("chat.annotate.tool.text")}
                      autocomplete="off"
                      onInput={(event) => setTextEntry({ at: entry().at, value: event.currentTarget.value })}
                      onKeyDown={(event: KeyboardEvent) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitText();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setTextEntry(null);
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="default"
                      size="icon-sm"
                      aria-label={t("chat.annotate.textDone")}
                      title={t("chat.annotate.textDone")}
                      onClick={commitText}
                    >
                      <Check aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </Show>
            </div>
          </div>
          <Show when={error()}>
            {(message) => (
              <p class="image-annotator-note" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <div class="image-annotator-toolbar">
            <div class="image-annotator-tools" role="toolbar" aria-label={t("chat.annotate.tools")}>
              <For each={TOOLS}>
                {(entry) => (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    class="image-annotator-tool"
                    aria-label={t(entry.label)}
                    aria-pressed={tool() === entry.id ? "true" : "false"}
                    title={t("chat.annotate.withShortcut", { label: t(entry.label), key: shortcutOf(entry.id) })}
                    disabled={phase().status !== "ready"}
                    onClick={() => {
                      commitText();
                      setTool(entry.id);
                    }}
                  >
                    {entry.icon()}
                  </Button>
                )}
              </For>
            </div>
            <div class="image-annotator-inks" role="toolbar" aria-label={t("chat.annotate.inks")}>
              <For each={ANNOTATOR_INKS}>
                {(entry) => (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    class="image-annotator-ink"
                    style={{ "--annotator-ink": entry.value }}
                    aria-label={t(INK_LABEL[entry.id])}
                    aria-pressed={ink() === entry.id ? "true" : "false"}
                    title={t(INK_LABEL[entry.id])}
                    onClick={() => setInk(entry.id)}
                  >
                    <span class="image-annotator-ink-dot" aria-hidden="true" />
                  </Button>
                )}
              </For>
            </div>
            <div class="image-annotator-actions">
              <Button
                type="button"
                variant="outline"
                class="image-annotator-save"
                disabled={phase().status !== "ready" || busy() === "send"}
                loading={busy() === "save"}
                loadingLabel={t("common.save")}
                onClick={() => void save()}
              >
                <Download aria-hidden="true" />
                {t("common.save")}
              </Button>
              <Show when={props.onSend}>
                <Button
                  type="button"
                  variant="default"
                  class="image-annotator-send"
                  disabled={phase().status !== "ready" || busy() === "save"}
                  loading={busy() === "send"}
                  loadingLabel={sendLabel()}
                  onClick={() => void send()}
                >
                  <Send aria-hidden="true" />
                  {sendLabel()}
                </Button>
              </Show>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
