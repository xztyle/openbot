// Sweeps the web client's screens for layout faults: every view, a channel, a thread, a DM and the
// pages over the workspace, in each Atelier theme (Craft Studio, Modern Atelier, Riso Press), on an
// iPhone (375, 390 and 430 wide, and 844×390 on its side) and on a computer (1280, 1440 and 1920 wide).
// On each screen it checks that
// - nothing reaches past the sides of the window, so the page never scrolls sideways;
// - no button or link sits under another element at its centre (a pill or bar on top of it);
// - on the iPhone, no text or control sits under the notch or the home indicator: the page is served
//   with `env(safe-area-inset-*)` as an iPhone 13 has it (47 px at the top and 34 px at the bottom, or
//   47 px at the sides on its side), which Chromium otherwise reports as 0;
// - text keeps a contrast of at least 3:1 to what is behind it, in light and in dark;
// - System gives the same colors as the choice that it resolves to.
// It serves `src/renderer/stories/web-client-visual-harness.tsx` on a mock host; no host is needed.
//
// `bun scripts/web-visual-sweep-e2e.ts [--themes=craft,modern,riso] [--routes=<substring>] [--long]
//   [--browser-executable=<path>] [--shots]`
// `--long` gives an agent, a channel and a message very long names and numbers. `--shots` keeps a
// screenshot of each screen. Writes .openbot-build/web-visual-sweep-e2e/report.json.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext, chromium, devices, type Page } from "playwright-core";
import { createServer, type Plugin } from "vite";

const logger = createOpenBotLogger("web-visual-sweep-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/web-visual-sweep-e2e");
const UI_WAIT_MS = 60_000;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const HARNESS = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>OpenBot web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/stories/web-client-visual-harness.tsx"></script>
  </body>
