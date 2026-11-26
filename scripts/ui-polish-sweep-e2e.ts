// Takes the web client through its main screens on a computer (1440 wide) and on an iPhone (390 wide,
// touch), in light and in dark, in Spanish, and measures each screen for the things a reader sees as
// unpolished: text that runs past the screen, a tap target under 44 px on the phone, a text size or
// weight off the type scale, text whose contrast with its background is under WCAG AA, and an icon
// drawn outside the shared icon set or at an odd size. It serves the web client on the mock hosts of
// `src/renderer/stories/web-client-*-harness.tsx` (picked by `?harness=`), as the other web-client
// scripts do, and switches each harness to the locale of `?locale=` without changing the harness.
//
// `bun scripts/ui-polish-sweep-e2e.ts [--out=<name>] [--screens=today,dm/chief] [--phone-only] [--headed]`
// Writes .openbot-build/ui-polish/<name>/<screen>-<width>-<scheme>.png and report.json; `--out`
// defaults to `sweep`. Exits 1 when a screen overflows sideways or a phone control is under 36 px.
// deploy-tests timeout: 900s
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type BrowserContext, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("ui-polish-sweep-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const OUT = resolve(ROOT, ".openbot-build/ui-polish", option("out") ?? "sweep");
const LOCALE = option("locale") ?? "es";
const PHONE_ONLY = process.argv.includes("--phone-only");
const ONLY = option("screens")?.split(",");
const SCHEMES = ["dark", "light"] as const;

/** The type scale of `packages/brand/src/tokens.css`, in px, with the display size and the glyph sizes. */
const TEXT_SCALE = new Set([7, 8, 9, 12, 13, 14, 16, 18, 24, 32]);
/** The phone adds the touch sizes (`--openbot-touch-text-*`), which the workspace panes take. */
const PHONE_TEXT_SCALE = new Set([...TEXT_SCALE, 15, 17, 20]);
/** The weight tokens, and the display weight of the Atelier themes (`--atelier-display-weight`). */
const WEIGHT_SCALE = new Set([400, 500, 600, 700, 800]);

const HARNESS = (name: string) => `<!doctype html>
<html lang="${LOCALE}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Atelier web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/${name}.tsx"></script>
  </body>
</html>`;

interface Screen {
  /** The file name of the screenshots. */
  id: string;
  harness: string;
  /** The address under /app/general/. */
  view: string;
  query?: string;
  /** What the mock host does once the screen shows, such as an agent that asks for an approval. */
  prepare?: (page: Page) => Promise<void>;
  /** Taps the screen into a state, such as a composer with the suggestion chips open. */
  act?: (page: Page) => Promise<void>;
}

const needsYou = (details: string[]) => async (page: Page) => {
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-needs-you-ready"), null, {
    timeout: 30_000,
  });
  for (const detail of details)
    await page.evaluate(
      (value) => window.dispatchEvent(new CustomEvent("needs-you-harness", { detail: value })),
      detail,
    );
  await page.waitForTimeout(1_200);
};

