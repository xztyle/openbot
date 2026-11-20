/**
 * Atelier faces — the final agent identity system (A · Craft Studio brand + C's living characters).
 *
 * Every agent gets a face you talk to, not a bot glyph. Five families share one rig (head, hair,
 * features, role hat) and one expression engine, so states read the same in every style:
 *
 *   portrait   – warm illustrated portrait: flat fills, fine ink outline, framed tile.
 *   sketch     – atelier sketchbook: ink line drawing, a watercolour wash, hatched hair.
 *   flat       – soft geometric: circles and arcs, no outlines, solid hue disc.
 *   clay       – rounded, softly lit 3D-ish face with gradients and highlights.
 *   character  – the Living Workshop maker, re-drawn in Atelier ink and hues.
 *
 * Variety comes from the *seed* (defaults to the agent id): skin tone, face shape, hair style and
 * colour, brows, eyes, nose, mouth, facial hair, glasses, earrings, freckles, clothing. The role
 * comes from the *name*: beret = design, hard hat = infra/dev, headset = sales/ads/support,
 * monocle = QA/legal/security, flat cap = publishing, pencil = writing, half-moon readers = research.
 * Orchestrators wear a gold rosette (character: the conductor's star) and a blazer.
 *
 * States: idle (blink + breathing) · working (focused, eyes scan, small nod) · talking (mouth moves)
 * · waiting (raised brows + amber speech bubble) · success (smile) · failed (worried / X eyes)
 * · sleeping (closed eyes, slow breath, a "z" that floats up).
 * Animation is SMIL inside the SVG (works in iOS Safari, needs no stylesheet); pass animate:false for
 * prefers-reduced-motion. Same input → same SVG.
 */

import {
  type AgentRole,
  agentHue,
  agentTraits,
  at,
  BRAND_HUES,
  type Brand,
  hash32,
  oklch,
  type Theme,
} from "./agent-hue";

export type { AgentRole, Brand, Theme } from "./agent-hue";

export const BRANDS: Brand[] = ["craft", "modern", "riso"];
export type FaceStyle = "portrait" | "sketch" | "flat" | "clay" | "character";
export type FaceState = "idle" | "working" | "talking" | "waiting" | "success" | "failed" | "sleeping";
export const FACE_STYLES: FaceStyle[] = ["portrait", "sketch", "flat", "clay", "character"];
export const FACE_STATES: FaceState[] = ["idle", "working", "talking", "waiting", "success", "failed", "sleeping"];

export interface FaceOptions {
  /** Stable agent id. Drives the hue (team colour) and, unless `seed` is set, the face. */
  id: string;
  /** Display name: role words pick the hat, orchestrator words the rosette. */
  name?: string;
  /** Face family. "auto" picks one from the id. Default "portrait". */
  style?: FaceStyle | "auto";
  /** Re-roll the face without changing the agent: any string/number. Default = id. */
  seed?: string | number;
  state?: FaceState;
  theme?: Theme;
  /** Rendered px (viewBox 64). ≤ 24px draws the simplified head. */
  size?: number;
  animate?: boolean;
  role?: AgentRole;
  /** Pin a hue 0–11. */
  hue?: number;
  /**
   * Skin tone: 0–7 (light to deep, see SKINS) for every agent, or "varied" for a tone from the seed.
   * Default 0, the light warm tone. Hair, features and accessories keep their variety.
   */
  skin?: number | "varied";
  /** Workspace brand/theme the face is drawn for: craft (default) · modern · riso. Same agent → same face in every brand. */
  brand?: Brand;
}

/* ───────────────────────────── palette ───────────────────────────── */

const INK = "#1F1A15";
const SKINS: [string, string, string][] = [
  // base, shade, lip
  ["#F6D9C6", "#E6B89E", "#D98C82"],
  ["#F0C8A6", "#DCA582", "#D2847A"],
  ["#E4B08A", "#C98F69", "#C27466"],
  ["#D19A6E", "#B47A52", "#B2645A"],
  ["#B57A51", "#975F3B", "#9B5348"],
  ["#95603D", "#7A4A2D", "#7E4136"],
  ["#76482D", "#5E3721", "#64332B"],
  ["#583421", "#452818", "#4E2820"],
];
/** The base colour of each skin tone, light to deep, for a picker. */
export const SKIN_TONES: readonly string[] = SKINS.map(([base]) => base);

const HAIR = {
  black: "#1E1916",
  espresso: "#33241B",
  brown: "#5E3D27",
  chestnut: "#7D4626",
  auburn: "#9A4524",
  copper: "#B9652F",
  blonde: "#D6AE66",
  ash: "#B9A68A",
  grey: "#8F8A84",
  silver: "#D3CEC6",
} as const;
type HairColor = keyof typeof HAIR;
const HAIR_LIGHT: HairColor[] = [
  "black",
  "espresso",
  "brown",
  "brown",
  "chestnut",
  "auburn",
  "copper",
  "blonde",
  "ash",
  "grey",
  "silver",
  "espresso",
];
const HAIR_DEEP: HairColor[] = ["black", "black", "espresso", "espresso", "brown", "grey", "silver", "chestnut"];

interface BrandSpec {
  key: Brand;
  /** Feature / outline ink. */
  ink: string;
  /** Ink on dark paper (sketch family in dark theme). */
  inkDark: string;
  /** Outline width multiplier (0 = no outlines: crisp vector). */
  outline: number;
  /** Second, misregistered ink drum (riso). */
  misreg?: string;
  misregDark?: string;
  grain: boolean;
  halftone: boolean;
  skinMute: number;
  role: {
    beret: string;
    beretDark: string;
    hardhat: string;
    brass: string;
    gold: string;
    cap: string;
    pencil: string;
    sweat: string;
    blush: string;
    headset: string;
    rib: string;
    ribDark: string;
  };
}
const BRAND_SPECS: Record<Brand, BrandSpec> = {
  craft: {
    key: "craft",
    ink: "#1F1A15",
    inkDark: "#F3ECE1",
    outline: 1,
    grain: true,
    halftone: false,
    skinMute: 0,
    role: {
      beret: "#B4441F",
      beretDark: "#D5683F",
      hardhat: "#E8A93A",
      brass: "#B88A3E",
      gold: "#D4A02C",
      cap: "#6E5A45",
      pencil: "#E8B23A",
      sweat: "#8CC8F0",
      blush: "#E8837A",
      headset: "#2B2420",
      rib: "#B4441F",
      ribDark: "#EC8358",
    },
  },
  modern: {
    key: "modern",
    ink: "#111113",
    inkDark: "#F4F4F5",
    outline: 0,
    grain: false,
    halftone: false,
    skinMute: 0.12,
    role: {
      beret: "#2E3BFF",
      beretDark: "#6F7BFF",
      hardhat: "#2E3BFF",
      brass: "#2E3BFF",
      gold: "#2E3BFF",
      cap: "#2E3BFF",
      pencil: "#2E3BFF",
      sweat: "#9DB4FF",
      blush: "#E99A93",
      headset: "#111113",
      rib: "#111113",
      ribDark: "#111113",
    },
  },
  riso: {
    key: "riso",
    ink: "#1D2A6B",
    inkDark: "#F3EFE6",
    outline: 0,
    misreg: "#1F5FD0",
    misregDark: "#7FA6FF",
    grain: false,
    halftone: true,
    skinMute: 0,
    role: {
      beret: "#E0287F",
      beretDark: "#FF5AAE",
      hardhat: "#FFD21F",
      brass: "#1F5FD0",
      gold: "#FFD21F",
      cap: "#1F5FD0",
      pencil: "#FFD21F",
      sweat: "#7FC6FF",
      blush: "#FF6FAE",
      headset: "#1D2A6B",
      rib: "#E0287F",
      ribDark: "#FF6FC2",
    },
  },
};
let BR: BrandSpec = BRAND_SPECS.craft;

