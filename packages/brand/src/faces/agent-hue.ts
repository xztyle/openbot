/**
 * The colour and the role of an Atelier agent face, from its id and its name.
 *
 * Every agent has one of 12 hues per workspace theme, solved in OKLCH so that the hue as text
 * (`text`) reads on the theme's canvas and surface (WCAG AA) and the clothes (`tile`) stand out
 * from white or the dark canvas. The name's role words choose a role glyph, which picks the hat,
 * and orchestrator words ("Director", "Lead", "CMO") make the agent an orchestrator.
 *
 * No dependencies. Deterministic: same input, same output.
 */

export type Brand = "craft" | "modern" | "riso";
export type Theme = "light" | "dark";
export type AgentRole = "orchestrator" | "maker";

/** FNV-1a with a murmur3 finish: a stable 32-bit hash of a string. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The item at `index` of a list that is not empty; `index` wraps. */
export function at<T>(list: readonly T[], index: number): T {
  const value = list[((index % list.length) + list.length) % list.length];
  if (value === undefined) throw new Error("A face list is empty.");
  return value;
}

const pick = (id: string, salt: string, count: number) => hash32(`${id}:${salt}`) % count;

type Rgb = [number, number, number];

function oklchLinear(L: number, C: number, h: number): Rgb {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (c: Rgb) => c.every((v) => v >= -0.0005 && v <= 1.0005);
const gammaEnc = (v: number) => {
  const x = Math.min(1, Math.max(0, v));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
};
const hex2 = (v: number) =>
  Math.round(gammaEnc(v) * 255)
    .toString(16)
    .padStart(2, "0");

/** An sRGB hex colour for an OKLCH colour, with the chroma reduced until it is in gamut. */
export function oklch(L: number, C: number, h: number): string {
  let c = C;
  let lin = oklchLinear(L, c, h);
  while (!inGamut(lin) && c > 0) {
    c = Math.max(0, c - 0.004);
    lin = oklchLinear(L, c, h);
  }
  return `#${hex2(lin[0])}${hex2(lin[1])}${hex2(lin[2])}`;
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** The WCAG contrast ratio of two hex colours. */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Walks lightness from `from` in `step` until `ok` holds. */
function solveL(C: number, h: number, from: number, step: number, ok: (hex: string) => boolean): string {
  for (let L = from; L > 0.05 && L < 0.99; L += step) {
    const hex = oklch(L, C, h);
    if (ok(hex)) return hex;
  }
  return oklch(from, C, h);
}

interface ThemeTokens {
  canvas: string;
  surface: string;
  ink: string;
  warn: string;
  danger: string;
  accent: string;
}

interface BrandHueSpec {
  hueOffset: number;
  chroma: number;
  light: ThemeTokens;
  dark: ThemeTokens;
}

/** The colours a face needs in each workspace theme. */
export const BRAND_HUES: Record<Brand, BrandHueSpec> = {
  craft: {
    hueOffset: 28,
    chroma: 0.105,
    light: {
      canvas: "#F6F1E7",
      surface: "#FFFDF8",
      ink: "#1F1A15",
      warn: "#C8811A",
      danger: "#B3261E",
      accent: "#B4441F",
    },
    dark: {
      canvas: "#171411",
      surface: "#211D19",
      ink: "#F3ECE1",
      warn: "#E7B04F",
      danger: "#F07B6E",
      accent: "#EC8358",
    },
  },
  modern: {
    hueOffset: 262,
    chroma: 0.13,
    light: {
      canvas: "#FAFAF9",
      surface: "#FFFFFF",
      ink: "#0B0B0C",
      warn: "#D97A00",
      danger: "#D12C2C",
      accent: "#2E3BFF",
    },
    dark: {
      canvas: "#0B0B0C",
      surface: "#151517",
      ink: "#F4F4F5",
      warn: "#F5B544",
      danger: "#FF6B6B",
      accent: "#8A93FF",
    },
  },
  riso: {
    hueOffset: 340,
    chroma: 0.14,
    light: {
      canvas: "#F3EFE6",
      surface: "#FBF9F4",
      ink: "#1D2A6B",
      warn: "#D9910F",
      danger: "#D1323C",
      accent: "#E0287F",
    },
    dark: {
      canvas: "#121428",
      surface: "#1A1D38",
      ink: "#F3EFE6",
      warn: "#F2B84B",
      danger: "#FF6B7A",
      accent: "#FF6FC2",
    },
  },
};

export interface HueColors {
  /** Clothes and the flat family's disc. */
  tile: string;
  /** A mark drawn on `tile`. */
  fg: string;
  /** The hue as text on the canvas: the agent's name, a mention (4.5:1 or more). */
  text: string;
  /** The wash behind a face. */
  tint: string;
  /** `tile` without its colour, for a failed agent. */
  muted: string;
}

const hueCache = new Map<string, HueColors>();

/** The colours of hue `index` (0 to 11) in a workspace theme. Cached. */
export function agentHue(brand: Brand, index: number, theme: Theme): HueColors {
  const key = `${brand}:${index}:${theme}`;
  const hit = hueCache.get(key);
  if (hit) return hit;
  const spec = BRAND_HUES[brand];
  const tokens = spec[theme];
  const h = (spec.hueOffset + index * 30) % 360;
  const C = spec.chroma;
  const fg = theme === "light" ? "#FFFFFF" : tokens.canvas;
  const tile =
    theme === "light"
      ? solveL(C, h, 0.72, -0.005, (x) => contrast(x, fg) >= 4.6)
      : solveL(C, h, 0.6, 0.005, (x) => contrast(x, fg) >= 6);
  const text =
    theme === "light"
      ? solveL(C, h, 0.66, -0.005, (x) => contrast(x, tokens.canvas) >= 4.6 && contrast(x, tokens.surface) >= 4.6)
      : solveL(C, h, 0.62, 0.005, (x) => contrast(x, tokens.canvas) >= 5 && contrast(x, tokens.surface) >= 4.6);
  const tint = theme === "light" ? oklch(0.95, 0.035, h) : oklch(0.27, 0.05, h);
  const muted = theme === "light" ? oklch(0.58, 0.012, h) : oklch(0.7, 0.012, h);
  const out = { tile, fg, text, tint, muted };
  hueCache.set(key, out);
  return out;
}

/** The role glyphs. Only their names matter to a face: a glyph picks the hat. */
export const ROLE_GLYPHS = [
  "brush",
  "nib",
  "compass",
  "loupe",
  "wrench",
  "hammer",
  "megaphone",
  "scissors",
  "setsquare",
  "stamp",
  "key",
  "scale",
  "chart",
  "camera",
  "book",
  "bulb",
  "chat",
  "code",
  "needle",
  "globe",
] as const;
export type RoleGlyph = (typeof ROLE_GLYPHS)[number];

/** Role words to glyph, first match wins. Names are lower case and without accents first. */
const GLYPH_RULES: readonly [RegExp, RoleGlyph][] = [
  [/\bqa\b|test|calidad|quality/, "loupe"],
  [/cumplim|legal|compliance|normativ|juridic/, "scale"],
  [/segurid|secur|privac/, "key"],
  [/infra|devops|servidor|server|deploy|\bops\b|sre/, "wrench"],
  [/disen|design|landing|\bui\b|\bux\b|brand|marca|web/, "brush"],
  [/copy|redact|writ|escrit|content|guion|script|newsletter/, "nib"],
  [/\bdev|desarroll|engineer|ingenier|codigo|\bcode|frontend|backend|programa/, "code"],
  [/publish|publica|distribu/, "stamp"],
  [/\bads?\b|anunci|marketing|campan|growth|captac|\bmeta\b|paid/, "megaphone"],
  [/ventas|sales|revenue|financ|\bcso\b|\bcfo\b|precio|pricing|comercial/, "chart"],
  [/video|edit|clip|montaj|reel/, "scissors"],
  [/foto|photo|camara|camera|imagen|image|visual/, "camera"],
  [/research|investig|analis|analys|insight|datos|\bdata\b|mercado/, "book"],
  [/soporte|support|comunidad|community|atencion|cliente/, "chat"],
  [/seo|internacional|traduc|translat|idioma/, "globe"],
  [/plan|estrateg|strateg|roadmap|product|operacion/, "setsquare"],
  [/idea|creativ|innov|concept/, "bulb"],
  [/director|\bceo\b|jefe|lead|orquest|orchestr|manager|chief|head|coordin/, "compass"],
  [/build|constru|maker|taller|fabric/, "hammer"],
  [/costur|sew|tailor|sastre/, "needle"],
];

const ORCHESTRATOR =
  /\b(director|directora|ceo|cso|cmo|cto|coo|cfo|jefe|jefa|lead|orquestador|orquestadora|orchestrator|manager|chief|head|coordinador|coordinadora|coordinator|pm)\b/;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export interface AgentTraits {
  hue: number;
  glyph: RoleGlyph;
  role: AgentRole;
}

/** The hue, glyph and role of an agent, from its id and the role words of its name. */
export function agentTraits(id: string, name = "", roleOverride?: AgentRole, hueOverride?: number): AgentTraits {
  const words = fold(name);
  const rule = GLYPH_RULES.find(([pattern]) => pattern.test(words));
  return {
    hue: hueOverride ?? pick(id, "hue", 12),
    glyph: rule ? rule[1] : at(ROLE_GLYPHS, pick(id, "glyph", ROLE_GLYPHS.length)),
    role: roleOverride ?? (ORCHESTRATOR.test(words) ? "orchestrator" : "maker"),
  };
}
