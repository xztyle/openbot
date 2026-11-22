import { atelierFaceDefault, atelierSkinDefault, atelierSkinOf, atelierTheme } from "@openbot/brand/atelier-appearance";
import { agentFaceSVG, FACE_STYLES, type FaceState, type FaceStyle } from "@openbot/brand/faces";
import { createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import { documentColorScheme } from "../../document-color-scheme";
import { agentFaceEntry } from "./agent-face-directory";

export interface AgentFaceProps {
  /** The stable id of the face: the agent's avatar seed. It gives the hue and, without `faceSeed`, the person. */
  id: string;
  /** The agent's name and title: their role words choose the hat. */
  name?: string | undefined;
  title?: string | undefined;
  /** The agent's own family. Absent: the default of the workspace. */
  faceStyle?: string | undefined;
  /** A re-rolled face. Absent: the face of `id`. */
  faceSeed?: string | undefined;
  /** The agent's own skin tone, `1` to `8`. Absent: the workspace default. */
  faceSkin?: string | undefined;
  state?: FaceState | undefined;
  /** False: the end of work does not smile, as on a screen whose faces only act out a wait. */
  celebrate?: boolean | undefined;
  class?: string | undefined;
  style?: Record<string, string> | undefined;
}

/** A face at this width or less draws the simplified head and a status badge. */
const SMALL_FACE = 24;
/** A face at this width or more moves while it rests (blinks, breathes); smaller resting faces hold still. */
const LIVELY_FACE = 48;
/** How long a face smiles after its work ends well. */
const SUCCESS_MS = 4_000;
/** The most drawings kept. A face is one string; a sidebar of 100 agents in two states fits many times. */
const CACHE_LIMIT = 800;

const drawings = new Map<string, string>();

function drawing(key: string, draw: () => string): string {
  const hit = drawings.get(key);
  if (hit !== undefined) {
    // Most recently used last, so the oldest drawing is the one that goes.
    drawings.delete(key);
    drawings.set(key, hit);
    return hit;
  }
  const svg = draw();
  drawings.set(key, svg);
  if (drawings.size > CACHE_LIMIT) {
    const oldest = drawings.keys().next().value;
    if (oldest !== undefined) drawings.delete(oldest);
  }
  return svg;
}

function familyOf(value: string | undefined): FaceStyle | undefined {
  return FACE_STYLES.find((style) => style === value);
}

interface FaceWatch {
  size: (width: number) => void;
  visible: (visible: boolean) => void;
}

const watched = new WeakMap<Element, FaceWatch>();
let resizeObserver: ResizeObserver | undefined;
let intersectionObserver: IntersectionObserver | undefined;

/**
 * One observer of each kind for every face on the page: a sidebar can hold a hundred faces, and an
 * observer for each would cost more than the drawings.
 */
function watch(element: Element, handlers: FaceWatch): () => void {
  if (typeof ResizeObserver === "undefined" || typeof IntersectionObserver === "undefined") return () => undefined;
  resizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) watched.get(entry.target)?.size(entry.contentRect.width);
  });
  intersectionObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) watched.get(entry.target)?.visible(entry.isIntersecting);
  });
  watched.set(element, handlers);
  resizeObserver.observe(element);
  intersectionObserver.observe(element);
  return () => {
    watched.delete(element);
    resizeObserver?.unobserve(element);
    intersectionObserver?.unobserve(element);
  };
}

let reducedMotion: (() => boolean) | undefined;

/** Whether the reader asked for less motion. One listener for every face; it follows a change of the setting. */
function prefersLessMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  if (!reducedMotion) {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const [value, setValue] = createSignal(media.matches);
    media.addEventListener?.("change", () => setValue(media.matches));
    reducedMotion = value;
  }
  return reducedMotion();
}

/**
 * The still face of an agent as SVG markup, for a place that is not a component, such as a mention
 * chip in the message box. It reads the workspace look and the agent directory as `AgentFace` does.
 */