const SCREENS: Screen[] = [
  { id: "today", harness: "web-client-today-harness", view: "today", query: "alert" },
  { id: "today-plain", harness: "web-client-harness", view: "today" },
  { id: "today-empty", harness: "web-client-empty-harness", view: "today", query: "agents=none" },
  { id: "today-connect-fail", harness: "web-client-empty-harness", view: "today", query: "connect=fail" },
  { id: "today-connect-slow", harness: "web-client-empty-harness", view: "today", query: "connect=slow" },
  {
    id: "today-approvals",
    harness: "web-client-needsyou-harness",
    view: "today",
    prepare: needsYou(["request", "ticket", "ticket-review", "money-approval"]),
  },
  {
    id: "dm-approval",
    harness: "web-client-needsyou-harness",
    view: "dm/sales-outbound",
    prepare: needsYou(["money-approval", "request"]),
  },
  {
    id: "dm-condensed",
    harness: "web-client-needsyou-harness",
    view: "dm/chief",
    prepare: needsYou(["answer", "condense"]),
  },
  { id: "dm-chief", harness: "web-client-harness", view: "dm/chief" },
  { id: "channel-general", harness: "web-client-harness", view: "c/general" },
  { id: "thread", harness: "web-client-harness", view: "c/general/t/general-root" },
  { id: "channel-media", harness: "web-client-media-harness", view: "c/general" },
  { id: "dm-live-view", harness: "web-client-live-view-harness", view: "dm/chief" },
  { id: "unreads", harness: "web-client-inbox-harness", view: "unreads" },
  { id: "threads", harness: "web-client-inbox-harness", view: "threads" },
  { id: "activity", harness: "web-client-inbox-harness", view: "activity" },
  { id: "later", harness: "web-client-inbox-harness", view: "later" },
  { id: "fleet", harness: "web-client-harness", view: "fleet" },
  { id: "agents", harness: "web-client-harness", view: "agents" },
  { id: "search", harness: "web-client-harness", view: "search" },
  { id: "tasks", harness: "web-client-harness", view: "tasks" },
  { id: "loops", harness: "web-client-harness", view: "loops" },
  { id: "money", harness: "web-client-harness", view: "money" },
  { id: "usage", harness: "web-client-harness", view: "usage" },
  { id: "storage", harness: "web-client-harness", view: "storage" },
  { id: "knowledge", harness: "web-client-harness", view: "knowledge" },
  { id: "routines", harness: "web-client-harness", view: "routines" },
  { id: "schedule", harness: "web-client-harness", view: "schedule" },
  { id: "secrets", harness: "web-client-harness", view: "secrets" },
  { id: "artifacts", harness: "web-client-harness", view: "artifacts" },
  { id: "portfolio", harness: "views-harness", view: "portfolio" },
  { id: "portfolio-empty", harness: "views-harness", view: "portfolio", query: "data=empty" },
  { id: "reviews", harness: "views-harness", view: "reviews" },
  { id: "trust", harness: "views-harness", view: "trust" },
  { id: "trust-extreme", harness: "views-harness", view: "trust", query: "data=extreme" },
  { id: "insights", harness: "views-harness", view: "insights" },
  { id: "insights-empty", harness: "views-harness", view: "insights", query: "data=empty" },
  { id: "settings", harness: "web-client-harness", view: "settings" },
  { id: "server-settings", harness: "web-client-harness", view: "server-settings" },
  { id: "server-settings-backups", harness: "web-client-harness", view: "server-settings/backups" },
  { id: "server-settings-storage", harness: "web-client-harness", view: "server-settings/storage" },
];

function harnessPages(): Plugin {
  return {
    name: "openbot-ui-polish-harness",
    // Before Solid compiles the JSX, while `locale="en"` is still an attribute.
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "/";
        if (url !== "/app" && !url.startsWith("/app/") && !url.startsWith("/app?")) return next();
        const name = new URL(url, "http://harness").searchParams.get("harness") ?? "web-client-harness";
        assert.match(name, /^[a-z-]+$/u);
        const html = await server.transformIndexHtml(url, HARNESS(name));
        response.setHeader("Content-Type", "text/html");
        response.end(html);
      });
    },
    // Every harness renders English. The sweep reads the locale of the address instead, so one
    // harness serves every language without a copy per language.
    transform(code, id) {
      if (!/\/stories\/[a-z-]*harness\.tsx$/u.test(id) || !code.includes('locale="en"')) return null;
      return {
        code: `${code.replace(
          /locale="en"/gu,
          'locale={(new URLSearchParams(window.location.search).get("locale") ?? "en") as "en"}',
        )}`,
        map: null,
      };
    },
  };
}

