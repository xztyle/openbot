import { BloubBot } from "@norbert_bodziony/bloub";
import { atelierTheme } from "@openbot/brand/atelier-appearance";
import { bloubAvatarProfile } from "@openbot/brand/bloub-avatar";
import type { AvatarHue } from "@openbot/contracts/ipc";
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { agentFaceMarkup } from "./features/agents/AgentFace";

/**
 * When an avatar animates, which is a performance decision and not a state one: `hover` and `idle`
 * rest until a pointer or focus reaches them, `always` runs. What the avatar *expresses* is its
 * `AvatarMood` - see `@openbot/brand/bloub-avatar-motion`.
 */
export type AvatarMotion = "hover" | "always" | "idle";
export {
  AVATAR_HUE_CHOICES,
  AVATAR_HUE_OPTIONS,
  avatarCandidateSeeds,
  avatarHeadColor,
  avatarHueSwatch,
  type BloubAvatarProfile,
  bloubAvatarProfile,
  type SupportedAvatarSilhouetteId,
} from "@openbot/brand/bloub-avatar";
export {
  type AvatarMood,
  avatarMoodIsBusy,
  avatarMoodPresentation,
  SHAPE_SAFE_STATES,
  type ShapeSafeStateId,
} from "@openbot/brand/bloub-avatar-motion";

export function createStaticAvatarSvg(seed: string, hue: AvatarHue | null, name?: string): SVGSVGElement {
  // In an Atelier workspace an agent is its face, here too.
  if (atelierTheme()) {
    const template = document.createElement("template");
    template.innerHTML = agentFaceMarkup(seed, name);
    const face = template.content.firstElementChild;
    if (face instanceof SVGSVGElement) {
      face.removeAttribute("role");
      face.removeAttribute("aria-label");
      face.setAttribute("aria-hidden", "true");
      return face;
    }
  }
  const host = document.createElement("span");
  const dispose = mountStaticAvatar(host, seed, hue);
  const svg = host.querySelector("svg");
  if (!svg) {
    dispose();
    throw new Error("Bloub did not render an SVG avatar.");
  }
  const result = svg.cloneNode(true);
  if (!(result instanceof SVGSVGElement)) {
    dispose();
    throw new Error("Bloub did not clone an SVG avatar.");
  }
  dispose();
  return result;
}

function mountStaticAvatar(host: HTMLElement, seed: string, hue: AvatarHue | null): () => void {
  const profile = bloubAvatarProfile(seed, hue);
  const dispose = render(
    () => (
      <BloubBot
        size={100}
        shape={profile.shape}
        color={profile.color}
        expression={profile.expression}
        frozenAt={0}
        ariaLabel=""
      />
    ),
    host,
  );
  flush();
  const svg = host.querySelector("svg");
  if (!svg) {
    dispose();
    throw new Error("Bloub did not render an SVG avatar.");
  }
  svg.removeAttribute("role");
  svg.removeAttribute("aria-label");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return dispose;
}
