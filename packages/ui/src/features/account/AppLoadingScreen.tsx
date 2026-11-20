import { AtelierSymbol } from "@openbot/brand";
import { atelierTheme } from "@openbot/brand/atelier-appearance";
import type { FaceState } from "@openbot/brand/faces";
import type { AppTextKey } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, onSettled, untrack } from "solid-js";
import { ErrorReference } from "../../error-reference";
import { useText } from "../../text";
import { AgentFace } from "../agents/AgentFace";

/*
 * The Atelier crew: the workspace's symbol over three agent faces, drawn in the workspace's theme,
 * face family and skin tone (Craft, portrait and the light tone before a workspace answered). The
 * faces act out the wait: they work while the app connects, doze while a server sleeps, look
 * worried when it failed, and rest while the app waits to try again. Their expressions are the
 * faces' own SMIL animation; the CSS bobs them in a wave and lifts them out when the app is ready.
 * Reduced motion holds both still.
 *
 * One clock drives the screen, so each run shows the same frames: the status line is a function of
 * the elapsed time. The CSS animations start at the same time as the clock: `--app-loading-at`
 * moves them back to the clock's time when the screen mounts.
 */
const CREW_FPS = 30;
const WAVE_S = 1.6;
const BOB_STAGGER_S = 0.18;
const LOOP_S = WAVE_S * 3;
const STATUS_EVERY_S = LOOP_S / 2;
// When the app is ready before this time, the screen only fades. The crew does not jump out.
const QUICK_EXIT_S = 0.6;
// The longest exit is 760ms of jumps and the fade. If no `animationend` comes, the screen ends after
// this time, so it cannot cover the app.
const EXIT_LIMIT_MS = 2500;
const EXIT_ANIMATION = "app-loading-exit";

const STATUS_LINES = [
  "webClient.loadingLine.wake",
  "webClient.loadingLine.coffee",
  "webClient.loadingLine.tokens",
  "webClient.loadingLine.prompts",
  "webClient.loadingLine.sleepy",
  "webClient.loadingLine.almost",
] as const satisfies readonly AppTextKey[];

/** What the crew acts out: the app connects or loads, a server sleeps, a failure, or a wait to retry. */
export type AppLoadingMood = "working" | "dozing" | "worried" | "idle";

const MOOD_FACES: Readonly<Record<AppLoadingMood, FaceState>> = {
  working: "working",
  dozing: "sleeping",
  worried: "failed",
  idle: "idle",
};

// Three different people in three hues. The names choose the hats, such as the designer's beret.
const CREW = [
  { id: "atelier-crew-3", name: "Designer" },
  { id: "atelier-crew-4", name: "Researcher" },
  { id: "atelier-crew-14", name: "Writer" },
] as const;

/*
 * The screens on one page share one clock. The `/app` page shows a screen while the web client's code
 * loads, and the web client then shows its own. The second screen continues the loop of the first,
 * so the crew does not start again at the handoff.
 */
const HANDOFF_MS = 1000;
const sharedClock = { start: 0, screens: 0, lastUnmount: Number.NEGATIVE_INFINITY };

/** The clock time in seconds for a screen that mounts now. A new run starts when no screen is shown. */
function clockTime(now: number): number {
  if (sharedClock.screens === 0 && now - sharedClock.lastUnmount > HANDOFF_MS) sharedClock.start = now;
  return (now - sharedClock.start) / 1000;
}

/** Keeps the run going while this screen is shown. Returns the cleanup that ends it. */
function joinClock(): () => void {
  sharedClock.screens += 1;
  return () => {
    sharedClock.screens -= 1;
    sharedClock.lastUnmount = performance.now();
  };
}

function snapToFrame(seconds: number): number {
  return Math.floor(seconds * CREW_FPS) / CREW_FPS;
}

export interface AppLoadingScreenProps {
  /** The app is ready: the crew jumps out and the screen fades. Remove the screen in `onExited`. */
  ready?: boolean;
  /** What the crew acts out. Default: `working`. */
  mood?: AppLoadingMood;
  onExited?: () => void;
  /** Stop the clock and show the frame at this time, in seconds. */
  at?: number;
  /** What the screen waits for, for a screen reader. The default is the app load. */
  label?: string;
  title?: string;
  detail?: string;
  /** The code of the failure in `detail`, for a user to copy into a report. */
  reference?: string | null;
  actions?: JSX.Element;
  /** Content under the actions, such as an offer that the wait makes useful. */
  footer?: JSX.Element;
}

