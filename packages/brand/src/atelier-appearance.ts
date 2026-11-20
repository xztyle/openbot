import { createSignal } from "solid-js";
import type { Brand } from "./faces/agent-hue";

/** A face family, or `mixed`: each agent takes one from its id. */
export type AtelierFaceDefault = "portrait" | "sketch" | "flat" | "clay" | "character" | "mixed";

const THEME_ATTRIBUTE = "data-atelier-theme";
const FACES_ATTRIBUTE = "data-atelier-faces";
const THEMES: readonly Brand[] = ["craft", "modern", "riso"];
const FACES: readonly AtelierFaceDefault[] = ["portrait", "sketch", "flat", "clay", "character", "mixed"];

interface RootAppearance {
  theme: Brand | null;
  faces: AtelierFaceDefault;
}

function read(): RootAppearance {
  const root = document.documentElement;
  const theme = THEMES.find((value) => value === root.getAttribute(THEME_ATTRIBUTE)) ?? null;
  const faces = FACES.find((value) => value === root.getAttribute(FACES_ATTRIBUTE)) ?? "portrait";
  return { theme, faces };
}

let appearance: (() => RootAppearance) | undefined;

function current(): RootAppearance {
  if (typeof document === "undefined") return { theme: null, faces: "portrait" };
  if (!appearance) {
    const [value, setValue] = createSignal<RootAppearance>(read(), {
      equals: (left, right) => left.theme === right.theme && left.faces === right.faces,
    });
    new MutationObserver(() => setValue(read())).observe(document.documentElement, {
      attributeFilter: [THEME_ATTRIBUTE, FACES_ATTRIBUTE],
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