</html>`;

/** The safe areas of an iPhone 13, upright and on its side. */
const INSETS = {
  portrait: { top: 47, right: 0, bottom: 34, left: 0 },
  landscape: { top: 0, right: 47, bottom: 21, left: 47 },
} as const;
type Orientation = keyof typeof INSETS;

function webClientPages(): Plugin {
  return {
    name: "openbot-web-visual-sweep-harness",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "";
        if (!/^\/app(?:[/?]|$)/u.test(url)) return next();
        const html = await server.transformIndexHtml(url, HARNESS);
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      });
    },
  };
}

/**
 * Chromium reports every safe area as 0, so the styles read `--sweep-inset-*` in place of
 * `env(safe-area-inset-*)`, and the sweep sets those on the root element for the device it shows.
 */
function safeAreas(): Plugin {
  return {
    name: "openbot-web-visual-sweep-safe-areas",
    enforce: "post",
    transform(code, id) {
      if (!/\.(?:css|tsx?)(?:\?|$)/u.test(id) || !code.includes("safe-area-inset-")) return null;
      return code.replace(
        /env\(\s*safe-area-inset-(top|right|bottom|left)\s*(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)/gu,
        "var(--sweep-inset-$1, 0px)",
      );
    },
  };
}

const ROUTES: readonly string[] = [
  "/app/general",
  "/app/general/today",
  "/app/general/money",
  "/app/general/activity",
  "/app/general/threads",
  "/app/general/fleet",
  "/app/general/org",
  "/app/general/artifacts",
  "/app/general/between-agents",
  "/app/general/storage",
  "/app/general/routines",
  "/app/general/secrets",
  "/app/general/reviews",
  "/app/general/portfolio",
  "/app/general/loops",
  "/app/general/insights",
  "/app/general/trust",
  "/app/general/agents",
  "/app/general/drafts",
  "/app/general/unreads",
  "/app/general/later",
  "/app/general/dms",
  "/app/general/search",
  "/app/general/c/general",
  "/app/general/c/general/t/general-root",
  "/app/general/dm/chief",
  "/app/market-trading/loops",
  "/app/general?page=settings",
  "/app/general?page=server-settings",
  "/app/general?page=usage",
  "/app/general?page=schedule",
  "/app/general?page=tasks",
];

interface Size {
  name: string;
  width: number;
  height: number;
  orientation: Orientation | null;
}
const PHONE_SIZES: Size[] = [
  { name: "phone-390", width: 390, height: 844, orientation: "portrait" },
  { name: "phone-375", width: 375, height: 812, orientation: "portrait" },
  { name: "phone-430", width: 430, height: 932, orientation: "portrait" },
  { name: "phone-land", width: 844, height: 390, orientation: "landscape" },
];
const DESKTOP_SIZES: Size[] = [
  { name: "desk-1280", width: 1280, height: 800, orientation: null },
  { name: "desk-1440", width: 1440, height: 900, orientation: null },
  { name: "desk-1920", width: 1920, height: 1080, orientation: null },
];

interface Finding {
  kind: "overflow" | "covered" | "safe-area" | "contrast" | "system" | "blank";
  theme: string;
  scheme: string;
  size: string;
  route: string;
  detail: string;
}
const findings: Finding[] = [];
const pageErrors: string[] = [];

type Scan = { kind: Finding["kind"]; detail: string }[];

/** The layout checks, in the page. `insets` is the safe area of the device, or null on a computer. */
function scanLayout(input: {
  insets: { top: number; right: number; bottom: number; left: number } | null;
  scope: string | null;
}): Scan {
  const { insets } = input;
  const root = (input.scope && Array.from(document.querySelectorAll(input.scope)).at(-1)) || document.body;
  const out: { kind: "overflow" | "covered" | "safe-area"; detail: string }[] = [];
  const width = document.documentElement.clientWidth;
  const height = window.innerHeight;
  const label = (el: Element) => {
    const cls = typeof el.className === "string" ? el.className.split(/\s+/u).slice(0, 2).join(".") : "";
    const text = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/gu, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""} "${text}"`;
  };
  const shown = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      if (node.getAttribute("aria-hidden") === "true" || (node instanceof HTMLElement && node.inert)) return false;
    }
    return true;
  };
  /** Whether an ancestor clips the element on the side where it leaves the window. */
  const clipped = (el: Element, rect: DOMRect) => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === "visible" && style.overflow === "visible" && style.contain.indexOf("paint") < 0) continue;
      const box = node.getBoundingClientRect();
      if (box.right <= width + 1 && box.left >= -1) return true;
      if (rect.left >= box.right || rect.right <= box.left) return true;
    }
    return false;
  };
  if (document.documentElement.scrollWidth > width + 1)
    out.push({ kind: "overflow", detail: `page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}` });
  const all = Array.from(root.querySelectorAll("*"));
  const seen = new Set<string>();
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.bottom <= 0 || rect.top >= height) continue;
    if (rect.right > width + 1 || rect.left < -1) {
      if (clipped(el, rect) || !shown(el)) continue;
      // Report the outermost element only.
      const parent = el.parentElement?.getBoundingClientRect();
      if (parent && (parent.right > width + 1 || parent.left < -1) && el.parentElement !== document.body) continue;
      const key = `overflow ${label(el)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          kind: "overflow",
          detail: `${label(el)} spans ${Math.round(rect.left)}..${Math.round(rect.right)} of ${width}`,
        });
      }
    }
  }
  const controls = Array.from(
    root.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=tab]"),
  );
  for (const el of controls) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= width || y >= height || !shown(el)) continue;
    // A control that a scroller or a clipping box cuts off at its centre is out of view, not covered.
    let outOfView = false;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const box = node.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) outOfView = true;
    }
    if (outOfView) continue;
    const top = document.elementFromPoint(x, y);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      // A button with no text that spans a row sits behind the row's content on purpose.
      const under = top.getBoundingClientRect();
      if (
        !(el.textContent ?? "").trim() &&
        under.left >= rect.left - 1 &&
        under.right <= rect.right + 1 &&
        under.top >= rect.top - 1 &&
        under.bottom <= rect.bottom + 1
      )
        continue;
      // A control inside a scroller that the scroller hides, such as a row under a sticky header.
      let scroller = el.parentElement;
      while (scroller && !/(auto|scroll)/u.test(getComputedStyle(scroller).overflowY))
        scroller = scroller.parentElement;
      if (scroller?.contains(top) && getComputedStyle(top).position === "sticky") continue;
      const topSticky = (() => {
        for (let node: Element | null = top; node; node = node.parentElement) {
          const position = getComputedStyle(node).position;
          if (position === "sticky" || position === "fixed") return node;
        }
        return null;
      })();
      // Rows scroll under a sticky or fixed bar by design; only a bar that covers a bar is a fault.
      const elFixed = (() => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          const position = getComputedStyle(node).position;
          if (position === "sticky" || position === "fixed") return true;
        }
        return false;
      })();
      if (topSticky && !elFixed && !topSticky.contains(el)) continue;
      const key = `covered ${label(el)} ${label(top)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: "covered", detail: `${label(el)} under ${label(top)}` });
      }
    }
  }
  if (insets) {
    const leafs = Array.from(root.querySelectorAll("*")).filter((el) => {
      if (el.matches("button, a[href], input, textarea, [role=button], [role=tab]")) return true;
      return Array.from(el.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? "").trim());
    });
    for (const el of leafs) {
      if (!shown(el)) continue;
      // The part of the element that the window shows: each clipping ancestor cuts it.
      const box = el.getBoundingClientRect();
      let [left, top, right, bottom] = [box.left, box.top, box.right, box.bottom];
      // A scroller's content may pass under the bars, unless a pinned box between holds it there.
      let inScroller = false;
      let pinned = false;
      for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (!inScroller && (style.position === "fixed" || style.position === "sticky")) pinned = true;
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const clip = node.getBoundingClientRect();
        left = Math.max(left, clip.left);
        top = Math.max(top, clip.top);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
        if (
          !pinned &&
          (/(auto|scroll)/u.test(style.overflowY) || /(auto|scroll)/u.test(style.overflowX)) &&
          (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)
        )
          inScroller = true;
      }
      left = Math.max(left, 0);
      top = Math.max(top, 0);
      right = Math.min(right, width);
      bottom = Math.min(bottom, height);
      if (right - left < 1 || bottom - top < 1 || inScroller) continue;
      const sides: string[] = [];
      if (top < insets.top - 1) sides.push(`top ${Math.round(top)}`);
      if (bottom > height - insets.bottom + 1) sides.push(`bottom ${Math.round(bottom)}`);
      if (left < insets.left - 1) sides.push(`left ${Math.round(left)}`);
      if (right > width - insets.right + 1) sides.push(`right ${Math.round(right)}`);
      if (sides.length === 0) continue;
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
      const key = `safe ${label(el)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: "safe-area", detail: `${label(el)} under the ${sides.join(", ")}` });
      }
    }
  }
  return out;
}

/** Text whose contrast to the color behind it is under 3:1, in the page. */
function scanContrast(scope: string | null): Scan {
  const root = (scope && Array.from(document.querySelectorAll(scope)).at(-1)) || document.body;
  const out: { kind: "contrast"; detail: string }[] = [];
  const parse = (value: string) => {
    const match = value.match(/rgba?\(([^)]+)\)/u);
    if (!match?.[1]) {
      const srgb = value.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/u);
      if (!srgb) return null;
      return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] ? Number(srgb[4]) : 1];
    }
    const parts = match[1]
      .split(/[\s,/]+/u)
      .filter(Boolean)
      .map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
  };
  const lum = (c: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0] ?? 0) + 0.7152 * f(c[1] ?? 0) + 0.0722 * f(c[2] ?? 0);
  };
  const blend = (top: number[], bottom: number[]) => {
    const a = top[3] ?? 1;
    return [0, 1, 2].map((i) => (top[i] ?? 0) * a + (bottom[i] ?? 0) * (1 - a)).concat(1);
  };
  /** The solid color behind the element, or null when an image or a gradient is behind it. */
  const background = (el: Element) => {
    const layers: number[][] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") return null;
      // A pane's color may come from a pseudo-element under the content, as the app frame's does.
      const under = [getComputedStyle(node, "::before"), getComputedStyle(node, "::after")].find(
        (pseudo) =>
          pseudo.content !== "none" &&
          pseudo.position === "absolute" &&
          (parse(pseudo.backgroundColor)?.[3] ?? 0) >= 1 &&
          (() => {
            const box = node.getBoundingClientRect();
            const rect = el.getBoundingClientRect();
            const left = Number.parseFloat(pseudo.left) || 0;
            const top = Number.parseFloat(pseudo.top) || 0;
            const width = Number.parseFloat(pseudo.width) || box.width;
            const height = Number.parseFloat(pseudo.height) || box.height;
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            return (
              x >= box.left + left && y >= box.top + top && x <= box.left + left + width && y <= box.top + top + height
            );
          })(),
      );
      const pseudoColor = under ? parse(under.backgroundColor) : null;
      if (pseudoColor) {
        layers.push(pseudoColor);
        break;
      }
      const color = parse(style.backgroundColor);
      if (color && (color[3] ?? 0) > 0) {
        layers.push(color);
        if ((color[3] ?? 0) >= 1) break;
      }
    }
    let result = [255, 255, 255, 1];
    for (const layer of layers.reverse()) result = blend(layer, result);
    return result;
  };
  const seen = new Set<string>();
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const text = Array.from(el.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent ?? "")
      .join("")
      .trim();
    if (!text) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.bottom <= 0 || rect.top >= innerHeight) continue;
    // Only text that the window shows: a scroller's clipped rows do not count.
    if (el.classList.contains("sr-only")) continue;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let clipped = false;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const overflow = getComputedStyle(node);
      if (overflow.overflowX === "visible" && overflow.overflowY === "visible") continue;
      const box = node.getBoundingClientRect();
      if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) clipped = true;
    }
    if (clipped) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || Number(style.opacity) < 0.5) continue;
    let faded = false;
    for (let node = el.parentElement; node; node = node.parentElement)
      if (Number(getComputedStyle(node).opacity) < 0.5 || (node instanceof HTMLElement && node.inert)) faded = true;
    if (faded || el.closest("[disabled], [aria-disabled=true], [aria-hidden=true]")) continue;
    const color = parse(style.color);
    const back = background(el);
    if (!color || !back) continue;
    const front = blend(color, back);
    const [a, b] = [lum(front), lum(back)];
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio >= 3) continue;
    const cls = typeof el.className === "string" ? el.className.split(/\s+/u)[0] : "";
    const key = `${el.tagName}.${cls}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: "contrast",
      detail: `${ratio.toFixed(2)}:1 ${el.tagName.toLowerCase()}.${cls} "${text.slice(0, 30)}" ${style.color} on rgb(${back.slice(0, 3).map(Math.round).join(",")})`,
    });
  }
  return out;
}