export function AppLoadingScreen(props: AppLoadingScreenProps) {
  const { t } = useText();
  // A screen stays in one mode: it shows one frame or it plays.
  const scrub = untrack(() => props.at !== undefined);
  const mountedAt = scrub ? 0 : snapToFrame(clockTime(performance.now()));
  const [clock, setClock] = createSignal(mountedAt);
  const seconds = () => props.at ?? clock();
  const status = () => STATUS_LINES[Math.floor(seconds() / STATUS_EVERY_S) % STATUS_LINES.length] ?? STATUS_LINES[0];
  // The clock stops when the app is ready, so the exit that it selects cannot change.
  const phase = () => {
    if (!props.ready) return "loading";
    return seconds() < QUICK_EXIT_S ? "fade" : "exit";
  };
  let frameRequest = 0;
  let stopped = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let exited = false;
  let root: HTMLElement | undefined;

  function finishExit(): void {
    if (exited) return;
    exited = true;
    clearTimeout(exitTimer);
    props.onExited?.();
  }

  function stopClock(): void {
    stopped = true;
    cancelAnimationFrame(frameRequest);
  }

  const mood = (): AppLoadingMood => props.mood ?? "working";
  const brand = () => atelierTheme() ?? "craft";

  createEffect(
    () => props.ready,
    (ready) => {
      if (!ready) return;
      stopClock();
      exitTimer ??= setTimeout(finishExit, EXIT_LIMIT_MS);
      // Without the stylesheet, or in a test DOM, the exit does not animate: end the screen now.
      if (root && !getComputedStyle(root).animationName.includes(EXIT_ANIMATION)) queueMicrotask(finishExit);
    },
  );

  onSettled(() => {
    if (scrub) return () => clearTimeout(exitTimer);
    const leaveClock = joinClock();
    const start = performance.now();
    const tick = (now: number) => {
      frameRequest = requestAnimationFrame(tick);
      // Snap to whole frames, so a given time always draws the same frame.
      setClock(snapToFrame(mountedAt + Math.max(0, now - start) / 1000));
    };
    if (!stopped) frameRequest = requestAnimationFrame(tick);
    return () => {
      stopClock();
      clearTimeout(exitTimer);
      leaveClock();
    };
  });

  function handleAnimationEnd(event: AnimationEvent): void {
    if (event.animationName === EXIT_ANIMATION && event.target === event.currentTarget) finishExit();
  }

  return (
    <main
      ref={(element) => {
        root = element;
      }}
      class="app-loading"
      style={{
        "--app-loading-wave": `${WAVE_S}s`,
        "--app-loading-stagger": `${BOB_STAGGER_S}s`,
        "--app-loading-at": `${props.at ?? mountedAt}s`,
      }}
      data-phase={phase()}
      data-mood={mood()}
      data-scrub={scrub ? "true" : undefined}
      role="status"
      aria-live="polite"
      aria-busy={props.ready ? "false" : "true"}
      onAnimationEnd={handleAnimationEnd}
    >
      <span class="sr-only">{props.label ?? t("webClient.loading")}</span>
      <div class="app-loading-stage">
        <AtelierSymbol theme={brand()} class="app-loading-symbol" />
        <div class="app-loading-row" aria-hidden="true">
          <For each={CREW}>
            {(member, index) => (
              <div class="app-loading-agent" style={{ "--app-loading-index": index() }}>
                <div class="app-loading-body">
                  <AgentFace
                    id={member.id}
                    name={member.name}
                    state={MOOD_FACES[mood()]}
                    celebrate={false}
                    class="app-loading-face"
                  />
                </div>
              </div>
            )}
          </For>
        </div>
        <p class="app-loading-status">
          {props.title ?? <For each={[status()]}>{(line) => <span class="app-loading-line">{t(line)}</span>}</For>}
        </p>
        {props.detail && <p class="server-connection-detail">{props.detail}</p>}
        <ErrorReference reference={props.reference} />
        {props.actions && <div class="server-connection-actions">{props.actions}</div>}
        {props.footer}
      </div>
    </main>
  );
}

/** The length of the crew's loop in seconds, for a story that shows one frame. */
export const APP_LOADING_LOOP_S = LOOP_S;
/** The frame rate of the crew's clock, for a story that shows one frame. */
export const APP_LOADING_FPS = CREW_FPS;
