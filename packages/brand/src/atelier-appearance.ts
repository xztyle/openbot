import { createSignal } from "solid-js";
import type { Brand } from "./faces/agent-hue";

/** A face family, or `mixed`: each agent takes one from its id. */
export type AtelierFaceDefault = "portrait" | "sketch" | "flat" | "clay" | "character" | "mixed";

const THEME_ATTRIBUTE = "data-atelier-theme";
const FACES_ATTRIBUTE = "data-atelier-faces";
const SKIN_ATTRIBUTE = "data-atelier-skin";
const THEMES: readonly Brand[] = ["craft", "modern", "riso"];
const FACES: readonly AtelierFaceDefault[] = ["portrait", "sketch", "flat", "clay", "character", "mixed"];

interface RootAppearance {
  theme: Brand | null;
  faces: AtelierFaceDefault;
  /** A skin tone index (0 light to 7 deep) for every face, or `varied`. */
  skin: number | "varied";
}

/** The skin of a tone name: `1` to `8` (light to deep) or `varied`. Anything else: the light tone. */
export function atelierSkinOf(value: string | null | undefined): number | "varied" {
  if (value === "varied") return "varied";
  const tone = Number(value);
  return Number.isInteger(tone) && tone >= 1 && tone <= 8 ? tone - 1 : 0;
}

function read(): RootAppearance {
  const root = document.documentElement;
  const theme = THEMES.find((value) => value === root.getAttribute(THEME_ATTRIBUTE)) ?? null;
  const faces = FACES.find((value) => value === root.getAttribute(FACES_ATTRIBUTE)) ?? "portrait";
  return { theme, faces, skin: atelierSkinOf(root.getAttribute(SKIN_ATTRIBUTE)) };
}

let appearance: (() => RootAppearance) | undefined;

function current(): RootAppearance {
  if (typeof document === "undefined") return { theme: null, faces: "portrait", skin: 0 };
  if (!appearance) {
    const [value, setValue] = createSignal<RootAppearance>(read(), {
      equals: (left, right) => left.theme === right.theme && left.faces === right.faces && left.skin === right.skin,
    });
    new MutationObserver(() => setValue(read())).observe(document.documentElement, {
      attributeFilter: [THEME_ATTRIBUTE, FACES_ATTRIBUTE, SKIN_ATTRIBUTE],
    });
    appearance = value;
  }
  return appearance();
}

/**
 * The Atelier theme of this document, from the root element's `data-atelier-theme`, or null on a
 * page that has none (the public site). The app sets the attribute; this only reads it, so shared
 * code stays free of the app's settings.
 */
export function atelierTheme(): Brand | null {
  return current().theme;
}

/** The default face family of the workspace, from the root element's `data-atelier-faces`. */
export function atelierFaceDefault(): AtelierFaceDefault {
  return current().faces;
}

/** The skin tone of the workspace's faces, from the root element's `data-atelier-skin`. Default: the light tone. */
export function atelierSkinDefault(): number | "varied" {
  return current().skin;
}