/** A digest of the colors that the page paints, to compare two color choices. */
function colorDigest(): string[] {
  return Array.from(document.body.querySelectorAll("*"))
    .slice(0, 4000)
    .map((el) => {
      const style = getComputedStyle(el);
      return `${el.tagName}.${typeof el.className === "string" ? el.className.split(/\s+/u)[0] : ""} ${style.color} ${style.backgroundColor} ${style.borderTopColor} ${style.colorScheme}`;
    });
}

async function settle(page: Page): Promise<boolean> {
  const ready = await page
    .waitForFunction(() => (document.querySelector("#root")?.textContent ?? "").length > 40, undefined, {
      timeout: UI_WAIT_MS,
    })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.fonts.ready);
  return ready;
}

async function context(
  browser: Browser,
  phone: boolean,
  theme: string,
  appearance: string,
  scheme: "light" | "dark",
): Promise<BrowserContext> {
  const { defaultBrowserType: _browserType, ...iphone } = devices["iPhone 13"];
  const ctx = await browser.newContext(
    phone
      ? { ...iphone, viewport: { width: 390, height: 844 }, colorScheme: scheme }
      : { viewport: { width: 1440, height: 900 }, colorScheme: scheme },
  );
  await ctx.addInitScript(
    (value) => {
      localStorage.setItem("visual.theme", value.theme);
      localStorage.setItem("visual.appearance", value.appearance);
      localStorage.setItem("visual.long", value.long ? "1" : "0");
    },
    { theme, appearance, long: flag("long") },
  );
  return ctx;
}