/* hex helpers */
const toRgb = (h: string) => {
  const n = Number.parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: number[]) =>
  `#${c
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
export const mix = (a: string, b: string, t: number) => {
  const x = toRgb(a);
  const y = toRgb(b);
  return toHex(x.map((v, i) => v + (at(y, i) - v) * t));
};
const darken = (h: string, t: number) => mix(h, "#000000", t);
const lighten = (h: string, t: number) => mix(h, "#ffffff", t);

/* ───────────────────────────── traits ───────────────────────────── */

export type Hat = "beret" | "hardhat" | "headset" | "monocle" | "cap" | "pencil" | "readers" | "none";
const HAT_BY_GLYPH: Record<string, Hat> = {
  brush: "beret",
  camera: "beret",
  scissors: "beret",
  bulb: "beret",
  wrench: "hardhat",
  hammer: "hardhat",
  code: "hardhat",
  megaphone: "headset",
  chart: "headset",
  chat: "headset",
  loupe: "monocle",
  scale: "monocle",
  key: "monocle",
  stamp: "cap",
  globe: "cap",
  nib: "pencil",
  setsquare: "pencil",
  book: "readers",
  compass: "none",
  needle: "none",
};

export interface FaceTraits {
  seed: string;
  hue: number;
  role: AgentRole;
  hat: Hat;
  glyph: string;
  skin: number;
  shape: number;
  hair: number;
  hairColor: HairColor;
  brow: number;
  browW: number;
  eyes: number;
  eyeGap: number;
  nose: number;
  mouth: number;
  facial: number; // 0 none · 1 beard · 2 moustache · 3 stubble · 4 goatee
  glasses: number; // 0 none · 1 round · 2 square
  frame: number;
  earring: number; // 0 none · 1 stud · 2 hoop
  freckles: boolean;
  blush: boolean;
  clothing: number; // 0 crew · 1 v-neck · 2 collar · 3 turtleneck · 4 hoodie
  body: number; // character body
  blinkDelay: number;
  breathe: number;
}

const pickS = (seed: string, salt: string, n: number) => hash32(`${seed}:${salt}`) % n;

export function faceTraits(
  id: string,
  name = "",
  o: { seed?: string | number; role?: AgentRole; hue?: number; skin?: number | "varied" } = {},
): FaceTraits {
  const base = agentTraits(id, name, o.role, o.hue);
  const seed = o.seed === undefined || o.seed === "" ? id : String(o.seed);
  const fixedSkin = o.skin === "varied" ? undefined : (o.skin ?? 0);
  const skin =
    fixedSkin !== undefined && Number.isInteger(fixedSkin) && fixedSkin >= 0 && fixedSkin < SKINS.length
      ? fixedSkin
      : pickS(seed, "skin", SKINS.length);
  const hairPool = skin >= 5 ? HAIR_DEEP : HAIR_LIGHT;
  const hair = at([0, 0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 8, 9, 9, 10, 11, 12], pickS(seed, "hair", 19));
  const fr = pickS(seed, "facial", 20);
  const facial = fr < 12 ? 0 : fr < 15 ? 1 : fr < 17 ? 3 : fr < 19 ? 2 : 4;
  const gl = pickS(seed, "glasses", 9);
  const hat: Hat = HAT_BY_GLYPH[base.glyph] ?? "none";
  const glasses = hat === "readers" || hat === "monocle" ? 0 : gl === 0 ? 1 : gl === 1 ? 2 : 0;
  const er = pickS(seed, "earring", 6);
  return {
    seed,
    hue: base.hue,
    role: base.role,
    hat,
    glyph: base.glyph,
    skin,
    shape: pickS(seed, "shape", 5),
    hair,
    hairColor: at(hairPool, pickS(seed, "haircol", hairPool.length)),
    brow: pickS(seed, "brow", 3),
    browW: at([1.25, 1.5, 1.8], pickS(seed, "browW", 3)),
    eyes: pickS(seed, "eyes", 4),
    eyeGap: at([4.7, 5.1, 5.5], pickS(seed, "gap", 3)),
    nose: pickS(seed, "nose", 3),
    mouth: pickS(seed, "mouth", 4),
    facial,
    glasses,
    frame: pickS(seed, "frame", 3),
    earring: hat === "headset" ? 0 : er === 0 ? 1 : er === 1 ? 2 : 0,
    freckles: skin <= 3 && pickS(seed, "freckles", 5) === 0,
    blush: pickS(seed, "blush", 3) > 0,
    clothing: pickS(seed, "clothes", 5),
    body: pickS(seed, "body", 4),
    blinkDelay: (hash32(`${seed}:blink`) % 4000) / 1000,
    breathe: 3.6 + (hash32(`${seed}:breathe`) % 1000) / 1000,
  };
}

/* ───────────────────────────── geometry ───────────────────────────── */

const n = (v: number) => +v.toFixed(2);
const EY = 31;
const TOP = 15.5;
const MID = 29.5;
const SHAPES = [
  { R: 12.2, chin: 45.4, jaw: 6.4, k: 9 },
  { R: 13.1, chin: 44.6, jaw: 8.4, k: 8 },
  { R: 12.8, chin: 45.2, jaw: 9.6, k: 11.2 },
  { R: 11.7, chin: 46.6, jaw: 6, k: 10.2 },
  { R: 12.9, chin: 45.4, jaw: 4.6, k: 7.4 },
];

function headPath(s: (typeof SHAPES)[number]): string {
  const { R, chin, jaw, k } = s;
  const L = 32 - R;
  const Rr = 32 + R;
  const c = 0.552;
  const h = MID - TOP;
  return `M${n(L)} ${MID}C${n(L)} ${n(MID - c * h)} ${n(32 - c * R)} ${TOP} 32 ${TOP}C${n(32 + c * R)} ${TOP} ${n(Rr)} ${n(MID - c * h)} ${n(Rr)} ${MID}C${n(Rr)} ${n(MID + k)} ${n(32 + jaw)} ${n(chin)} 32 ${n(chin)}C${n(32 - jaw)} ${n(chin)} ${n(L)} ${n(MID + k)} ${n(L)} ${MID}Z`;
}

/** Bumpy closed outline (curls). */
function bumpy(
  cx: number,
  cy: number,
  r: number,
  amp: number,
  lobes: number,
  a0 = 0,
  a1 = Math.PI * 2,
  close = true,
): string {
  const steps = lobes * 6;
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const rr = r + amp * Math.abs(Math.cos((lobes * (a - a0)) / 2)) ** 0.6;
    d += `${i ? "L" : "M"}${n(cx + rr * Math.cos(a))} ${n(cy + rr * Math.sin(a))}`;
  }
  return close ? `${d}Z` : d;
}

interface HairParts {
  back?: string;
  front?: string;
  top?: string;
  shine?: string;
  soft?: boolean;
}

function hairParts(style: number, R: number): HairParts {
  const L = 32 - R;
  const Rr = 32 + R;
  const crop = `M${n(L - 0.7)} 30C${n(L - 1.2)} 18.5 ${n(L + 4)} 12.6 32 12.6C${n(Rr - 4)} 12.6 ${n(Rr + 1.2)} 18.5 ${n(Rr + 0.7)} 30L${n(Rr - 0.6)} 30C${n(Rr - 0.9)} 25.5 ${n(Rr - 1.6)} 22 ${n(Rr - 3.4)} 20.6C${n(Rr - 7)} 21.6 30 19.4 ${n(L + 4.6)} 20.4C${n(L + 1.8)} 21.6 ${n(L + 0.7)} 25 ${n(L + 0.6)} 30Z`;
  const swoop = `M${n(L - 0.9)} 31C${n(L - 2.4)} 17 ${n(L + 5)} 10.6 33 10.8C${n(Rr - 2)} 11 ${n(Rr + 2.2)} 17 ${n(Rr + 0.8)} 31L${n(Rr - 0.5)} 31C${n(Rr - 0.6)} 26 ${n(Rr - 1.2)} 23 ${n(Rr - 2.6)} 21.4C${n(Rr - 6)} 22.6 33 21 ${n(L + 6.5)} 18.6C${n(L + 3.4)} 20.6 ${n(L + 1)} 24.6 ${n(L + 0.6)} 31Z`;
  const sleek = `M${n(L - 0.4)} 29C${n(L - 0.8)} 18 ${n(L + 4)} 13.4 32 13.4C${n(Rr - 4)} 13.4 ${n(Rr + 0.8)} 18 ${n(Rr + 0.4)} 29L${n(Rr - 0.6)} 29C${n(Rr - 1)} 22 ${n(Rr - 4)} 18.6 32 18.4C${n(L + 4)} 18.6 ${n(L + 1)} 22 ${n(L + 0.6)} 29Z`;
  const curlCapOuter = (r: number, amp: number) => bumpy(32, 28.5, r, amp, 9, Math.PI * 1.04, Math.PI * 1.96, false);
  const curlFront = (r: number, amp: number) =>
    `${curlCapOuter(r, amp)}L${n(Rr - 0.5)} 30C${n(Rr - 1)} 23 ${n(Rr - 4)} 20 32 20.4C${n(L + 4)} 20 ${n(L + 1)} 23 ${n(L + 0.5)} 30Z`;
  switch (style) {
    case 0:
      return { front: crop, shine: `M${n(L + 5)} 15.6Q32 13.4 ${n(Rr - 5)} 15.6` };
    case 1:
      return { front: swoop, shine: `M${n(L + 7)} 14.4Q33 12.4 ${n(Rr - 3)} 16` };
    case 2:
      return {
        back: `M${n(L - 1.8)} 26C${n(L - 2.4)} 13 ${n(Rr + 2.4)} 13 ${n(Rr + 1.8)} 26L${n(Rr + 2.8)} 52Q${n(Rr + 2.4)} 57.5 ${n(Rr - 2.6)} 57L${n(Rr - 3.6)} 40L${n(L + 3.6)} 40L${n(L + 2.6)} 57Q${n(L - 2.4)} 57.5 ${n(L - 2.8)} 52Z`,
        front: `M${n(L - 1)} 31C${n(L - 1.6)} 17 ${n(L + 5)} 12.4 32 13.4C${n(Rr - 5)} 12.4 ${n(Rr + 1.6)} 17 ${n(Rr + 1)} 31L${n(Rr - 0.4)} 31C${n(Rr - 0.8)} 23 ${n(Rr - 4)} 18.6 32 16C${n(L + 4)} 18.6 ${n(L + 0.8)} 23 ${n(L + 0.4)} 31Z`,
        shine: `M${n(L + 3)} 18Q${n(L + 6)} 14 31 14.6`,
      };
    case 3:
      return {
        back: `M${n(L - 2.4)} 26C${n(L - 3)} 12.4 ${n(Rr + 3)} 12.4 ${n(Rr + 2.4)} 26L${n(Rr + 2.8)} 42Q${n(Rr + 2)} 45.6 ${n(Rr - 1.8)} 44.6L${n(L + 1.8)} 44.6Q${n(L - 2)} 45.6 ${n(L - 2.8)} 42Z`,
        front: `M${n(L - 1.4)} 33C${n(L - 2)} 16 ${n(L + 5)} 12.2 32 12.2C${n(Rr - 5)} 12.2 ${n(Rr + 2)} 16 ${n(Rr + 1.4)} 33L${n(Rr - 0.2)} 33L${n(Rr - 0.6)} 23.6C${n(Rr - 4)} 22.4 35 23.4 32 23C29 23.4 ${n(L + 4)} 22.4 ${n(L + 0.6)} 23.6L${n(L + 0.2)} 33Z`,
        shine: `M${n(L + 4)} 15.4Q32 13.6 ${n(Rr - 4)} 15.4`,
      };
    case 4:
      return { back: bumpy(32, 24.5, R + 7, 1.3, 16), front: curlFront(R + 1.6, 1.1) };
    case 5:
      return {
        front: sleek,
        top: `M26.8 10.8a5.2 4.4 0 1 0 10.4 0a5.2 4.4 0 1 0-10.4 0Z`,
        shine: `M${n(L + 5)} 16.4Q32 14.6 ${n(Rr - 5)} 16.4`,
      };
    case 6:
      return {
        front: sleek,
        back: `M${n(Rr - 3)} 17C${n(Rr + 6)} 19 ${n(Rr + 6.4)} 34 ${n(Rr + 3.4)} 47C${n(Rr + 2.4)} 51 ${n(Rr - 1)} 51 ${n(Rr - 0.2)} 46C${n(Rr + 1.8)} 36 ${n(Rr + 1.2)} 26 ${n(Rr - 5)} 20Z`,
        shine: `M${n(L + 5)} 16.4Q32 14.6 ${n(Rr - 5)} 16.4`,
      };
    case 7:
      return { front: crop, soft: true };
    case 8:
      return {
        back: `M${n(L - 2)} 26C${n(L - 2.6)} 13 ${n(Rr + 2.6)} 13 ${n(Rr + 2)} 26C${n(Rr + 4.5)} 34 ${n(Rr + 1.5)} 40 ${n(Rr + 3.8)} 46Q${n(Rr + 3)} 51 ${n(Rr - 1.2)} 49.5L${n(Rr - 3)} 40L${n(L + 3)} 40L${n(L + 1.2)} 49.5Q${n(L - 3)} 51 ${n(L - 3.8)} 46C${n(L - 1.5)} 40 ${n(L - 4.5)} 34 ${n(L - 2)} 26Z`,
        front: swoop,
        shine: `M${n(L + 7)} 14.4Q33 12.4 ${n(Rr - 3)} 16`,
      };
    case 9:
      return { front: curlFront(R + 2.4, 1.4) };
    case 10:
      return { back: bumpy(32, 31, R + 8.6, 1.5, 18), front: curlFront(R + 1.8, 1.2) };
    case 11:
      return {
        front: `M${n(L - 0.4)} 29C${n(L - 0.6)} 22 ${n(L + 1)} 17 ${n(L + 4)} 15.6C${n(L + 6)} 9.6 ${n(Rr - 2)} 8.8 ${n(Rr + 0.4)} 15C${n(Rr + 1.2)} 18 ${n(Rr + 0.6)} 24 ${n(Rr + 0.3)} 29L${n(Rr - 0.6)} 29C${n(Rr - 1)} 24 ${n(Rr - 2.6)} 20.6 ${n(Rr - 5)} 20C32 18 ${n(L + 4)} 21 ${n(L + 0.8)} 23L${n(L + 0.6)} 29Z`,
        shine: `M${n(L + 6)} 13.4Q${n(Rr - 6)} 9.6 ${n(Rr - 1)} 14.4`,
      };
    default:
      // bald with a close fringe at the sides
      return {
        front: `M${n(L - 0.5)} 31C${n(L - 0.8)} 27 ${n(L - 0.2)} 24 ${n(L + 1.2)} 22.4L${n(L + 1.6)} 24.6C${n(L + 1)} 26 ${n(L + 0.8)} 28 ${n(L + 0.7)} 31ZM${n(Rr + 0.5)} 31C${n(Rr + 0.8)} 27 ${n(Rr + 0.2)} 24 ${n(Rr - 1.2)} 22.4L${n(Rr - 1.6)} 24.6C${n(Rr - 1)} 26 ${n(Rr - 0.8)} 28 ${n(Rr - 0.7)} 31Z`,
        soft: true,
      };
  }
}

const SHOULDERS = "M3 66C4 57.5 10.5 53.2 20.5 51.8Q26.5 51 32 51Q37.5 51 43.5 51.8C53.5 53.2 60 57.5 61 66Z";
const NECK = "M27.4 37L27 51.4Q32 54.6 37 51.4L36.6 37Z";

/* ───────────────────────────── painters ───────────────────────────── */

interface Painter {
  /** A filled shape (with the family's outline / gradient / wash). */
  shape(d: string, fill: string, o?: { line?: boolean; alpha?: number; hatch?: boolean }): string;
  /** A stroke in the family's ink. */
  stroke(d: string, color: string, w: number, extra?: string): string;
  ink: string;
  line: number;
  defs: string[];
}

function makePainter(style: FaceStyle, uid: string, theme: Theme, small: boolean): Painter {
  const defs: string[] = [];
  let gi = 0;
  const lw = small ? 2 : 1.15;
  const stroke = (d: string, color: string, w: number, extra = "") =>
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
  if (style === "clay") {
    const grads = new Map<string, string>();
    return {
      ink: BR.key === "craft" ? "#2A1F1A" : BR.ink,
      line: lw,
      defs,
      stroke,
      shape(d, fill, o = {}) {
        let id = grads.get(fill);
        if (!id) {
          id = `${uid}g${gi++}`;
          grads.set(fill, id);
          defs.push(
            `<radialGradient id="${id}" cx=".36" cy=".26" r=".85"><stop offset="0" stop-color="${lighten(fill, 0.28)}"/><stop offset=".55" stop-color="${fill}"/><stop offset="1" stop-color="${darken(fill, 0.22)}"/></radialGradient>`,
          );
        }
        return `<path d="${d}" fill="url(#${id})"${o.alpha !== undefined ? ` opacity="${o.alpha}"` : ""}/>`;
      },
    };
  }
  if (style === "sketch") {
    const ink = theme === "dark" ? BR.inkDark : BR.ink;
    const second = BR.misreg ? (theme === "dark" ? (BR.misregDark ?? BR.misreg) : BR.misreg) : ink;
    let hi = 0;
    return {
      ink,
      line: small ? 2 : 0.95,
      defs,
      stroke,
      shape(d, fill, o = {}) {
        const wash = `<path d="${d}" fill="${fill}" opacity="${o.alpha ?? 0.82}"${BR.key === "modern" ? "" : ' transform="translate(.7 .55)"'}/>`;
        let hatch = "";
        if (o.hatch && !small) {
          const id = `${uid}h${hi++}`;
          defs.push(`<clipPath id="${id}"><path d="${d}"/></clipPath>`);
          let lines = "";
          for (let x = -10; x < 74; x += 2.3) lines += `M${x} 4L${x - 14} 64`;
          hatch = `<path d="${lines}" clip-path="url(#${id})" stroke="${ink}" stroke-width=".5" opacity=".45" fill="none"/>`;
        }
        if (o.line === false) return wash + hatch;
        return `${wash}${hatch}<path d="${d}" fill="none" stroke="${ink}" stroke-width="${small ? 2 : BR.key === "modern" ? 0.75 : 0.95}" stroke-linejoin="round" stroke-linecap="round"/>${
          small || BR.key === "modern"
            ? ""
            : `<path d="${d}" fill="none" stroke="${second}" stroke-width="${BR.misreg ? 0.8 : 0.55}" opacity="${BR.misreg ? 0.8 : 0.35}" transform="rotate(.9 32 34) translate(-.35 .25)"/>`
        }`;
      },
    };
  }
  if (style === "flat") {
    return {
      ink: BR.key === "craft" ? "#231B16" : BR.ink,
      line: 0,
      defs,
      stroke,
      shape: (d, fill, o = {}) =>
        `<path d="${d}" fill="${fill}"${o.alpha !== undefined ? ` opacity="${o.alpha}"` : ""}/>`,
    };
  }
  // portrait (and character)
  const mis = BR.misreg ? (theme === "dark" ? (BR.misregDark ?? BR.misreg) : BR.misreg) : "";
  return {
    ink: BR.ink,
    line: lw,
    defs,
    stroke,
    shape: (d, fill, o = {}) =>
      `<path d="${d}" fill="${fill}"${o.alpha !== undefined ? ` fill-opacity="${o.alpha}"` : ""}${
        o.line === false || !BR.outline
          ? ""
          : ` stroke="${BR.ink}" stroke-width="${lw * BR.outline}" stroke-linejoin="round"`
      }/>${mis && o.line !== false && !small ? `<path d="${d}" fill="none" stroke="${mis}" stroke-width=".75" stroke-linejoin="round" opacity=".85" transform="translate(.6 .45)"/>` : ""}`,
  };
}

/* ───────────────────────────── features ───────────────────────────── */

interface FeatureCtx {
  t: FaceTraits;
  state: FaceState;
  anim: boolean;
  small: boolean;
  style: FaceStyle;
  ink: string;
  skin: [string, string, string];
  hairHex: string;
  mouthY: number;
  noseY: number;
  xEyes: boolean;
}

function blinkWrap(inner: string, c: FeatureCtx): string {
  if (!c.anim || c.state === "success" || c.state === "failed" || c.state === "sleeping") return inner;
  const dur = c.state === "waiting" ? 3.4 : 4.8;
  return `<g>${inner}<animateTransform attributeName="transform" type="scale" values="1 1;1 1;1 .08;1 1" keyTimes="0;.93;.96;1" dur="${dur}s" begin="-${c.t.blinkDelay}s" repeatCount="indefinite"/></g>`;
}

function eye(c: FeatureCtx, side: -1 | 1): string {
  const { t, state, ink, small } = c;
  const k = small ? 1.55 : 1;
  const wide = state === "waiting" ? 1.14 : 1;
  if (c.xEyes && state === "failed")
    return `<path d="M-1.7-1.7l3.4 3.4M1.7-1.7l-3.4 3.4" stroke="${ink}" stroke-width="${small ? 2.4 : 1.3}" stroke-linecap="round"/>`;
  if (state === "success")
    return `<path d="M${-1.9 * k} ${0.7 * k}Q0 ${-1.7 * k} ${1.9 * k} ${0.7 * k}" fill="none" stroke="${ink}" stroke-width="${small ? 2.2 : 1.25}" stroke-linecap="round"/>`;
  // A closed lid: the arc sags, with a short lash at the outer corner.
  if (state === "sleeping")
    return `<path d="M${-2 * k} ${-0.1 * k}Q0 ${1.5 * k} ${2 * k} ${-0.1 * k}" fill="none" stroke="${ink}" stroke-width="${small ? 2.2 : 1.2}" stroke-linecap="round"/>${
      small ? "" : `<path d="M1.9 .1l.9 .7" stroke="${ink}" stroke-width=".8" stroke-linecap="round"/>`
    }`;
  const gloss = !small && (c.style === "clay" || c.style === "portrait");
  const rx = (t.eyes === 1 ? 1.45 : 1.25) * k * wide;
  const ry = (t.eyes === 1 ? 1.45 : 1.65) * k * wide;
  let look = "";
  if (state === "working") look = "translate(0 .55)";
  if (state === "waiting") look = `translate(${side === 1 ? 0.35 : 0.45} -.3)`;
  if (state === "failed") look = "translate(0 .35)";
  let pupil = `<ellipse rx="${n(rx)}" ry="${n(ry)}" fill="${ink}"/>${gloss ? `<circle cx="${n(rx * 0.35)}" cy="${n(-ry * 0.4)}" r="${n(rx * 0.32)}" fill="#fff" opacity=".9"/>` : ""}`;
  if (state === "working" && c.anim)
    pupil = `<g>${pupil}<animateTransform attributeName="transform" type="translate" values="-.5 0;.5 0;.5 0;-.5 0;-.5 0" keyTimes="0;.3;.5;.8;1" dur="2.6s" repeatCount="indefinite"/></g>`;
  let out = `<g transform="${look}">${pupil}</g>`;
  if (small) return out;
  // lids / lashes
  if (state === "working")
    out += `<path d="M-2.1-.9Q0-1.5 2.1-.9" fill="none" stroke="${ink}" stroke-width=".9" stroke-linecap="round"/>`;
  else if (t.eyes === 2)
    out += `<path d="M${side * 1.2}-1.6l${side * 1.1}-.7" stroke="${ink}" stroke-width=".8" stroke-linecap="round"/>`;
  else if (t.eyes === 3 && state === "idle")
    out += `<path d="M-1.8 1.7Q0 1 1.8 1.7" fill="none" stroke="${ink}" stroke-width=".7" stroke-linecap="round" opacity=".55"/>`;
  return out;
}

function brow(c: FeatureCtx): string {
  const { t, state } = c;
  const d = at(["M-2.5.1Q0-.7 2.6 0", "M-2.5.7Q-.5-1.3 2.6.3", "M-2.4.4Q0-.3 2.5.5"], t.brow);
  let tr = "";
  if (state === "waiting") tr = "translate(0 -1.7) rotate(4)";
  else if (state === "working") tr = "translate(0 .5) rotate(-7)";
  else if (state === "failed") tr = "translate(0 -.6) rotate(13)";
  else if (state === "success") tr = "translate(0 -1)";
  else if (state === "sleeping") tr = "translate(0 .7) rotate(-3)";
  const color =
    c.style === "sketch"
      ? c.ink
      : ["grey", "silver", "ash", "blonde"].includes(t.hairColor)
        ? darken(c.hairHex, 0.35)
        : darken(c.hairHex, 0.1);
  const w = c.small ? 2.2 : t.browW;
  let inner = `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
  if (state === "talking" && c.anim)
    inner = `<g>${inner}<animateTransform attributeName="transform" type="translate" values="0 0;0 -.7;0 0;0 0;0 -.5;0 0" dur="2.4s" repeatCount="indefinite"/></g>`;
  return `<g transform="${tr}">${inner}</g>`;
}