export function agentFaceMarkup(seed: string, name?: string): string {
  const known = agentFaceEntry(seed);
  const preferred = familyOf(known?.faceStyle);
  const fallback = atelierFaceDefault();
  const words = name ?? known?.name ?? "";
  return agentFaceSVG({
    id: seed,
    name: known?.title ? `${words} · ${known.title}` : words,
    style: preferred ?? (fallback === "mixed" ? "auto" : fallback),
    ...(known?.faceSeed ? { seed: known.faceSeed } : {}),
    skin: known?.faceSkin ? atelierSkinOf(known.faceSkin) : atelierSkinDefault(),
    theme: documentColorScheme(),
    brand: atelierTheme() ?? "craft",
    size: SMALL_FACE,
    animate: false,
  });
}

/**
 * An agent's Atelier face: the same person in every theme and family, with the hat of its role and
 * the expression of its state. The drawing is an SVG string with its own SMIL animation, kept in a
 * shared cache, so a hundred faces cost a hundred strings. Only a face on screen that does something,
 * or a large one, moves; reduced motion holds every face still (the state badge still shows).
 */
export function AgentFace(props: AgentFaceProps) {
  let element: HTMLSpanElement | undefined;
  const [width, setWidth] = createSignal(32);
  const [visible, setVisible] = createSignal(true);
  const entry = createMemo(() => agentFaceEntry(props.id));
  // Work that ends without a failure or a question shows success for a moment, then the face rests.
  const [celebrating, setCelebrating] = createSignal(false);
  let celebration: ReturnType<typeof setTimeout> | undefined;
  // A memo: an effect runs again each time its source runs, also with the same state, and such a run
  // ended the success face of an agent at the next unrelated change.
  const faceState = createMemo(() => props.state ?? "idle");
  createEffect(faceState, (next, previous) => {
    clearTimeout(celebration);
    const ended = props.celebrate !== false && (previous === "working" || previous === "talking") && next === "idle";
    setCelebrating(ended);
    if (ended) celebration = setTimeout(() => setCelebrating(false), SUCCESS_MS);
  });
  onCleanup(() => clearTimeout(celebration));
  const state = (): FaceState => (celebrating() ? "success" : (props.state ?? "idle"));
  const svg = createMemo(() => {
    const known = entry();
    const name = props.name ?? known?.name ?? "";
    const title = props.title ?? known?.title ?? "";
    const roleWords = title ? `${name} · ${title}` : name;
    const preferred = familyOf(props.faceStyle ?? known?.faceStyle);
    const fallback = atelierFaceDefault();
    const style: FaceStyle | "auto" = preferred ?? (fallback === "mixed" ? "auto" : fallback);
    const seed = props.faceSeed ?? known?.faceSeed ?? "";
    const ownSkin = props.faceSkin ?? known?.faceSkin;
    const skin = ownSkin ? atelierSkinOf(ownSkin) : atelierSkinDefault();
    const theme = documentColorScheme();
    const brand = atelierTheme() ?? "craft";
    const small = width() <= SMALL_FACE;
    const animate = !prefersLessMotion() && visible() && (state() !== "idle" || width() >= LIVELY_FACE);
    const key = [props.id, roleWords, style, seed, skin, state(), theme, brand, small, animate].join("|");
    return drawing(key, () =>
      agentFaceSVG({
        id: props.id,
        name: roleWords,
        style,
        ...(seed ? { seed } : {}),
        skin,
        state: state(),
        theme,
        brand,
        size: small ? SMALL_FACE : LIVELY_FACE,
        animate,
      }),
    );
  });

  onSettled(() => {
    if (!element) return;
    return watch(element, {
      // Whole pixels, so a layout that moves by a fraction does not draw the face again.
      size: (next) => setWidth(Math.round(next) || 32),
      visible: setVisible,
    });
  });

  return (
    <span
      ref={element}
      class={props.class ? `agent-face ${props.class}` : "agent-face"}
      style={props.style}
      data-state={state()}
      aria-hidden="true"
      innerHTML={svg()}
    />
  );
}