async function setInsets(page: Page, orientation: Orientation | null): Promise<void> {
  const insets = orientation ? INSETS[orientation] : { top: 0, right: 0, bottom: 0, left: 0 };
  await page.evaluate((value) => {
    for (const [side, px] of Object.entries(value))
      document.documentElement.style.setProperty(`--sweep-inset-${side}`, `${px}px`);
  }, insets);
}

function record(scan: Scan, theme: string, scheme: string, size: string, route: string): void {
  for (const item of scan) findings.push({ ...item, theme, scheme, size, route });
}

const themes = (option("themes") ?? "craft,modern,riso").split(",");
const routes = ROUTES.filter((route) => !option("routes") || route.includes(option("routes") ?? ""));
const shots = flag("shots");

/** A sheet, menu or popover to open and check, as `open` opens it on `route`. */
interface Flow {
  name: string;
  route: string;
  phone: boolean;
  open(page: Page): Promise<void>;
}
const OVERLAY =
  "[role=dialog]:not([hidden]), [role=menu], [role=listbox], [role=tooltip], .ws-member-card, [popover]:popover-open";
const english = translateFor("en");
type LabelKey =
  | "workspace.phone.create"
  | "workspace.phone.chat"
  | "workspace.phone.switch"
  | "workspace.message.react"
  | "workspace.sidebar.newMessage";