function mouth(c: FeatureCtx): string {
  const { t, state, ink, skin, small } = c;
  const lip = skin[2];
  const st = (d: string, w = small ? 2.2 : 1.15) =>
    `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const dark = "#3A1C18";
  const open = (w: number, h: number, teeth = true) =>
    `<path d="M${-w} -.3Q0 ${-0.9} ${w} -.3Q${w * 0.8} ${h} 0 ${h}Q${-w * 0.8} ${h} ${-w} -.3Z" fill="${dark}"${c.style === "portrait" || c.style === "character" ? ` stroke="${ink}" stroke-width=".8" stroke-linejoin="round"` : ""}/>${
      teeth && !small
        ? `<path d="M${-w * 0.7} -.2Q0 -.6 ${w * 0.7} -.2L${w * 0.62} .6Q0 .3 ${-w * 0.62} .6Z" fill="#fff"/>`
        : ""
    }${small ? "" : `<ellipse cx="0" cy="${n(h * 0.72)}" rx="${n(w * 0.5)}" ry="${n(h * 0.24)}" fill="#D9736B"/>`}`;
  if (small) {
    if (state === "failed") return st("M-2.6 1.2Q0-.8 2.6 1.2");
    if (state === "talking" || state === "success") return open(3, 3.2, false);
    return st("M-2.8-.2Q0 2.2 2.8-.2");
  }
  switch (state) {
    case "talking": {
      const inner = open(2.7, 3.6);
      if (!c.anim) return `<g transform="scale(1 .6)">${inner}</g>`;
      return `<g>${inner}<animateTransform attributeName="transform" type="scale" values="1 .25;1 1;1 .5;1 .85;1 .2;1 .7;1 .35;1 .95;1 .25" keyTimes="0;.12;.24;.36;.5;.62;.74;.88;1" dur="1.7s" repeatCount="indefinite"/></g>`;
    }
    case "success":
      return open(3.6, 4, true);
    case "failed":
      return st("M-2.8 1.3Q-1.4 0 0 .6Q1.4 1.2 2.8 .1");
    case "working":
      return st("M-1.7.4Q0 .9 1.8.2");
    case "waiting":
      return `${st("M-2.2 0Q0 1.6 2.2 0")}`;
    case "sleeping":
      // A slack mouth, a little open.
      return `<ellipse cx=".2" cy=".7" rx="1.1" ry="1.3" fill="${dark}"/>`;
  }
  switch (t.mouth) {
    case 0:
      return st("M-3-.2Q0 2.2 3-.2");
    case 1:
      return st("M-3.6-.6Q0 2.8 3.6-.6");
    case 2:
      return `<path d="M-3 0Q-1.5-1.1 0-.6Q1.5-1.1 3 0Q1.5 2 0 2Q-1.5 2-3 0Z" fill="${lip}"/>${st("M-3 0Q0 .9 3 0", 0.9)}`;
    default:
      return st("M-2.8.2Q.5 1.8 3.2-.8");
  }
}

function nose(c: FeatureCtx): string {
  if (c.small) return "";
  const col = c.style === "sketch" ? c.ink : darken(c.skin[1], 0.12);
  const w = c.style === "sketch" ? 0.8 : 1;
  const d = at(
    ["M-.3-3.2Q-1.2.6-.2 1.2Q.6 1.5 1.3.9", "M-1.4.6Q0 1.7 1.4.6", "M.6-3.2Q1.6-.2 1.1 1Q.4 1.6-.6 1.2"],
    c.t.nose,
  );
  return `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" transform="translate(32 ${n(c.noseY)})"/>`;
}

