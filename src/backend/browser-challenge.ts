// The checkbox of a Turnstile, reCAPTCHA or hCaptcha check, which one click often passes. Before an
// agent's takeover request reaches the user, the host clicks it once and waits for the check, so a
// simple check needs no person. Based on upstream's browser-challenge.ts (v0.67).

import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Option } from "effect";
import type { WebContents } from "electron";
import {
  automationContextId,
  frameIds,
  isFiniteNumber,
  numberValue,
  recordValue,
  type SendCommand,
  stringValue,
} from "./browser-cdp-values";

/** How long the host waits for the check to pass after its click. */
export const CHALLENGE_CLICK_WAIT_MS = 6_000;

/**
 * How long the host waits for a Turnstile widget to pass by itself before it clicks. Most widgets
 * pass without a click in 1 to 2 seconds, and a click before that can look like a bot to the site.
 */
export const TURNSTILE_SELF_PASS_MS = 3_000;

/** The pause before the click on a widget that does not pass by itself. */
export const CHALLENGE_CLICK_PAUSE_MS = 1_500;

/** How often the host reads the widget again while it waits. */
export const CHALLENGE_POLL_MS = 500;

/** The read looks at the DOM only. A slow page must not hold the takeover. */
const CHECK_TIMEOUT_MS = 1_000;

/** The most frames that the Turnstile lookup reads. A page with a check has few. */
const MAX_WIDGET_FRAMES = 12;

export interface ChallengeWidget {
  vendor: "turnstile" | "recaptcha" | "hcaptcha";
  /** The viewport point of the checkbox of a normal-size widget, or null when none is in view. */
  checkbox: { x: number; y: number } | null;
  /** An image puzzle shows. Only a person solves it. */
  puzzle: boolean;
}

/**
 * Reads the main frame for a check widget that has no token yet. A widget whose response field has a
 * token passed, so the page can submit its form. The checkbox of a normal-size widget is 28 px from
 * its left edge and in its middle. An invisible widget passes by itself and does not count.
 */
const WIDGET_SCRIPT = String.raw`(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const filled = (selector) => [...document.querySelectorAll(selector)].some((element) => (element.value || "").length > 0);
  const turnstilePassed = filled("input[name='cf-turnstile-response']");
  const recaptchaPassed = filled("textarea[name='g-recaptcha-response']");
  const hcaptchaPassed = filled("textarea[name='h-captcha-response']");
  const frames = [...document.querySelectorAll("iframe")];
  const puzzle = frames.some((element) => {
    if (!/\/recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com.*frame=challenge/.test(element.src || "")) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 100 && rect.height > 100 && getComputedStyle(element).visibility !== "hidden";
  });
  const vendorOf = (source) =>
    !turnstilePassed && /challenges\.cloudflare\.com/.test(source)
      ? "turnstile"
      : !recaptchaPassed && /\/recaptcha\/(api2|enterprise)\/anchor/.test(source) && !/size=invisible/.test(source)
        ? "recaptcha"
        : !hcaptchaPassed && /hcaptcha\.com.*frame=checkbox/.test(source)
          ? "hcaptcha"
          : null;
  const widgets = frames.filter((element) => vendorOf(element.src || "") && visible(element));
  let checkbox = null;
  for (const widget of widgets) {
    const rect = widget.getBoundingClientRect();
    if (rect.width < 200 || rect.width > 420 || rect.height < 50 || rect.height > 100) continue;
    if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) continue;
    checkbox = { x: Math.round(rect.left + 28), y: Math.round(rect.top + rect.height / 2) };
    break;
  }
  // Turnstile puts its frame in a closed shadow root, which this world cannot see. Its field without a
  // token asks the main process to find the frame through CDP.
  const turnstileField = !turnstilePassed && widgets.length === 0 && !!document.querySelector("input[name='cf-turnstile-response']");
  let vendor = null;
  if (widgets.length > 0) vendor = vendorOf(widgets[0].src || "");
  else if (turnstileField) vendor = "turnstile";
  else if (puzzle) vendor = frames.some((element) => /hcaptcha/.test(element.src || "")) ? "hcaptcha" : "recaptcha";
  if (!vendor) return null;
  return { vendor, checkbox, puzzle, turnstileField, viewport: { width: innerWidth, height: innerHeight } };
})()`;

interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The box of a visible Turnstile frame in the main document, in viewport CSS pixels. CDP names a
 * frame's owner also inside a closed shadow root. A frame in another process is a child target.
 */
const turnstileFrameBox = Effect.fn("Browser.turnstileFrameBox")(function* (
  send: SendCommand,
  childFrameIds: readonly string[],
) {
  // The first frame of the tree is the page itself.
  const local = frameIds(yield* send("Page.getFrameTree", {})).slice(1);
  for (const frameId of [...new Set([...local, ...childFrameIds])].slice(0, MAX_WIDGET_FRAMES)) {
    const box = yield* Effect.gen(function* () {
      const owner = numberValue((yield* send("DOM.getFrameOwner", { frameId })).backendNodeId);
      if (!owner) return null;
      const node = recordValue((yield* send("DOM.describeNode", { backendNodeId: owner })).node);
      const attributes = Array.isArray(node?.attributes) ? node.attributes.map(stringValue) : [];
      const source = attributes.find((_, index) => index % 2 === 1 && attributes[index - 1] === "src") ?? "";
      if (!/challenges\.cloudflare\.com/.test(source)) return null;
      const quad = recordValue((yield* send("DOM.getBoxModel", { backendNodeId: owner })).model)?.border;
      const corners = Array.isArray(quad) ? quad.filter(isFiniteNumber).slice(0, 8) : [];
      if (corners.length < 8) return null;
      const xs = corners.filter((_, index) => index % 2 === 0);
      const ys = corners.filter((_, index) => index % 2 === 1);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    // A detached frame or a hidden widget has no box.
    if (box && box.width > 20 && box.height > 20) return box;
  }
  return null;
});

function widgetCheckbox(box: FrameBox, viewport: unknown): ChallengeWidget["checkbox"] {
  const size = recordValue(viewport);
  const width = numberValue(size?.width);
  const height = numberValue(size?.height);
  if (box.width < 200 || box.width > 420 || box.height < 50 || box.height > 100) return null;
  if (box.left < 0 || box.top < 0 || box.left + box.width > width || box.top + box.height > height) return null;
  return { x: Math.round(box.left + 28), y: Math.round(box.top + box.height / 2) };
}

function readCheckbox(value: unknown): ChallengeWidget["checkbox"] {
  if (!isDynamicRecord(value)) return null;
  const { x, y } = value;
  return typeof x === "number" && typeof y === "number" && x >= 0 && y >= 0 ? { x, y } : null;
}

function readVendor(value: unknown): ChallengeWidget["vendor"] | null {
  return value === "turnstile" || value === "recaptcha" || value === "hcaptcha" ? value : null;
}

/**
 * The check widget of the main frame that still waits for a person, or null when there is none or it
 * passed. It reads the page in the isolated automation world, so the page cannot change what it reads.
 * `childFrameIds` names the frames in other processes, where a Turnstile widget usually is. A failure
 * or a non-web page gives null.
 */
export const readChallengeWidget = Effect.fn("Browser.readChallengeWidget")(function* (
  contents: WebContents,
  send: SendCommand,
  childFrameIds: readonly string[],
) {
  if (contents.isDestroyed()) return null;
  const url = contents.getURL();
  if (!url.startsWith("https://") && !url.startsWith("http://")) return null;
  return yield* Effect.gen(function* () {
    const contextId = yield* automationContextId(send);
    const result = yield* send("Runtime.evaluate", { expression: WIDGET_SCRIPT, contextId, returnByValue: true });
    const value = isDynamicRecord(result.result) ? result.result.value : undefined;
    if (!isDynamicRecord(value)) return null;
    const vendor = readVendor(value.vendor);
    if (!vendor) return null;
    const widget: ChallengeWidget = { vendor, checkbox: readCheckbox(value.checkbox), puzzle: value.puzzle === true };
    if (value.turnstileField !== true || widget.puzzle) return widget;
    const box = yield* turnstileFrameBox(send, childFrameIds);
    // A Turnstile field alone is no check: a widget in invisible mode passes by itself.
    if (!box) return null;
    return { ...widget, checkbox: widgetCheckbox(box, value.viewport) };
  }).pipe(
    Effect.timeoutOption(CHECK_TIMEOUT_MS),
    Effect.map((option) => Option.getOrNull(option)),
    Effect.catch(() => Effect.succeed(null)),
  );
});