const label = (key: LabelKey) => new RegExp(`^${english(key)}`, "u");
const press = (name: RegExp) => async (page: Page) => {
  await page.getByRole("button", { name }).first().click({ timeout: 15_000 });
};
const FLOWS: Flow[] = [
  { name: "create sheet", route: "/app/general/today", phone: true, open: press(label("workspace.phone.create")) },
  {
    name: "space switcher",
    route: "/app/general/today",
    phone: true,
    open: async (page) => {
      await page
        .getByRole("navigation", { name: english("workspace.phone.tabs") })
        .getByRole("button", { name: label("workspace.phone.chat") })
        .click({ timeout: 15_000 });
      await press(label("workspace.phone.switch"))(page);
    },
  },
  {
    name: "member card",
    route: "/app/general/c/general",
    phone: true,
    open: async (page) => page.locator(".ws-member-name-text").first().click({ timeout: 15_000 }),
  },
  {
    name: "command bar",
    route: "/app/general/c/general",
    phone: false,
    open: async (page) => page.keyboard.press("Control+k"),
  },
  {
    name: "shortcuts",
    route: "/app/general/c/general",
    phone: false,
    open: async (page) => page.keyboard.press("Control+/"),
  },
  {
    name: "member card",
    route: "/app/general/c/general",
    phone: false,
    open: async (page) => page.locator(".ws-member-name-text").first().click({ timeout: 15_000 }),
  },
  {
    name: "message menu",
    route: "/app/general/c/general",
    phone: false,
    open: async (page) => page.locator("article.ws-message").nth(1).click({ button: "right", timeout: 15_000 }),
  },
  {
    name: "emoji picker",
    route: "/app/general/c/general",
    phone: false,
    open: async (page) => {
      await page.locator("article.ws-message").nth(1).hover({ timeout: 15_000 });
      await press(label("workspace.message.react"))(page);
    },
  },
  {
    name: "more menu",
    route: "/app/general/c/general",
    phone: false,
    open: press(new RegExp(`^${english("workspace.sidebar.more")}$`, "u")),
  },
  {
    name: "new message",
    route: "/app/general/c/general",
    phone: false,
    open: press(label("workspace.sidebar.newMessage")),
  },
];