function features(c: FeatureCtx): string {
  const g = c.small ? c.t.eyeGap + 0.6 : c.t.eyeGap;
  const ey = EY;
  let out = "";
  // brows
  if (!c.small || c.state === "waiting" || c.state === "failed") {
    out += `<g transform="translate(${n(32 + g)} ${c.small ? 25.4 : 26.6})">${brow(c)}</g><g transform="translate(${n(32 - g)} ${c.small ? 25.4 : 26.6}) scale(-1 1)">${brow(c)}</g>`;
  }
  // eyes
  out += `<g transform="translate(${n(32 + g)} ${ey})">${blinkWrap(eye(c, 1), c)}</g><g transform="translate(${n(32 - g)} ${ey}) scale(-1 1)">${blinkWrap(eye(c, -1), c)}</g>`;
  // blush, freckles
  if (!c.small && (c.t.blush || c.state === "success") && c.style !== "sketch")
    out += `<g fill="${BR.role.blush}" opacity="${c.state === "success" ? 0.42 : 0.24}"><ellipse cx="${n(32 - g - 2.4)}" cy="35.6" rx="2.3" ry="1.4"/><ellipse cx="${n(32 + g + 2.4)}" cy="35.6" rx="2.3" ry="1.4"/></g>`;
  if (!c.small && c.t.freckles)
    out += `<g fill="${darken(c.skin[1], 0.18)}" opacity=".7">${(
      [
        [-1, 0],
        [0.9, -0.6],
        [1.4, 0.9],
        [-0.4, 1.2],
      ] satisfies [number, number][]
    )
      .map(
        ([x, y]) =>
          `<circle cx="${n(32 - g - 1.8 + x)}" cy="${n(34.6 + y)}" r=".38"/><circle cx="${n(32 + g + 1.8 - x)}" cy="${n(34.6 + y)}" r=".38"/>`,
      )
      .join("")}</g>`;
  out += nose(c);
  out += `<g transform="translate(32 ${n(c.mouthY)})">${mouth(c)}</g>`;
  return out;
}

/* ───────────────────────────── accessories ───────────────────────────── */

function facialHair(
  t: FaceTraits,
  s: (typeof SHAPES)[number],
  p: Painter,
  hairHex: string,
  mouthY: number,
  small: boolean,
): string {
  if (!t.facial || small) return "";
  const { R, chin } = s;
  const L = 32 - R;
  const Rr = 32 + R;
  const beard = `M${n(L + 0.3)} 31C${n(L + 0.2)} 40 ${n(26)} ${n(chin + 2.4)} 32 ${n(chin + 2.4)}C38 ${n(chin + 2.4)} ${n(Rr - 0.2)} 40 ${n(Rr - 0.3)} 31L${n(Rr - 1.8)} 31C${n(Rr - 2.4)} 36 ${n(37.6)} ${n(mouthY - 2.6)} 32 ${n(mouthY - 2.4)}C${n(26.4)} ${n(mouthY - 2.6)} ${n(L + 2.4)} 36 ${n(L + 1.8)} 31Z`;
  const moust = `M${n(27)} ${n(mouthY - 1.4)}C29 ${n(mouthY - 3.4)} 31 ${n(mouthY - 2.8)} 32 ${n(mouthY - 2)}C33 ${n(mouthY - 2.8)} 35 ${n(mouthY - 3.4)} 37 ${n(mouthY - 1.4)}C35 ${n(mouthY - 0.5)} 33 ${n(mouthY - 0.9)} 32 ${n(mouthY - 1.2)}C31 ${n(mouthY - 0.9)} 29 ${n(mouthY - 0.5)} 27 ${n(mouthY - 1.4)}Z`;
  const goatee = `M29.2 ${n(mouthY + 1.8)}Q32 ${n(mouthY + 1)} 34.8 ${n(mouthY + 1.8)}Q34.4 ${n(chin + 1.6)} 32 ${n(chin + 1.8)}Q29.6 ${n(chin + 1.6)} 29.2 ${n(mouthY + 1.8)}Z`;
  switch (t.facial) {
    case 1:
      return p.shape(beard, hairHex, { hatch: true }) + p.shape(moust, hairHex);
    case 2:
      return p.shape(moust, hairHex);
    case 3:
      return p.shape(beard, hairHex, { line: false, alpha: 0.26 });
    default:
      return p.shape(goatee, hairHex) + p.shape(moust, hairHex);
  }
}

function glasses(t: FaceTraits, c: FeatureCtx, R: number): string {
  if (!t.glasses || c.small) return "";
  const g = t.eyeGap;
  const col = c.style === "sketch" || BR.key === "modern" ? c.ink : at([c.ink, "#6B3F22", BR.role.brass], t.frame);
  const w = c.style === "flat" ? 1.5 : 1.05;
  const lens = c.style === "flat" ? "" : `fill="#fff" fill-opacity=".16"`;
  const shape =
    t.glasses === 1
      ? (x: number) => `<circle cx="${n(x)}" cy="${EY}" r="3.5" ${lens || 'fill="none"'}/>`
      : (x: number) =>
          `<rect x="${n(x - 3.7)}" y="${EY - 2.7}" width="7.4" height="5.6" rx="1.6" ${lens || 'fill="none"'}/>`;
  const inner = t.glasses === 1 ? 3.5 : 3.7;
  return `<g stroke="${col}" stroke-width="${w}" stroke-linecap="round">${shape(32 - g)}${shape(32 + g)}<path d="M${n(32 - g + inner)} ${EY - 0.6}Q32 ${EY - 1.6} ${n(32 + g - inner)} ${EY - 0.6}" fill="none"/><path d="M${n(32 - g - inner)} ${EY - 0.8}L${n(32 - R + 0.4)} ${EY - 1.6}M${n(32 + g + inner)} ${EY - 0.8}L${n(32 + R - 0.4)} ${EY - 1.6}" fill="none"/></g>`;
}