/** Pins the colour scheme and the Riso look on the root, also after the workspace writes its own. */
const PIN_LOOK = (scheme: string) => `
  const pin = () => {
    const root = document.documentElement;
    if (root.dataset.openbotColorScheme !== "${scheme}") root.dataset.openbotColorScheme = "${scheme}";
    if (root.dataset.atelierTheme !== "riso") root.dataset.atelierTheme = "riso";
  };
  const start = () => {
    pin();
    new MutationObserver(pin).observe(document.documentElement, { attributes: true });
  };
  if (document.documentElement) start();
  else new MutationObserver((_, observer) => { if (document.documentElement) { observer.disconnect(); start(); } }).observe(document, { childList: true });
`;

interface Finding {
  kind: "overflow" | "small-target" | "tiny-target" | "off-scale-size" | "off-scale-weight" | "contrast" | "icon";
  detail: string;
}

interface ScreenReport {
  id: string;
  width: number;
  scheme: string;
  screenshot: string;
  pageErrors: string[];
  fontSizes: Record<string, number>;
  fontWeights: Record<string, number>;
  iconSizes: Record<string, number>;
  findings: Finding[];
}

/** Measures the screen that shows. Runs in the page. */
interface TextSample {
  name: string;
  color: string;
  size: number;
  weight: number;
  /** left, top, right, bottom in CSS px. */
  box: [number, number, number, number];
  /** The element's own background colour, which is what its text sits on when it is opaque. */
  background: string;
  /** The element paints an image or a gradient of its own: no one colour is behind its text. */
  painted: boolean;
}

function measure([phone, scale, weights]: readonly [boolean, readonly number[], readonly number[]]): Omit<
  ScreenReport,
  "id" | "width" | "scheme" | "screenshot" | "pageErrors"