async function runFlows(browser: Browser, origin: string): Promise<void> {
  for (const theme of themes)
    for (const phone of [true, false])
      for (const scheme of ["light", "dark"] as const) {
        const ctx = await context(browser, phone, theme, scheme, scheme);
        const sizes = phone ? [PHONE_SIZES[0], PHONE_SIZES[3]] : [DESKTOP_SIZES[0]];
        for (const flow of FLOWS.filter((item) => item.phone === phone)) {
          for (const size of sizes) {
            if (!size) continue;
            const page = await ctx.newPage();
            page.on("pageerror", (error) => pageErrors.push(`${flow.name} ${error.message}`));
            await page.setViewportSize({ width: size.width, height: size.height });
            await page.goto(`${origin}${flow.route}`, { waitUntil: "commit" });
            await settle(page);
            await setInsets(page, size.orientation);
            const where = `${flow.route} [${flow.name}]`;
            try {
              await flow.open(page);
              await page.waitForTimeout(700);
            } catch (error) {
              findings.push({
                kind: "blank",
                theme,
                scheme,
                size: size.name,
                route: where,
                detail: `did not open: ${String(error).slice(0, 120)}`,
              });
              await page.close();
              continue;
            }
            const open = await page.locator(OVERLAY).count();
            if (!open)
              findings.push({
                kind: "blank",
                theme,
                scheme,
                size: size.name,
                route: where,
                detail: "no overlay opened",
              });
            const insets = size.orientation ? INSETS[size.orientation] : null;
            if (scheme === "light")
              record(
                await page.evaluate(scanLayout, { insets, scope: open ? OVERLAY : null }),
                theme,
                scheme,
                size.name,
                where,
              );
            record(await page.evaluate(scanContrast, open ? OVERLAY : null), theme, scheme, size.name, where);
            if (shots)
              await page.screenshot({
                path: resolve(OUT, `flow-${theme}-${scheme}-${size.name}-${flow.name.replace(/\s+/gu, "-")}.png`),
              });
            await page.close();
          }
        }
        await ctx.close();
        writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ findings, pageErrors }, null, 2)}\n`);
        logger.info(`flows ${theme} ${phone ? "phone" : "computer"} ${scheme}: ${findings.length} findings so far`);
      }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  plugins: [webClientPages(), tailwindcss({ optimize: false }), solidPlugin(), safeAreas()],
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  optimizeDeps: {
    entries: ["src/renderer/stories/web-client-visual-harness.tsx"],
    include: ["@norbert_bodziony/bloub"],
  },
  server: {
    host: "127.0.0.1",
    port: Number(option("port") ?? 0),
    strictPort: false,
    fs: { strict: false },
    hmr: false,
  },
});
let browser: Browser | null = null;
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("The harness server has no port.");
  const origin = `http://127.0.0.1:${address.port}`;
  if (flag("serve")) {
    logger.info(`Serving ${origin}/app`);
    await new Promise(() => {});
  }
  const executablePath = option("browser-executable");
  browser = await chromium.launch({ headless: !flag("headed"), ...(executablePath ? { executablePath } : {}) });
  if (flag("flows")) await runFlows(browser, origin);
  for (const theme of flag("flows") ? [] : themes) {
    for (const phone of option("devices") === "phone"
      ? [true]
      : option("devices") === "computer"
        ? [false]
        : [true, false]) {
      const sizes = phone ? PHONE_SIZES : DESKTOP_SIZES;
      for (const scheme of ["light", "dark"] as const) {
        const ctx = await context(browser, phone, theme, scheme, scheme);
        for (const route of routes) {
          const page = await ctx.newPage();
          if (flag("verbose")) logger.info(`${theme} ${scheme} ${phone ? "phone" : "computer"} ${route}`);
          const current = page;
          const crashed = new Promise<"crashed">((done) => {
            current.once("crash", () => done("crashed"));
            setTimeout(() => done("crashed"), 150_000);
          });
          current.on("pageerror", (error) => pageErrors.push(`${current.url()} ${error.message}`));
          const outcome = await Promise.race([
            crashed,
            (async () => {
              await current.goto(`${origin}${route}`, { waitUntil: "commit" });
              if (!(await settle(current)))
                findings.push({ kind: "blank", theme, scheme, size: "", route, detail: "the screen shows nothing" });
              // The layout is the same in light and dark, so dark checks the colors only.
              for (const size of scheme === "light" ? sizes : sizes.slice(0, 1)) {
                await current.setViewportSize({ width: size.width, height: size.height });
                await setInsets(current, size.orientation);
                await current.waitForTimeout(250);
                if (scheme === "light")
                  record(
                    await current.evaluate(scanLayout, {
                      insets: size.orientation ? INSETS[size.orientation] : null,
                      scope: null,
                    }),
                    theme,
                    scheme,
                    size.name,
                    route,
                  );
                if (size === sizes[0])
                  record(await current.evaluate(scanContrast, null), theme, scheme, size.name, route);
                if (shots)
                  await current.screenshot({
                    path: resolve(OUT, `${theme}-${scheme}-${size.name}-${route.replace(/[/?=]+/gu, "_")}.png`),
                  });
              }
              await current.setViewportSize({ width: sizes[0]?.width ?? 390, height: sizes[0]?.height ?? 844 });
              return "done" as const;
            })(),
          ]);
          if (outcome === "crashed")
            findings.push({ kind: "blank", theme, scheme, size: "", route, detail: "the page crashed or hung" });
          await Promise.race([current.close(), new Promise((done) => setTimeout(done, 5000))]);
        }
        await ctx.close();
      }
      // System follows the computer: System on a dark computer paints as Dark does.
      for (const scheme of ["light", "dark"] as const) {
        const explicit = await context(browser, phone, theme, scheme, scheme === "light" ? "dark" : "light");
        const system = await context(browser, phone, theme, "system", scheme);
        const [a, b] = [await explicit.newPage(), await system.newPage()];
        for (const route of routes.slice(0, 4)) {
          await Promise.all([a, b].map((p) => p.goto(`${origin}${route}`, { waitUntil: "commit" })));
          await Promise.all([a, b].map(settle));
          const [left, right] = [await a.evaluate(colorDigest), await b.evaluate(colorDigest)];
          const differ = left.filter((value, index) => value !== right[index]);
          if (left.length === right.length && differ.length > 0)
            findings.push({
              kind: "system",
              theme,
              scheme,
              size: phone ? "phone" : "desk",
              route,
              detail: `${differ.length} elements differ, such as ${differ.slice(0, 3).join(" | ")}`,
            });
        }
        await explicit.close();
        await system.close();
      }
      writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ findings, pageErrors }, null, 2)}\n`);
      logger.info(`${theme} ${phone ? "phone" : "computer"}: ${findings.length} findings so far`);
    }
  }
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ findings, pageErrors }, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
logger.info(`${findings.length} findings, ${pageErrors.length} page errors. Report: ${resolve(OUT, "report.json")}`);
process.exit(findings.length === 0 && pageErrors.length === 0 ? 0 : 1);