function earrings(t: FaceTraits, R: number, small: boolean): string {
  if (!t.earring || small) return "";
  const xs = [32 - R + 0.2, 32 + R - 0.2];
  if (t.earring === 1)
    return xs
      .map(
        (x) =>
          `<circle cx="${n(x)}" cy="35.2" r=".95" fill="${BR.role.gold}" stroke="${darken(BR.role.gold, 0.35)}" stroke-width=".4"/>`,
      )
      .join("");
  return xs
    .map((x) => `<circle cx="${n(x)}" cy="36.9" r="1.8" fill="none" stroke="${BR.role.gold}" stroke-width=".85"/>`)
    .join("");
}

function hat(
  t: FaceTraits,
  R: number,
  p: Painter,
  theme: Theme,
  hue: { tile: string; text: string },
  small: boolean,
  mouthY: number,
): { under: string; over: string } {
  const L = 32 - R;
  const Rr = 32 + R;
  switch (t.hat) {
    case "beret": {
      const col = theme === "dark" ? BR.role.beretDark : BR.role.beret;
      return {
        under: "",
        over: `<g transform="rotate(-11 30 15)">${p.shape(`M15.4 17.6C15 11.4 22 8.6 30.4 8.8C39.6 9 45.6 12 45.4 16.4C45.2 19.6 39 20.6 30.4 20.4C22.4 20.2 15.6 20.4 15.4 17.6Z`, col)}${p.shape("M29.6 9.2L30 5.8L31.4 5.9L31.2 9.2Z", col)}${
          small ? "" : p.stroke("M18 17.6Q30 21 43.6 17", darken(col, 0.3), 0.8, ' opacity=".6"')
        }</g>`,
      };
    }
    case "hardhat":
      return {
        under: "",
        over: `${p.shape(`M${n(L - 1.6)} 22.4C${n(L - 1.8)} 11.6 ${n(Rr + 1.8)} 11.6 ${n(Rr + 1.6)} 22.4Z`, BR.role.hardhat)}${
          small ? "" : p.shape("M30.5 14.4Q32 13.9 33.5 14.4V21.8h-3Z", darken(BR.role.hardhat, 0.1))
        }${p.shape(`M${n(L - 4.2)} 21.6h${n(2 * R + 8.4)}a1.4 1.4 0 0 1 0 2.8h${n(-(2 * R + 8.4))}a1.4 1.4 0 0 1 0-2.8Z`, darken(BR.role.hardhat, 0.08))}`,
      };
    case "headset": {
      const band = `M${n(L - 1.4)} 30C${n(L - 2.2)} 9.6 ${n(Rr + 2.2)} 9.6 ${n(Rr + 1.4)} 30`;
      const cup = (x: number) =>
        p.shape(
          `M${n(x - 2.4)} 27.4h4.8a1.6 1.6 0 0 1 1.6 1.6v6.4a1.6 1.6 0 0 1-1.6 1.6h-4.8a1.6 1.6 0 0 1-1.6-1.6v-6.4a1.6 1.6 0 0 1 1.6-1.6Z`,
          BR.role.headset,
        );
      const boom = small
        ? ""
        : `${p.stroke(`M${n(L - 1)} 35.6Q${n(L - 0.2)} ${n(mouthY + 2.4)} ${n(26.4)} ${n(mouthY + 0.6)}`, BR.role.headset, 1.3)}${p.shape(`M24.6 ${n(mouthY - 0.6)}h3.2a1.2 1.2 0 0 1 0 2.4h-3.2a1.2 1.2 0 0 1 0-2.4Z`, hue.tile)}`;
      return {
        under: "",
        over: `${p.stroke(band, BR.role.headset, small ? 3 : 2.1)}${cup(L - 1)}${cup(Rr + 1)}${boom}`,
      };
    }
    case "monocle": {
      if (small) return { under: "", over: "" };
      const x = 32 + t.eyeGap;
      return {
        under: "",
        over: `<circle cx="${n(x)}" cy="${EY}" r="3.7" fill="#fff" fill-opacity=".22" stroke="${BR.role.brass}" stroke-width="1.3"/><path d="M${n(x - 2.1)} ${EY - 1.6}a2.6 2.6 0 0 1 2-1" stroke="#fff" stroke-width=".7" fill="none" stroke-linecap="round" opacity=".8"/><path d="M${n(x + 2.8)} ${EY + 2.4}Q${n(x + 6.2)} 42 ${n(x + 2)} 52" fill="none" stroke="${BR.role.brass}" stroke-width=".8" stroke-dasharray="1 1.1"/>`,
      };
    }
    case "cap":
      return {
        under: "",
        over: `${p.shape(`M${n(L - 1.4)} 23.4C${n(L - 1.6)} 12.6 ${n(Rr - 2)} 10.4 ${n(Rr + 1.4)} 18.8C${n(Rr + 4.6)} 19.6 ${n(Rr + 5.2)} 22.6 ${n(Rr + 1.6)} 23.4Z`, BR.role.cap)}${
          small
            ? ""
            : `${p.stroke(`M${n(L)} 21Q32 19 ${n(Rr - 1)} 20.6`, darken(BR.role.cap, 0.35), 0.8, ' opacity=".7"')}<circle cx="${n(32 + 1)}" cy="13.6" r=".9" fill="${darken(BR.role.cap, 0.3)}"/>`
        }`,
      };
    case "pencil": {
      if (small) return { under: "", over: "" };
      const x = Rr + 0.6;
      return {
        under: `<g transform="rotate(-38 ${n(x)} 24)">${p.shape(`M${n(x - 1.2)} 12h2.4v14h-2.4Z`, BR.role.pencil)}${p.shape(`M${n(x - 1.2)} 12h2.4v-2.2h-2.4Z`, "#E58C8C")}${p.shape(`M${n(x - 1.2)} 26h2.4l-1.2 2.6Z`, "#E9C99A")}</g>`,
        over: "",
      };
    }
    case "readers": {
      if (small) return { under: "", over: "" };
      const g = t.eyeGap;
      const y = EY + 2.2;
      const half = (x: number) =>
        `<path d="M${n(x - 3.4)} ${y}h6.8Q${n(x + 3.2)} ${y + 3.6} ${n(x)} ${y + 3.6}Q${n(x - 3.2)} ${y + 3.6} ${n(x - 3.4)} ${y}Z" fill="#fff" fill-opacity=".2"/>`;
      return {
        under: "",
        over: `<g stroke="${BR.role.brass}" stroke-width="1" stroke-linejoin="round">${half(32 - g)}${half(32 + g)}<path d="M${n(32 - g + 3.4)} ${y}Q32 ${y - 1} ${n(32 + g - 3.4)} ${y}M${n(32 - g - 3.4)} ${y}L${n(L + 0.4)} ${EY - 1.4}M${n(32 + g + 3.4)} ${y}L${n(Rr - 0.4)} ${EY - 1.4}" fill="none"/></g>`,
      };
    }
    default:
      return { under: "", over: "" };
  }
}

function rosettePath(cx: number, cy: number, r: number): string {
  let d = "";
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const rr = r + 0.45 * Math.cos(12 * a);
    d += `${i ? "L" : "M"}${n(cx + rr * Math.cos(a))} ${n(cy + rr * Math.sin(a))}`;
  }
  return `${d}Z`;
}

function rosette(p: Painter, theme: Theme, small: boolean): string {
  const accent = theme === "dark" ? BR.role.ribDark : BR.role.rib;
  if (small) return "";
  return `${p.shape("M18.8 58.6L17.4 64.8L19.6 63.6L21 65.2L21.8 58.6Z", accent)}${p.shape("M22.4 58.6L23.2 65.2L24.6 63.6L26.8 64.8L25.4 58.6Z", accent)}${p.shape(rosettePath(22.4, 57, 3.6), BR.role.gold)}<circle cx="22.4" cy="57" r="1.9" fill="none" stroke="${darken(BR.role.gold, 0.32)}" stroke-width=".6"/><path d="M22.4 55.6l.45.9 1 .15-.72.7.17 1-.9-.47-.9.47.17-1-.72-.7 1-.15z" fill="${darken(BR.role.gold, 0.4)}"/>`;
}

function clothing(t: FaceTraits, p: Painter, cloth: string, skin: [string, string, string], small: boolean): string {
  let out = p.shape(SHOULDERS, cloth);
  if (small) return out;
  const dk = darken(cloth, 0.22);
  const cream = "#F4EEE3";
  if (t.role === "orchestrator") {
    // blazer over a cream shirt
    out += p.shape("M25.6 51.2L32 62.6L38.4 51.2Q32 54.8 25.6 51.2Z", cream);
    out += p.shape("M25.6 51.2L30.4 59.6L27.2 66L21.4 52.4Z", darken(cloth, 0.12));
    out += p.shape("M38.4 51.2L33.6 59.6L36.8 66L42.6 52.4Z", darken(cloth, 0.12));
    return out;
  }
  switch (t.clothing) {
    case 0:
      out += p.stroke("M26.4 51.6Q32 56.4 37.6 51.6", dk, 1.4);
      break;
    case 1:
      out += p.shape("M26.6 51.3L32 58.4L37.4 51.3Q32 54.4 26.6 51.3Z", skin[1]);
      break;
    case 2:
      out +=
        p.shape("M26 51L31.6 56.4L27.6 58.6L24 52.4Z", cream) + p.shape("M38 51L32.4 56.4L36.4 58.6L40 52.4Z", cream);
      break;
    case 3:
      out += p.shape("M27 44.6H37V52.6Q32 54.6 27 52.6Z", dk);
      break;
    default:
      out += p.shape("M18.6 53.6C20.6 46.6 43.4 46.6 45.4 53.6Q32 58.6 18.6 53.6Z", dk);
      out += p.stroke("M29.6 55.6V61M34.4 55.6V61", lighten(cloth, 0.5), 0.9);
  }
  return out;
}

/* ───────────────────────────── overlays ───────────────────────────── */

const tok = (th: Theme) => BRAND_HUES[BR.key][th];
const WARN = {
  get light() {
    return BR.key === "craft" ? "#E2A23B" : tok("light").warn;
  },
  get dark() {
    return tok("dark").warn;
  },
};
const DANGER = {
  get light() {
    return tok("light").danger;
  },
  get dark() {
    return tok("dark").danger;
  },
};
const SUCCESS = {
  get light() {
    return BR.key === "modern" ? "#157F4A" : "#2F7A47";
  },
  get dark() {
    return BR.key === "modern" ? "#4ADE80" : "#7CC48F";
  },
};
const CANVAS = {
  get light() {
    return tok("light").canvas;
  },
  get dark() {
    return tok("dark").canvas;
  },
};