> & { texts: TextSample[] } {
  const TEXT_SCALE = new Set(scale);
  const WEIGHT_SCALE = new Set(weights);
  const findings: Finding[] = [];
  const texts: TextSample[] = [];
  const fontSizes: Record<string, number> = {};
  const fontWeights: Record<string, number> = {};
  const iconSizes: Record<string, number> = {};
  const tally = (map: Record<string, number>, key: string) => {
    map[key] = (map[key] ?? 0) + 1;
  };
  const name = (element: Element) => {
    // The primitive's own classes say nothing about the place; the feature classes do.
    const classes = element.className
      ?.toString()
      .split(/\s+/u)
      .filter((value) => value && !/^ui-button(?:-|$)/u.test(value))
      .slice(0, 3)
      .join(".");
    const text = element.textContent?.replace(/\s+/gu, " ").trim().slice(0, 40) ?? "";
    return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""} "${text}"`;
  };
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    if (box.bottom < 0 || box.top > innerHeight) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const overflowClipped = (element: Element) => {
    let node = element.parentElement;
    while (node && node !== document.body) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow !== "visible") return true;
      node = node.parentElement;
    }
    return false;
  };

  // Overflow: the page, and any element that runs past the right edge without a clipped ancestor.
  const page = document.scrollingElement;
  if (page && page.scrollWidth > innerWidth + 1)
    findings.push({ kind: "overflow", detail: `page scrolls sideways: ${page.scrollWidth}px in ${innerWidth}px` });
  const seenOverflow = new Set<Element>();
  for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
    if (!visible(element)) continue;
    const box = element.getBoundingClientRect();
    if (box.right > innerWidth + 1 && !overflowClipped(element) && element.closest(".ui-toast-layer") === null) {
      if ([...seenOverflow].some((seen) => seen.contains(element))) continue;
      seenOverflow.add(element);
      findings.push({
        kind: "overflow",
        detail: `${name(element)} ends at ${Math.round(box.right)}px (screen ${innerWidth}px)`,
      });
    }
  }

  // Text: size, weight and contrast of every element with text of its own.
  for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
    if (!visible(element)) continue;
    const ownText = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    );
    if (!ownText) continue;
    const style = getComputedStyle(element);
    const size = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10);
    tally(fontSizes, `${Math.round(size * 10) / 10}`);
    tally(fontWeights, `${weight}`);
    if (!TEXT_SCALE.has(Math.round(size * 10) / 10) && !element.closest("pre, code, .ws-visual-frame, iframe"))
      findings.push({ kind: "off-scale-size", detail: `${name(element)} is ${size}px` });
    if (!WEIGHT_SCALE.has(weight))
      findings.push({ kind: "off-scale-weight", detail: `${name(element)} weighs ${weight}` });
    // Contrast is read from the screenshot's pixels around the text, which sees every layer under
    // it; the text waits here with its box.
    if (
      Number(style.opacity) >= 0.95 &&
      element.closest("[aria-hidden='true'], [disabled], .ui-toast-layer") === null
    ) {
      const box = element.getBoundingClientRect();
      texts.push({
        name: name(element),
        color: style.color,
        size,
        weight,
        box: [box.left, box.top, box.right, box.bottom],
        background: style.backgroundColor,
        painted: style.backgroundImage !== "none",
      });
    }
  }

  // Icons: every svg, by set and rendered size.
  for (const svg of document.body.querySelectorAll<SVGElement>("svg")) {
    if (!visible(svg)) continue;
    const box = svg.getBoundingClientRect();
    const lucide = svg.classList.contains("lucide") || svg.getAttribute("data-lucide") !== null;
    tally(iconSizes, `${lucide ? "lucide" : "other"} ${Math.round(box.width)}x${Math.round(box.height)}`);
    if (
      !lucide &&
      svg.closest(".app-logo, .atelier-symbol, [class*='logo'], [class*='avatar'], [class*='qr']") === null
    )
      findings.push({
        kind: "icon",
        detail: `${name(svg.parentElement ?? svg)} draws its own svg ${Math.round(box.width)}x${Math.round(box.height)}`,
      });
  }

  // Phone: every control the finger can reach has to be at least 44 px tall and wide.
  if (phone) {
    const controls = document.body.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], summary, input, textarea, select',
    );
    for (const control of controls) {
      if (!visible(control) || control.closest(".ui-toast-layer")) continue;
      const box = control.getBoundingClientRect();
      // A link in running text is as tall as its line; the line is the target.
      if (control.tagName === "A" && getComputedStyle(control).display === "inline") continue;
      // An inline control may carry an invisible `::after` that widens what the finger hits
      // (`patterns.css`); the finger's target is the union of the two.
      let height = box.height;
      let width = box.width;
      const after = getComputedStyle(control, "::after");
      if (after.content !== "none" && after.position === "absolute") {
        const edge = (value: string) => (value === "auto" ? 0 : Number.parseFloat(value) || 0);
        height = Math.max(height, box.height - edge(after.top) - edge(after.bottom));
        width = Math.max(width, box.width - edge(after.left) - edge(after.right));
      }
      const least = Math.min(width, height);
      if (least < 36)
        findings.push({ kind: "tiny-target", detail: `${name(control)} ${Math.round(width)}x${Math.round(height)}` });
      else if (least < 44)
        findings.push({ kind: "small-target", detail: `${name(control)} ${Math.round(width)}x${Math.round(height)}` });
    }
  }
  return { fontSizes, fontWeights, iconSizes, findings, texts };
}

const parseColor = (color: string): [number, number, number, number] | null => {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/u.exec(color);
  if (!match) return null;
  const alpha =
    match[4] === undefined ? 1 : match[4].endsWith("%") ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]);
  return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
};
const luminance = ([r, g, b]: readonly number[]) => {
  const channel = (value: number) => {
    const unit = (value ?? 0) / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
};
const blend = (
  top: [number, number, number, number],
  under: [number, number, number, number],
): [number, number, number, number] => [
  top[0] * top[3] + under[0] * (1 - top[3]),
  top[1] * top[3] + under[1] * (1 - top[3]),
  top[2] * top[3] + under[2] * (1 - top[3]),
  1,
];

/**
 * The contrast of every text element against what the screenshot shows around it. The pixels just
 * outside the text's box, on its four sides, are the background the eye compares the text with; the
 * most common of them is taken, so a border or a neighbouring glyph does not decide. Text over an
 * image or a gradient has no one background and is skipped when the samples disagree.
 */
async function contrastFindings(page: Page, shot: Buffer, texts: readonly TextSample[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const points: [number, number][] = [];
  for (const text of texts) {
    const [left, top, right, bottom] = text.box;
    const midY = (top + bottom) / 2;
    const midX = (left + right) / 2;
    points.push(
      [left - 3, midY],
      [right + 3, midY],
      [midX, top - 3],
      [midX, bottom + 3],
      [left - 3, top - 3],
      [right + 3, bottom + 3],
    );
  }
  // The page reads the pixels of its own screenshot from a canvas, so no image library is needed.
  const pixels = await page.evaluate(
    async ([dataUrl, wanted]) => {
      const image = new Image();
      await new Promise<void>((done, fail) => {
        image.onload = () => done();
        image.onerror = () => fail(new Error("The screenshot did not decode."));
        image.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) return [];
      context.drawImage(image, 0, 0);
      const scale = image.naturalWidth / innerWidth;
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      return wanted.map(([x, y]) => {
        const px = Math.round(x * scale);
        const py = Math.round(y * scale);
        if (px < 0 || py < 0 || px >= width || py >= height) return null;
        const at = (py * width + px) * 4;
        const rgb: [number, number, number] = [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0];
        return rgb;
      });
    },
    [`data:image/png;base64,${shot.toString("base64")}`, points] as const,
  );
  texts.forEach((text, index) => {
    const ink = parseColor(text.color);
    if (!ink || text.painted) return;
    const own = parseColor(text.background);
    const seen = new Map<string, { color: [number, number, number, number]; count: number }>();
    // A button or a badge with text of its own paints the colour behind that text itself; the
    // pixels around its box are the canvas it sits on, which is not what the eye compares.
    if (own && own[3] >= 1) seen.set("own", { color: own, count: 6 });
    for (const color of pixels.slice(index * 6, index * 6 + 6)) {
      if (!color) continue;
      const key = color.join(",");
      const opaque: [number, number, number, number] = [color[0], color[1], color[2], 1];
      const entry = seen.get(key) ?? { color: opaque, count: 0 };
      entry.count += 1;
      seen.set(key, entry);
    }
    const background = [...seen.values()].sort((a, b) => b.count - a.count)[0];
    // Fewer than half the samples agree: the text sits on something that is not one colour.
    if (!background || background.count < 3) return;
    const solidInk = ink[3] < 1 ? blend(ink, background.color) : ink;
    const inkLuminance = luminance(solidInk);
    const paperLuminance = luminance(background.color);
    const ratio = (Math.max(inkLuminance, paperLuminance) + 0.05) / (Math.min(inkLuminance, paperLuminance) + 0.05);
    const large = text.size >= 24 || (text.size >= 18.66 && text.weight >= 700);
    // Text the same colour as what is around it is not rendered text; the samples missed the
    // surface it sits on (a filled control the span does not fill), so the number says nothing.
    if (ratio < (large ? 3 : 4.5) && ratio > 1.05)
      findings.push({
        kind: "contrast",
        detail: `${text.name} ${ratio.toFixed(2)}:1 (${text.color} on rgb(${background.color.slice(0, 3).join(", ")}))`,
      });
  });
  return findings;
}

async function open(page: Page, screen: Screen, scheme: string): Promise<void> {
  const query = new URLSearchParams(screen.query ?? "");
  query.set("harness", screen.harness);
  query.set("locale", LOCALE);
  await page.goto(`${origin}/app/general/${screen.view}?${query}`, { waitUntil: "commit" });
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, null, {
    timeout: 120_000,
  });
  await page.waitForTimeout(1_500);
  await page.evaluate(PIN_LOOK(scheme));
  await page.waitForTimeout(200);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  plugins: [harnessPages(), tailwindcss({ optimize: false }), solidPlugin()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: [...new Set(SCREENS.map((screen) => `src/renderer/stories/${screen.harness}.tsx`))],
    include: ["@norbert_bodziony/bloub"],
  },
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false }, hmr: false },
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object", "The harness server has no port.");
const origin = `http://127.0.0.1:${address.port}`;
const executablePath = option("browser-executable");
const browser = await chromium.launch({
  headless: !process.argv.includes("--headed"),
  ...(executablePath ? { executablePath } : {}),
});
const reports: ScreenReport[] = [];
try {
  const iphone = devices["iPhone 13"];
  assert.ok(iphone, "Playwright has no iPhone 13 descriptor.");
  const { defaultBrowserType: _engine, ...phone } = iphone;
  const contexts: { width: number; context: BrowserContext; phone: boolean; scheme: string }[] = [];
  for (const scheme of SCHEMES) {
    const phoneContext = await browser.newContext({
      ...phone,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      locale: LOCALE,
    });
    contexts.push({ width: 390, context: phoneContext, phone: true, scheme });
    if (!PHONE_ONLY) {
      const desktop = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: scheme,
        locale: LOCALE,
      });
      contexts.push({ width: 1440, context: desktop, phone: false, scheme });
    }
    for (const { context } of contexts.slice(PHONE_ONLY ? -1 : -2)) {
      await context.route(/^(?!http:\/\/127\.0\.0\.1)/u, (route) => route.abort());
      await context.addInitScript(PIN_LOOK(scheme));
    }
  }
  for (const screen of SCREENS) {
    if (ONLY && !ONLY.includes(screen.id)) continue;
    for (const { width, context, phone: isPhone, scheme } of contexts) {
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.setDefaultTimeout(15_000);
      try {
        await open(page, screen, scheme);
        await screen.prepare?.(page);
        await screen.act?.(page);
        const file = `${screen.id.replaceAll("/", "-")}-${width}-${scheme}.png`;
        const shot = await page.screenshot({ path: resolve(OUT, file), fullPage: false });
        const { texts, ...measured } = await page.evaluate(measure, [
          isPhone,
          [...(isPhone ? PHONE_TEXT_SCALE : TEXT_SCALE)],
          [...WEIGHT_SCALE],
        ] as const);
        measured.findings.push(...(await contrastFindings(page, shot, texts)));
        reports.push({ id: screen.id, width, scheme, screenshot: file, pageErrors, ...measured });
        logger.info(`${screen.id} ${width} ${scheme}: ${measured.findings.length} findings`);
      } catch (error) {
        reports.push({
          id: screen.id,
          width,
          scheme,
          screenshot: "",
          pageErrors: [...pageErrors, error instanceof Error ? error.message : String(error)],
          fontSizes: {},
          fontWeights: {},
          iconSizes: {},
          findings: [],
        });
        logger.error(
          `${screen.id} ${width} ${scheme} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const totals: Record<string, number> = {};
for (const report of reports)
  for (const finding of report.findings) totals[finding.kind] = (totals[finding.kind] ?? 0) + 1;
const blocking = reports.flatMap((report) =>
  report.findings
    .filter((finding) => finding.kind === "overflow" || finding.kind === "tiny-target")
    .map((finding) => `${report.id} ${report.width} ${report.scheme}: ${finding.detail}`),
);
writeFileSync(
  resolve(OUT, "report.json"),
  `${JSON.stringify({ locale: LOCALE, totals, blocking, screens: reports }, null, 2)}\n`,
);
logger.info(`Wrote ${resolve(OUT, "report.json")}: ${JSON.stringify(totals)}; ${blocking.length} blocking.`);
if (blocking.length > 0) process.exit(1);