function bubble(theme: Theme, anim: boolean): string {
  const dots = [0, 1, 2]
    .map(
      (i) =>
        `<circle cx="${50.4 + i * 4.2}" cy="10.2" r="1.35" fill="${INK}">${
          anim
            ? `<animate attributeName="opacity" values=".3;1;.3" dur="1.2s" begin="${i * 0.2}s" repeatCount="indefinite"/>`
            : ""
        }</circle>`,
    )
    .join("");
  const bob = anim
    ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0" dur="2.4s" repeatCount="indefinite"/>`
    : "";
  return `<g><path d="M47.6 3.4h12.6a3.2 3.2 0 0 1 3.2 3.2v7.2a3.2 3.2 0 0 1-3.2 3.2h-7.4l-3.8 3.4v-3.4h-1.4a3.2 3.2 0 0 1-3.2-3.2V6.6a3.2 3.2 0 0 1 3.2-3.2z" fill="${WARN[theme]}" stroke="${CANVAS[theme]}" stroke-width="1.6" stroke-linejoin="round"/>${dots}${bob}</g>`;
}

function badge(state: FaceState, theme: Theme, anim: boolean, small: boolean): string {
  const ring = CANVAS[theme];
  const cx = 54.5;
  const cy = 54.5;
  const r = small ? 8.5 : 6.6;
  const base = (fill: string) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${ring}" stroke-width="${small ? 3.4 : 2.6}"/>`;
  switch (state) {
    case "working": {
      const spin = anim
        ? `<animateTransform attributeName="transform" type="rotate" values="0 ${cx} ${cy};360 ${cx} ${cy}" dur="1.1s" repeatCount="indefinite"/>`
        : "";
      return `${base(tok(theme).accent)}<path d="M${cx} ${cy - r * 0.52}a${n(r * 0.52)} ${n(r * 0.52)} 0 1 1-${n(r * 0.52)} ${n(r * 0.52)}" fill="none" stroke="#fff" stroke-width="${small ? 2.4 : 1.6}" stroke-linecap="round">${spin}</path>`;
    }
    case "waiting":
      return small ? `${base(WARN[theme])}<circle cx="${cx}" cy="${cy}" r="2" fill="${INK}"/>` : "";
    case "failed":
      return `${base(DANGER[theme])}<path d="M${cx} ${cy - r * 0.5}v${n(r * 0.55)}" stroke="#fff" stroke-width="${small ? 2.6 : 1.8}" stroke-linecap="round"/><circle cx="${cx}" cy="${n(cy + r * 0.45)}" r="${small ? 1.4 : 1}" fill="#fff"/>`;
    case "success":
      return `${base(SUCCESS[theme])}<path d="M${n(cx - r * 0.45)} ${cy}l${n(r * 0.3)} ${n(r * 0.32)} ${n(r * 0.6)}-${n(r * 0.62)}" fill="none" stroke="${theme === "dark" ? INK : "#fff"}" stroke-width="${small ? 2.6 : 1.7}" stroke-linecap="round" stroke-linejoin="round"/>`;
    default:
      return "";
  }
}

function sweat(anim: boolean, x = 47.6, y = 18.4): string {
  const a = anim
    ? `<animateTransform attributeName="transform" type="translate" values="0 -1;0 2.4;0 2.4" keyTimes="0;.7;1" dur="2.2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.15;.7;1" dur="2.2s" repeatCount="indefinite"/>`
    : "";
  return `<path d="M${x} ${y}c0 0-2.4 3.1-2.4 4.7a2.4 2.4 0 0 0 4.8 0c0-1.6-2.4-4.7-2.4-4.7z" fill="${BR.role.sweat}" stroke="${INK}" stroke-width=".7">${a}</path>`;
}

/** Two "z" marks by the head of a sleeping face. With motion, they rise and fade one after the other. */
function snore(anim: boolean, theme: Theme): string {
  const mark = (x: number, y: number, s: number, delay: number) => {
    const d = `M${x} ${y}h${s}l${-s} ${s}h${s}`;
    const path = `<path d="${d}" fill="none" stroke="${tok(theme).ink}" stroke-width="${n(s * 0.34)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (!anim) return path;
    return `<g opacity="0">${path}<animateTransform attributeName="transform" type="translate" values="0 2;2 -4" dur="3s" begin="${delay}s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.2;.65;1" dur="3s" begin="${delay}s" repeatCount="indefinite"/></g>`;
  };
  return mark(50, 8, 5, 0) + mark(57, 1, 3.6, 1.5);
}

function sparkles(anim: boolean, theme: Theme): string {
  const star = (x: number, y: number, s: number, d: number) =>
    `<path d="M${x} ${y - s}Q${x} ${y} ${x + s} ${y}Q${x} ${y} ${x} ${y + s}Q${x} ${y} ${x - s} ${y}Q${x} ${y} ${x} ${y - s}Z" fill="${WARN[theme]}">${
      anim ? `<animate attributeName="opacity" values="0;1;0" dur="1.6s" begin="${d}s" repeatCount="indefinite"/>` : ""
    }</path>`;
  return star(10, 12, 3.6, 0) + star(54, 9, 2.8, 0.7);
}

/* ───────────────────────────── families ───────────────────────────── */

interface Ctx {
  t: FaceTraits;
  state: FaceState;
  theme: Theme;
  anim: boolean;
  small: boolean;
  uid: string;
  hue: ReturnType<typeof agentHue>;
  hueDeg: number;
  /** One skin tone for every agent (not "varied"). */
  toned: boolean;
}

function figureMotion(inner: string, c: Ctx): string {
  if (!c.anim) {
    if (c.state === "waiting") return `<g transform="rotate(3 32 50)">${inner}</g>`;
    return inner;
  }
  if (c.state === "working")
    return `<g>${inner}<animateTransform attributeName="transform" type="rotate" values="0 32 50;-1.6 32 50;0 32 50;1.2 32 50;0 32 50" dur="3.2s" repeatCount="indefinite"/></g>`;
  if (c.state === "waiting")
    return `<g transform="rotate(3 32 50)"><g>${inner}<animateTransform attributeName="transform" type="translate" values="0 0;0 -.6;0 0" dur="2.4s" repeatCount="indefinite"/></g></g>`;
  if (c.state === "success")
    return `<g>${inner}<animateTransform attributeName="transform" type="translate" values="0 0;0 -1.2;0 0;0 0" keyTimes="0;.15;.32;1" dur="2.2s" repeatCount="indefinite"/></g>`;
  if (c.state === "failed") return inner;
  if (c.state === "sleeping")
    return `<g>${inner}<animateTransform attributeName="transform" type="translate" values="0 0;0 .8;0 0" dur="4.2s" repeatCount="indefinite"/></g>`;
  return `<g>${inner}<animateTransform attributeName="transform" type="translate" values="0 0;0 -.55;0 0" dur="${c.t.breathe}s" repeatCount="indefinite"/></g>`;
}

/** portrait · sketch · clay share the organic rig. */
function renderOrganic(style: "portrait" | "sketch" | "clay", c: Ctx): string {
  const { t, theme, small } = c;
  const p = makePainter(style, c.uid, theme, small);
  const s = at(SHAPES, t.shape);
  const skin = at(SKINS, t.skin);
  const hairHex = HAIR[t.hairColor];
  const hasHat = t.hat === "beret" || t.hat === "hardhat" || t.hat === "cap";
  const hp = hairParts(t.hair, s.R);
  const mouthY = s.chin - 6.2;
  const noseY = 35.4;
  const failed = c.state === "failed";
  const cloth = failed ? c.hue.muted : c.hue.tile;
  const fc: FeatureCtx = {
    t,
    state: c.state,
    anim: c.anim,
    small,
    style,
    ink: p.ink,
    skin,
    hairHex,
    mouthY,
    noseY,
    xEyes: false,
  };

  // tile
  let tile: string;
  let clip: string;
  if (style === "clay") {
    const gid = `${c.uid}bg`;
    p.defs.push(
      `<radialGradient id="${gid}" cx=".35" cy=".25" r="1"><stop offset="0" stop-color="${lighten(c.hue.tint, theme === "dark" ? 0.08 : 0.35)}"/><stop offset="1" stop-color="${theme === "dark" ? c.hue.tint : darken(c.hue.tint, 0.08)}"/></radialGradient>`,
    );
    clip = `<circle cx="32" cy="32" r="30"/>`;
    tile = `<circle cx="32" cy="32" r="30" fill="url(#${gid})"/>`;
  } else if (style === "sketch") {
    const paper = theme === "dark" ? "#26211C" : "#FFFDF8";
    clip = `<rect x="2" y="2" width="60" height="60" rx="14"/>`;
    const blob = bumpy(
      31 + (hash32(`${t.seed}:wx`) % 5) - 2,
      30,
      21,
      2.6,
      5 + (hash32(`${t.seed}:wl`) % 3),
      hash32(`${t.seed}:wa`) % 6,
    );
    tile = `<rect x="2" y="2" width="60" height="60" rx="14" fill="${paper}"/><path d="${blob}" fill="${c.hue.tile}" opacity="${theme === "dark" ? 0.32 : 0.2}"/>`;
    if (!small) tile += `<path d="M8 50.5H56M8 56.5H56" stroke="${p.ink}" stroke-width=".35" opacity=".18"/>`;
  } else {
    clip = `<rect x="2" y="2" width="60" height="60" rx="15"/>`;
    tile = `<rect x="2" y="2" width="60" height="60" rx="15" fill="${c.hue.tint}"/>`;
    if (!small && BR.halftone) {
      const hid = `${c.uid}ht`;
      p.defs.push(
        `<pattern id="${hid}" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><circle cx="1.5" cy="1.5" r=".55" fill="${c.hue.tile}"/></pattern>`,
      );
      tile += `<path d="M2 40Q20 30 62 44V62H2Z" fill="url(#${hid})" opacity=".55"/>`;
    }
    if (!small && BR.grain) {
      // paper grain: a few deterministic specks
      let specks = "";
      for (let i = 0; i < 26; i++) {
        const h = hash32(`grain:${i}`);
        specks += `<circle cx="${4 + (h % 56)}" cy="${4 + ((h >>> 8) % 56)}" r="${0.25 + ((h >>> 16) % 3) * 0.12}"/>`;
      }
      tile += `<g fill="${theme === "dark" ? "#fff" : INK}" opacity="${theme === "dark" ? 0.07 : 0.08}">${specks}</g>`;
    }
  }
  p.defs.push(`<clipPath id="${c.uid}c">${clip}</clipPath>`);

  const hairPaint = (d: string | undefined, back = false) =>
    d
      ? p.shape(d, hairHex, {
          alpha: hp.soft ? (style === "sketch" ? 0.5 : 0.62) : undefined,
          line: hp.soft ? false : undefined,
          hatch: !back && !hp.soft && style === "sketch",
        })
      : "";

  let fig = "";
  fig += clothing(t, p, cloth, skin, small);
  if (!small && hp.back) fig += hairPaint(hp.back, true);
  fig += p.shape(NECK, skin[1]);
  if (!small && t.clothing === 3 && t.role !== "orchestrator")
    fig += p.shape("M27 46.6H37V52.6Q32 54.6 27 52.6Z", darken(cloth, 0.22));
  const h = hat(t, s.R, p, theme, c.hue, small, mouthY);
  fig += h.under;
  // ears
  const L = 32 - s.R;
  const Rr = 32 + s.R;
  fig += p.shape(`M${n(L + 0.6)} 28.4C${n(L - 3)} 27.4 ${n(L - 3)} 36.4 ${n(L + 0.8)} 35.4Z`, skin[0]);
  fig += p.shape(`M${n(Rr - 0.6)} 28.4C${n(Rr + 3)} 27.4 ${n(Rr + 3)} 36.4 ${n(Rr - 0.8)} 35.4Z`, skin[0]);
  // head
  const head = headPath(s);
  fig += p.shape(head, skin[0]);
  if (style === "portrait" && !small) {
    // soft side shade + chin shadow, clipped to the head
    p.defs.push(`<clipPath id="${c.uid}hd"><path d="${head}"/></clipPath>`);
    fig += `<g clip-path="url(#${c.uid}hd)"><ellipse cx="${n(Rr + 4)}" cy="34" rx="7" ry="16" fill="${skin[1]}" opacity=".45"/><ellipse cx="32" cy="${n(TOP - 1)}" rx="${n(s.R + 2)}" ry="5" fill="${skin[1]}" opacity=".35"/></g>`;
  }
  if (style === "clay" && !small) fig += `<ellipse cx="27" cy="22" rx="5.4" ry="2.6" fill="#fff" opacity=".18"/>`;
  fig += facialHair(t, s, p, hairHex, mouthY, small);
  fig += features(fc);
  if (t.facial === 1 && !small && c.state !== "talking" && c.state !== "success") {
    // re-draw moustache over the mouth line for full beards
  }
  fig += hairPaint(hp.front);
  if (!small && hp.shine && style !== "sketch")
    fig += p.stroke(hp.shine, lighten(hairHex, 0.28), 0.9, ' opacity=".55"');
  if (!hasHat && hp.top) fig += p.shape(hp.top, hairHex, { hatch: style === "sketch" });
  fig += earrings(t, s.R, small);
  fig += glasses(t, fc, s.R);
  fig += h.over;
  if (t.role === "orchestrator") fig += rosette(p, theme, small);
  if (!small && failed) fig += sweat(c.anim);

  let out = tile;
  const scale = small ? `<g transform="translate(32 33) scale(1.28) translate(-32 -31)">` : "<g>";
  out += `<g clip-path="url(#${c.uid}c)">${scale}${figureMotion(fig, c)}</g></g>`;
  if (style === "sketch" && !small)
    out += `<rect x="2.5" y="2.5" width="59" height="59" rx="13.6" fill="none" stroke="${p.ink}" stroke-width=".6" opacity=".35"/>`;
  return `<defs>${p.defs.join("")}</defs>${out}`;
}

/* flat: geometric, no outlines */
function renderFlat(c: Ctx): string {
  const { t, theme, small } = c;
  const p = makePainter("flat", c.uid, theme, small);
  const skin = at(SKINS, t.skin);
  const hairHex = HAIR[t.hairColor];
  const failed = c.state === "failed";
  const bg = failed ? c.hue.muted : c.hue.tile;
  const cloth = theme === "dark" ? oklch(0.3, 0.05, c.hueDeg) : oklch(0.94, 0.03, c.hueDeg);
  const cx = 32;
  const cy = 30.5;
  const r = 12.4;
  const hasHat = t.hat === "beret" || t.hat === "hardhat" || t.hat === "cap";
  const style = t.hair % 7;
  let back = "";
  let front = "";
  switch (style) {
    case 0: // cap with diagonal fringe
      front = `M${cx - r - 0.3} ${cy}A${r + 0.3} ${r + 0.3} 0 0 1 ${cx + r + 0.3} ${cy}L${cx + r + 0.3} ${cy - 3}L${cx - r + 4} ${cy - 7.6}L${cx - r - 0.3} ${cy - 3}Z`;
      break;
    case 1: // side swoop quarter
      front = `M${cx - r - 0.6} ${cy + 1}A${r + 0.6} ${r + 0.6} 0 0 1 ${cx + r + 0.6} ${cy - 1}Q${cx + 2} ${cy - 10.6} ${cx - r + 2} ${cy - 4}L${cx - r + 0.8} ${cy + 1}Z`;
      break;
    case 2: // long: slab behind + centre part
      back = `M${cx - r - 2.4} ${cy}A${r + 2.4} ${r + 2.4} 0 0 1 ${cx + r + 2.4} ${cy}L${cx + r + 3} ${cy + 17}Q${cx + r + 0.4} ${cy + 20.4} ${cx + r - 3.2} ${cy + 17.6}L${cx + r - 3.6} ${cy + 7}H${cx - r + 3.6}L${cx - r + 3.2} ${cy + 17.6}Q${cx - r - 0.4} ${cy + 20.4} ${cx - r - 3} ${cy + 17}Z`;
      front = `M${cx - r - 0.4} ${cy + 2}A${r + 0.4} ${r + 0.4} 0 0 1 ${cx + r + 0.4} ${cy + 2}Q${cx + r - 2} ${cy - 8.4} ${cx} ${cy - 9.6}Q${cx - r + 2} ${cy - 8.4} ${cx - r - 0.4} ${cy + 2}Z`;
      break;
    case 3: // round bob with straight fringe
      back = `M${cx - r - 2.6} ${cy}A${r + 2.6} ${r + 2.6} 0 0 1 ${cx + r + 2.6} ${cy}V${cy + 12}H${cx - r - 2.6}Z`;
      front = `M${cx - r - 0.5} ${cy - 1}A${r + 0.5} ${r + 0.5} 0 0 1 ${cx + r + 0.5} ${cy - 1}V${cy - 5.4}H${cx - r - 0.5}Z`;
      break;
    case 4: // big round curls
      back = `M${cx} ${cy - 3.6}m-${r + 6} 0a${r + 6} ${r + 6} 0 1 0 ${2 * (r + 6)} 0a${r + 6} ${r + 6} 0 1 0-${2 * (r + 6)} 0`;
      front = `M${cx - r} ${cy - 1}A${r} ${r} 0 0 1 ${cx + r} ${cy - 1}Q${cx} ${cy - 9} ${cx - r} ${cy - 1}Z`;
      break;
    case 5: // bun
      front = `M${cx - r - 0.2} ${cy - 1}A${r + 0.2} ${r + 0.2} 0 0 1 ${cx + r + 0.2} ${cy - 1}Q${cx} ${cy - 7.6} ${cx - r - 0.2} ${cy - 1}Z`;
      if (!hasHat) back = `M${cx} ${cy - r - 3.2}m-4.6 0a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0-9.2 0`;
      break;
    default: // short buzz
      front = `M${cx - r} ${cy - 1}A${r} ${r} 0 0 1 ${cx + r} ${cy - 1}Q${cx} ${cy - 8.6} ${cx - r} ${cy - 1}Z`;
  }
  let fig = "";
  fig += `<path d="M10 66C10 54 20 50.6 32 50.6S54 54 54 66Z" fill="${failed ? c.hue.muted : cloth}"/>`;
  if (back) fig += p.shape(back, hairHex);
  fig += `<rect x="28" y="38" width="8" height="13" rx="3" fill="${skin[1]}"/>`;
  if (t.role === "orchestrator" && !small)
    fig += `<path d="M26.4 51.2L32 58L37.6 51.2Z" fill="${theme === "dark" ? oklch(0.5, 0.08, c.hueDeg) : c.hue.tile}"/>`;
  fig += `<circle cx="${cx - r}" cy="${cy + 1.6}" r="2.6" fill="${skin[0]}"/><circle cx="${cx + r}" cy="${cy + 1.6}" r="2.6" fill="${skin[0]}"/>`;
  fig += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${skin[0]}"/>`;
  if ((t.facial === 1 || t.facial === 4) && !small)
    fig += `<path d="M${cx - r + 0.6} ${cy + 2.6}A${r - 0.6} ${r - 0.6} 0 0 0 ${cx + r - 0.6} ${cy + 2.6}Q${cx + r - 2} ${cy + 10.6} ${cx} ${cy + 10.2}Q${cx - r + 2} ${cy + 10.6} ${cx - r + 0.6} ${cy + 2.6}Z" fill="${hairHex}"/>`;
  if (t.facial === 3 && !small)
    fig += `<path d="M${cx - r + 0.6} ${cy + 2.6}A${r - 0.6} ${r - 0.6} 0 0 0 ${cx + r - 0.6} ${cy + 2.6}Q${cx} ${cy + 6} ${cx - r + 0.6} ${cy + 2.6}Z" fill="${hairHex}" opacity=".25"/>`;
  const fc: FeatureCtx = {
    t,
    state: c.state,
    anim: c.anim,
    small,
    style: "flat",
    ink: p.ink,
    skin,
    hairHex,
    mouthY: cy + 7.4,
    noseY: cy + 4.4,
    xEyes: true,
  };
  fig += features(fc);
  if ((t.facial === 1 || t.facial === 2 || t.facial === 4) && !small)
    fig += `<path d="M28.6 ${cy + 5.6}Q32 ${cy + 3.6} 35.4 ${cy + 5.6}Q32 ${cy + 6.6} 28.6 ${cy + 5.6}Z" fill="${hairHex}"/>`;
  fig += p.shape(front, hairHex);
  fig += earrings({ ...t }, r, small)
    .replace(/35\.2/g, String(cy + 4.6))
    .replace(/36\.9/g, String(cy + 5.8));
  fig += glasses(t, { ...fc }, r).replace(new RegExp(`cy="${EY}"`, "g"), `cy="${EY}"`);
  const h = hat({ ...t }, r, p, theme, c.hue, small, cy + 7.4);
  fig += h.under + h.over;
  if (t.role === "orchestrator" && !small)
    fig += `<path d="${rosettePath(21.6, 57.4, 3.4)}" fill="${BR.role.gold}"/><circle cx="21.6" cy="57.4" r="1.6" fill="${darken(BR.role.gold, 0.25)}"/>`;
  if (!small && failed) fig += sweat(c.anim, 47, 17);
  p.defs.push(`<clipPath id="${c.uid}c"><circle cx="32" cy="32" r="30"/></clipPath>`);
  const scale = small ? `<g transform="translate(32 33) scale(1.26) translate(-32 -31)">` : "<g>";
  return `<defs>${p.defs.join("")}</defs><circle cx="32" cy="32" r="30" fill="${bg}"/><g clip-path="url(#${c.uid}c)">${scale}${figureMotion(fig, c)}</g></g>`;
}

/* character: the Living Workshop maker, in Atelier ink */
function renderCharacter(c: Ctx): string {
  const { t, theme, small } = c;
  const line = theme === "dark" ? BR.inkDark : BR.ink;
  const failed = c.state === "failed";
  // With one skin tone for every agent, the character wears it too; else the agent's hue.
  const fill = failed
    ? oklch(theme === "dark" ? 0.72 : 0.8, 0.012, c.hueDeg)
    : c.toned
      ? mix(SKINS[t.skin]?.[0] ?? "#F6D9C6", SKINS[t.skin]?.[1] ?? "#E6B89E", 0.45)
      : oklch(theme === "dark" ? 0.8 : 0.84, 0.085, c.hueDeg);
  const p = makePainter("portrait", c.uid, theme, small);
  const sw = small ? 3 : 2.2;
  const st = `fill="${fill}" stroke="${line}" stroke-width="${sw}" stroke-linejoin="round"`;
  const top = at([16, 16, 13, 19], t.body);
  const body = at(
    [
      `<circle cx="32" cy="37" r="21" ${st}/>`,
      `<rect x="11" y="16" width="42" height="42" rx="15" ${st}/>`,
      `<rect x="14" y="13" width="36" height="46" rx="18" ${st}/>`,
      `<ellipse cx="32" cy="38" rx="24" ry="19" ${st}/>`,
    ],
    t.body,
  );
  const ey = t.body === 2 ? 33 : 35;
  const gap = at([7.4, 8.4, 9.4], t.eyes % 3);
  // reuse the expression engine at character scale
  const skin: [string, string, string] = [fill, darken(fill, 0.1), "#E07A7A"];
  const fc: FeatureCtx = {
    t: { ...t, eyeGap: gap, brow: t.brow, browW: 1.8, eyes: t.eyes === 1 ? 1 : 0, mouth: t.mouth },
    state: c.state,
    anim: c.anim,
    small,
    style: "character",
    ink: INK,
    skin,
    hairHex: "#3B2F28",
    mouthY: 0,
    noseY: 0,
    xEyes: true,
  };
  const scale = small ? 1.05 : 1.45;
  const g = (inner: string, y: number) =>
    `<g transform="translate(0 ${y}) translate(32 0) scale(${scale}) translate(-32 0)">${inner}</g>`;
  // eyes + brows (from the shared engine), mouth separately so it sits lower
  const eyesOnly = `<g transform="translate(${n(32 + gap / scale)} 0)">${blinkWrap(eye(fc, 1), fc)}</g><g transform="translate(${n(32 - gap / scale)} 0) scale(-1 1)">${blinkWrap(eye(fc, -1), fc)}</g>`;
  const brows = small
    ? ""
    : `<g transform="translate(${n(32 + gap / scale)} -4.4)">${brow({ ...fc, hairHex: "#3B2F28" })}</g><g transform="translate(${n(32 - gap / scale)} -4.4) scale(-1 1)">${brow({ ...fc, hairHex: "#3B2F28" })}</g>`;
  let face = g(eyesOnly + brows, ey);
  if ((t.blush || c.state === "success") && !small && !failed)
    face += `<g fill="${BR.role.blush}" opacity=".42"><circle cx="${n(32 - gap - 3.6)}" cy="${ey + 6}" r="3"/><circle cx="${n(32 + gap + 3.6)}" cy="${ey + 6}" r="3"/></g>`;
  face += `<g transform="translate(32 ${ey + 9.6}) scale(${small ? 1.1 : 1.5})">${mouth({ ...fc, mouthY: 0 })}</g>`;
  // accessories, C-style
  const other = oklch(0.78, 0.09, (c.hueDeg + 150) % 360);
  const a = `stroke="${line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"`;
  let acc = "";
  if (t.role === "orchestrator") {
    const cy = top - 9;
    let d = "";
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? 2.6 : 6;
      const an = -Math.PI / 2 + (i * Math.PI) / 5;
      d += `${i ? "L" : "M"}${n(32 + rr * Math.cos(an))} ${n(cy + rr * Math.sin(an))}`;
    }
    acc += `<path d="M32 ${top + 1}V${cy + 4}" ${a}/><path d="${d}Z" fill="${BR.role.gold}" ${a}/>`;
  }
  if (!small || t.role !== "orchestrator") {
    switch (t.hat) {
      case "beret":
        acc += `<g transform="rotate(-14 30 ${top + 1})"><ellipse cx="30" cy="${top + 1}" rx="15" ry="5.4" fill="${theme === "dark" ? BR.role.beretDark : BR.role.beret}" ${a}/><path d="M30 ${top - 4.4}v-3" ${a}/></g>`;
        break;
      case "hardhat":
        acc += `<path d="M17.4 ${top + 7}a14.6 13 0 0 1 29.2 0z" fill="${BR.role.hardhat}" ${a}/><path d="M32 ${top - 6}v6" ${a}/><path d="M13.6 ${top + 7.4}h36.8" stroke="${line}" stroke-width="3.4" stroke-linecap="round"/>`;
        break;
      case "headset":
        acc += `<path d="M12.6 38a19.4 21 0 0 1 38.8 0" fill="none" stroke="${line}" stroke-width="2.8"/><rect x="8.4" y="33" width="7" height="11" rx="3.2" fill="${other}" ${a}/><rect x="48.6" y="33" width="7" height="11" rx="3.2" fill="${other}" ${a}/>${small ? "" : `<path d="M12 44q1 7 9 7.4" fill="none" ${a}/><circle cx="22" cy="51.4" r="1.9" fill="${line}"/>`}`;
        break;
      case "monocle":
        if (!small)
          acc += `<circle cx="${n(32 + gap)}" cy="${ey}" r="6" fill="#fff" fill-opacity=".3" stroke="${BR.role.brass}" stroke-width="2"/><path d="M${n(38 + gap)} ${ey + 1}q3 6 0 13" fill="none" stroke="${BR.role.brass}" stroke-width="1.4" stroke-dasharray="1.6 1.6"/>`;
        break;
      case "cap":
        acc += `<path d="M18 ${top + 7.4}a14 12 0 0 1 28 0z" fill="${BR.role.cap}" ${a}/><path d="M40 ${top + 7.4}h13" stroke="${line}" stroke-width="3.4" stroke-linecap="round"/>`;
        break;
      case "pencil":
        if (!small)
          acc += `<g transform="rotate(32 46 ${top + 2})"><rect x="44.4" y="${top - 10}" width="3.4" height="15" rx=".6" fill="${BR.role.pencil}" ${a}/><path d="M44.4 ${top - 10}h3.4v-2.6h-3.4z" fill="#E58C8C" ${a}/></g>`;
        break;
      case "readers":
        if (!small)
          acc += `<g fill="#fff" fill-opacity=".3" ${a}><circle cx="${n(32 - gap)}" cy="${ey}" r="5"/><circle cx="${n(32 + gap)}" cy="${ey}" r="5"/></g><path d="M${n(32 - gap + 5)} ${ey}h${n(2 * gap - 10)}" ${a}/>`;
        break;
      default:
        if (t.role !== "orchestrator" && !small)
          acc += `<path d="M32 ${top + 1}q0-6-1.2-9" fill="none" ${a}/><path d="M30.8 ${top - 8}c-5-4-10-1.6-10.6 1.8 4.4 1.8 8.4 1 10.6-1.8z" fill="#7CB98A" ${a}/><path d="M31 ${top - 6}c3.4-4.6 8.6-3.6 9.8-.6-3.6 2.6-7.6 2.6-9.8.6z" fill="#7CB98A" ${a}/>`;
    }
  }
  let char = body + face + acc;
  if (!small && failed) char += sweat(c.anim, 12, 18).replace(`stroke="${INK}"`, `stroke="${line}"`);
  void p;
  return figureMotion(char, c);
}

/* ───────────────────────────── entry ───────────────────────────── */

export function resolveStyle(id: string, style?: FaceStyle | "auto"): FaceStyle {
  if (!style) return "portrait";
  if (style === "auto") return at(FACE_STYLES, hash32(`${id}:style`) % FACE_STYLES.length);
  return style;
}

export function agentFaceSVG(opts: FaceOptions): string {
  const state = opts.state ?? "idle";
  const theme = opts.theme ?? "light";
  const size = opts.size ?? 48;
  const anim = opts.animate ?? true;
  const style = resolveStyle(opts.id, opts.style);
  const t = faceTraits(opts.id, opts.name, { seed: opts.seed, role: opts.role, hue: opts.hue, skin: opts.skin });
  const toned = opts.skin !== "varied";
  const small = size <= 24;
  const brand: Brand = opts.brand ?? "craft";
  BR = BRAND_SPECS[brand];
  const hueDeg = (BRAND_HUES[brand].hueOffset + t.hue * 30) % 360;
  const uid = `af${hash32(`${opts.id}|${t.seed}|${t.skin}|${toned}|${style}|${state}|${theme}|${small}|${anim}|${brand}`).toString(36)}`;
  // A face is never inverted: in a dark UI it is drawn exactly as in a light one, dark ink on its own
  // light paper, with the same skin. Only the overlays (badge ring, bubble) follow the UI theme.
  const c: Ctx = { t, state, theme: "light", anim, small, uid, hue: agentHue(brand, t.hue, "light"), hueDeg, toned };
  let body: string;
  if (style === "flat") body = renderFlat(c);
  else if (style === "character") {
    // The character has no tile of its own; on a dark UI it stands on a light paper disc.
    const disc = theme === "dark" ? `<circle cx="32" cy="34" r="30" fill="${c.hue.tint}"/>` : "";
    body = disc + renderCharacter(c);
  } else body = renderOrganic(style, c);
  // overlays outside the clip
  if (state === "waiting" && !small) body += bubble(theme, anim);
  if (state === "success" && !small) body += sparkles(anim, theme);
  if (state === "sleeping" && !small) body += snore(anim, theme);
  if (small || state === "failed" || state === "success" || state === "working")
    body += badge(state, theme, anim, small);
  const label = `${opts.name ?? opts.id}${state === "idle" ? "" : ` — ${state}`}`.replace(/[<&"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${label}" style="overflow:visible">${body}</svg>`;
}

/** Helper for "re-roll": the nth alternative seed for an agent. */
export const rerollSeed = (id: string, n: number) => (n ? `${id}#${n}` : id);
