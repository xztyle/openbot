import {
  BROWSER_LIVE_VIEW_MAX_PASTE_TEXT,
  type BrowserDesktopApi,
  type BrowserLiveViewInput,
} from "@openbot/contracts/ipc";
import { Button, ErrorReference, IconButton, Input, Keyboard, Scan, toast } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { clamp, usesTouchLayout } from "@openbot/ui/utils";
import { errorReference } from "@openbot/user-errors";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  createStore,
  onCleanup,
  type Setter,
  Show,
  untrack,
} from "solid-js";

/** CDP's modifier bitmap, which is what the host dispatches the event with. */
const ALT = 1;
const CONTROL = 2;
const META = 4;
const SHIFT = 8;

/** What a view asks of the host when it starts. */
export interface BrowserLiveViewStartOptions {
  /** The page size, in CSS pixels, that the host holds while this view is open. */
  viewport?: { width: number; height: number };
}

export interface BrowserViewRuntime
  extends Pick<BrowserDesktopApi, "stopLiveView" | "sendLiveViewInput" | "onLiveViewEvent"> {
  startLiveView(tabId: string, options?: BrowserLiveViewStartOptions): Promise<void>;
  /** Whether the host holds the page at the size a view asks for. Absent: it does not. */
  liveViewHoldsViewport?: () => boolean;
}

/** One frame of the host's screencast, as the renderer receives it. */
interface LiveViewFrame {
  sequence: number;
  width: number;
  height: number;
  image: Uint8Array;
}

interface BrowserLiveViewProps {
  runtime: BrowserViewRuntime;
  tabId: string;
  /** False while the panel is closed: a view nobody is looking at still costs the host a screencast. */
  active: boolean;
  /** Whether the host pastes and copies for this view. An older host closes the view on either. */
  clipboard: boolean;
  /**
   * False while the connection to the host is down. The view stops, says that it reconnects, and
   * starts again when the connection is back.
   */
  online?: boolean | undefined;
  /** The pixel size of the frame on the canvas, so the panel can take the page's shape. */
  onFrameSize?: (size: { width: number; height: number }) => void;
  /**
   * The view asks the host to give the page the size of this view, so the page fills it at its own
   * scale. Only a view that is the page's main surface asks: a card would make the page small.
   */
  fitPage?: boolean;
  /** The agent is acting on the tab. The view holds the person's input and says so. */
  locked?: boolean | undefined;
  /** The person takes the tab from the agent. The input goes to the page at once. */
  onTakeOver?: (() => void) | undefined;
}

/**
 * A runtime has one live view: a second start ends the first stream. Each runtime remembers which
 * view on the screen owns it, so a view that another view replaced does not stop that view's stream
 * when it closes, and starts its own again once the other one is gone.
 */
const viewOwners = new WeakMap<object, { owner: Accessor<symbol | null>; setOwner: Setter<symbol | null> }>();
function liveViewOwner(runtime: BrowserViewRuntime) {
  let entry = viewOwners.get(runtime);
  if (!entry) {
    const [owner, setOwner] = createSignal<symbol | null>(null);
    entry = { owner, setOwner };
    viewOwners.set(runtime, entry);
  }
  return entry;
}

/**
 * A stream that ends after it showed the page starts again, this many times in a row, before the
 * view gives up. A stream counts as steady again only after it has run for `STEADY_STREAM_MS`: the
 * count used to go back to zero at the first frame, so a stream that ended a moment after each start
 * started again for ever and the view said "Reconnecting" again and again.
 */
const MAX_RECONNECTS = 6;
const RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 8_000;
const STEADY_STREAM_MS = 10_000;
/** A restart that shows the page again within this time says nothing. */
const RECONNECT_NOTICE_DELAY_MS = 2_000;
/** A started stream that sends no frame in this time is started again. */
const FIRST_FRAME_TIMEOUT_MS = 15_000;
/** The view asks for a new page size when its own size changes by more than this. */
const VIEWPORT_STEP_PX = 24;
const VIEWPORT_SETTLE_MS = 300;
const VIEWPORT_LIMITS = { minWidth: 320, minHeight: 240, maxWidth: 2_560, maxHeight: 2_560 };
/** A finger that moves less than this is a tap, not a scroll. */
const TAP_SLOP_PX = 10;
/** Two taps this close in time and place are a double click. */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 24;
const MAX_ZOOM = 4;
/** Keys that the on-screen keyboard sends as keys, not as text. */
const NAMED_KEYS = new Set([
  "Enter",
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const NAMED_KEY_CODES: Record<string, string> = { "\n": "Enter", "\t": "Tab" };

/**
 * The page on a remote host, drawn here.
 *
 * A local tab is a native view placed over this panel, so there is nothing to draw. A host's tab is
 * somewhere else entirely, and before this the panel showed a still image that changed when the user
 * asked for another one. The host sends frames while anyone watches, and the pointer and keys go
 * back on the same socket as a fraction of the frame the user was actually looking at.
 *
 * On a touch screen a tap is a click, a drag scrolls the page, and two fingers zoom the view. The
 * keyboard button focuses a field that is not shown, so the phone raises its keyboard; the text and
 * the keys typed there go to the page.
 */
export default function BrowserLiveView(props: BrowserLiveViewProps) {
  const runtime = props.runtime;
  const { t, errorMessage, sourceText } = useText();
  const me = Symbol("browser-live-view");
  const ownership = liveViewOwner(runtime);
  /** Another view on the screen shows this runtime's stream. */
  const elsewhere = createMemo(() => {
    const owner = ownership.owner();
    return owner !== null && owner !== me;
  });
  /** The owner now, read outside a tracking scope. */
  const ownerNow = () => untrack(ownership.owner);
  // `message` is null while the view connects, and otherwise text from the host or an error.
  // `reference` is the code of a failed start. `notice` shows over a page that is still on the canvas.
  const [state, setState] = createStore<{
    live: boolean;
    message: string | null;
    reference: string | null;
    notice: string | null;
  }>({
    live: false,
    message: null,
    reference: null,
    notice: null,
  });
  const [canvas, setCanvas] = createSignal<HTMLCanvasElement>();
  let root: HTMLDivElement | undefined;
  let keys: HTMLInputElement | undefined;
  /**
   * The frame the canvas is showing, which is not the last frame to arrive. Decoding is
   * asynchronous, so while the host resizes its viewport the newest frame's shape and the drawn
   * pixels disagree. `object-fit` letterboxes what is drawn, so a pointer placed with the newer
   * shape would miss by the difference between the two bands. Its sequence goes back with every
   * point, so the host expands the fraction against these pixels and not a frame still in transit.
   * It stays unset until the first frame is drawn, which is what holds input back while there is
   * nothing on the canvas to aim at.
   */
  const [frame, setFrame] = createSignal<{ sequence: number; width: number; height: number }>();
  let pendingFrame: Promise<void> | undefined;
  /**
   * The newest frame to arrive while another was decoding. Only the newest is worth keeping: it is
   * the page as it is now, and the ones behind it are a page nobody can still act on.
   */
  let queuedFrame: LiveViewFrame | undefined;
  /** Which stream the frames belong to. Another tab, or the same tab again, is a new one. */
  let stream = 0;
  /** The tab whose page the canvas shows. */
  let shownTab: string | undefined;
  /** Whether the current stream has shown the page. Only such a stream starts again when it ends. */
  let streamShown = false;
  const [attempt, setAttempt] = createSignal(0);
  let reconnects = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let steadyTimer: ReturnType<typeof setTimeout> | undefined;
  let firstFrameTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * A start is on its way. A runtime ends its previous stream as it opens the next one, and that
   * end is not news: it is the stream this view replaced.
   */
  let starting = 0;
  const clearReconnect = () => {
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };
  const clearTimers = () => {
    clearReconnect();
    if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    noticeTimer = undefined;
    if (steadyTimer !== undefined) clearTimeout(steadyTimer);
    steadyTimer = undefined;
    if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer);
    firstFrameTimer = undefined;
  };
  onCleanup(clearTimers);
  /** Starts the stream again after a delay that grows with each restart in a row, with the page kept on the canvas. */
  const scheduleReconnect = () => {
    const delay = Math.min(RECONNECT_DELAY_MS * 2 ** reconnects, MAX_RECONNECT_DELAY_MS);
    reconnects += 1;
    if (steadyTimer !== undefined) clearTimeout(steadyTimer);
    steadyTimer = undefined;
    // A short gap shows nothing. The notice comes only when the page has not come back.
    if (noticeTimer === undefined)
      noticeTimer = setTimeout(() => {
        noticeTimer = undefined;
        setState((draft) => {
          if (draft.live) draft.notice = t("browser.liveView.reconnecting");
        });
      }, RECONNECT_NOTICE_DELAY_MS);
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      setAttempt((value) => value + 1);
    }, delay);
  };

  /** The touch controls show on a touch screen, and once a finger has touched the page. */
  const [touch, setTouch] = createSignal(usesTouchLayout());
  const [keyboard, setKeyboard] = createSignal(false);
  /** The view's own zoom on a touch screen: the page stays the same size on the host. */
  const [zoom, setZoom] = createSignal({ scale: 1, x: 0, y: 0 });

  /**
   * Forget the stream that just ended, including the frame still decoding in it. That frame is a
   * page nobody is watching any more: drawn late it would put stale pixels and stale geometry under
   * a pointer that now belongs somewhere else, and left pending it would drop the new stream's
   * frames until it finished.
   */
  const abandonStream = () => {
    stream += 1;
    streamShown = false;
    pendingFrame = undefined;
    queuedFrame = undefined;
    setFrame(undefined);
  };

  const draw = async (next: LiveViewFrame) => {
    const element = canvas();
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const drawnFor = stream;
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(next.image)], { type: "image/jpeg" }));
    if (drawnFor !== stream) {
      bitmap.close();
      return;
    }
    // The canvas takes the pixels of the image, not the page size the frame reports. The host scales
    // a page larger than its frame limit down (a 2000 px page comes as a 1280 px image), and an image
    // drawn at its own size into a canvas of the page's size filled only its top-left corner. CSS
    // (`object-fit: contain`) scales the canvas to the view, whatever size the image has.
    if (element.width !== bitmap.width || element.height !== bitmap.height) {
      element.width = bitmap.width;
      element.height = bitmap.height;
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    setFrame({ sequence: next.sequence, width: next.width, height: next.height });
  };

  /**
   * Decode one frame, then whichever frame arrived last while it was decoding. Dropping a frame and
   * waiting for the next one is wrong for a page that has stopped changing: the host sends nothing
   * more, and the canvas would keep the frame before the last resize for as long as the user looks
   * at it.
   */
  const decode = (next: LiveViewFrame) => {
    const drawing: Promise<void> = draw(next)
      .catch(() => undefined)
      .finally(() => {
        // An abandoned stream leaves its decode running, so only the promise that is still the
        // pending one may clear it or start the frame behind it.
        if (pendingFrame !== drawing) return;
        pendingFrame = undefined;
        const queued = queuedFrame;
        queuedFrame = undefined;
        if (queued) decode(queued);
      });
    pendingFrame = drawing;
  };

  /**
   * The copy that waits for the host's answer. Its clipboard write started in the key press, the one
   * moment every browser lets a page write, and it holds until the answer settles it.
   */
  let pendingCopy: ((answer: CopyAnswer) => void) | undefined;
  const settleCopy = (answer: CopyAnswer) => {
    const settle = pendingCopy;
    pendingCopy = undefined;
    settle?.(answer);
  };
  onCleanup(() => settleCopy(null));

  const stopListening = runtime.onLiveViewEvent((event) => {
    if (event.tabId !== props.tabId || untrack(elsewhere)) return;
    if (event.type === "copied") {
      settleCopy({ text: event.text });
      return;
    }
    if (event.type === "copyTooLarge") {
      settleCopy("tooLarge");
      return;
    }
    if (event.type === "stopped") {
      settleCopy(null);
      if (starting > 0) return;
      // A restart that ends before its first frame is part of the same gap.
      const shown = streamShown || (reconnects > 0 && state.live);
      abandonStream();
      // A stream that ended while the view is still open is a dropped connection, a host that
      // restarted its screencast, or a relay that fell behind. The view keeps the last page and
      // starts again. A tab that closed ends the request, and the view closes with it.
      if (shown && props.active && props.online !== false && reconnects < MAX_RECONNECTS) {
        scheduleReconnect();
        return;
      }
      clearTimers();
      setState(() => ({ live: false, message: sourceText(event.reason), reference: null, notice: null }));
      return;
    }
    if (!streamShown) {
      streamShown = true;
      if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer);
      firstFrameTimer = undefined;
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      noticeTimer = undefined;
      if (steadyTimer !== undefined) clearTimeout(steadyTimer);
      steadyTimer = setTimeout(() => {
        steadyTimer = undefined;
        reconnects = 0;
      }, STEADY_STREAM_MS);
    }
    if (!state.live || state.notice) setState(() => ({ live: true, message: "", reference: null, notice: null }));
    // One frame decodes at a time, and the newest of the rest waits behind it.
    if (pendingFrame) {
      queuedFrame = event;
      return;
    }
    decode(event);
  });
  onCleanup(stopListening);

  /**
   * The size of this view, for a host that gives the page the size the view asks for. It changes
   * only by whole steps and after the view has stopped moving, because each change starts the
   * stream again.
   */
  const [panel, setPanel] = createSignal<{ width: number; height: number } | null>(null, {
    equals: (previous, next) => previous?.width === next?.width && previous?.height === next?.height,
  });
  const holdsViewport = () => props.fitPage === true && runtime.liveViewHoldsViewport?.() === true;
  createEffect(
    () => holdsViewport(),
    (holds) => {
      const element = root;
      if (!holds || !element || typeof ResizeObserver === "undefined") return;
      let settle: ReturnType<typeof setTimeout> | undefined;
      const measure = () => {
        settle = undefined;
        const box = element.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) return;
        const next = {
          width: Math.round(clamp(box.width, VIEWPORT_LIMITS.minWidth, VIEWPORT_LIMITS.maxWidth)),
          height: Math.round(clamp(box.height, VIEWPORT_LIMITS.minHeight, VIEWPORT_LIMITS.maxHeight)),
        };
        const current = untrack(panel);
        if (
          current &&
          Math.abs(current.width - next.width) < VIEWPORT_STEP_PX &&
          Math.abs(current.height - next.height) < VIEWPORT_STEP_PX
        )
          return;
        setPanel(next);
      };
      const observer = new ResizeObserver(() => {
        // The first size goes at once, so the stream does not wait for it.
        if (untrack(panel) === null) {
          measure();
          return;
        }
        if (settle !== undefined) clearTimeout(settle);
        settle = setTimeout(measure, VIEWPORT_SETTLE_MS);
      });
      observer.observe(element);
      return () => {
        observer.disconnect();
        if (settle !== undefined) clearTimeout(settle);
      };
    },
  );
  /** The page size to ask for: null asks for none, undefined waits for the first measure. */
  type AskedViewport = { width: number; height: number } | null | undefined;
  const viewport = createMemo((): AskedViewport => (holdsViewport() ? (panel() ?? undefined) : null), {
    equals: (previous: AskedViewport, next: AskedViewport) =>
      previous === next || (previous?.width === next?.width && previous?.height === next?.height),
  });

  createEffect(
    () => ({
      tabId: props.tabId,
      active: props.active,
      online: props.online !== false,
      blocked: elsewhere(),
      attempt: attempt(),
      viewport: viewport(),
    }),
    ({ tabId, active, online, blocked, attempt: retry, viewport: size }) => {
      if (!active) {
        clearTimers();
        reconnects = 0;
        return;
      }
      if (blocked) {
        abandonStream();
        setState(() => ({ live: false, message: t("browser.liveView.elsewhere"), reference: null, notice: null }));
        return;
      }
      if (!online) {
        abandonStream();
        clearTimers();
        setState((draft) => {
          if (draft.live) draft.notice = t("browser.liveView.reconnecting");
          else draft.message = t("browser.liveView.reconnecting");
        });
        return;
      }
      // The first measure of the view is a moment away; a start before it would ask for no size.
      if (size === undefined) return;
      // A restart of the same tab, for a reconnect or a new page size, keeps the page on the canvas.
      // Another tab shows the connecting text.
      const sameTab = shownTab === tabId && untrack(() => state.live);
      abandonStream();
      if (!sameTab && (retry === 0 || !untrack(() => state.live)))
        setState(() => ({ live: false, message: null, reference: null, notice: null }));
      shownTab = tabId;
      ownership.setOwner(me);
      starting += 1;
      if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer);
      firstFrameTimer = undefined;
      void runtime
        .startLiveView(tabId, size ? { viewport: size } : undefined)
        .then(
          () => {
            // A stream that never sends a frame is as good as a dropped one.
            if (ownerNow() !== me || streamShown) return;
            firstFrameTimer = setTimeout(() => {
              firstFrameTimer = undefined;
              if (streamShown || ownerNow() !== me || !props.active) return;
              if (reconnects < MAX_RECONNECTS) scheduleReconnect();
            }, FIRST_FRAME_TIMEOUT_MS);
          },
          (error: unknown) => {
            if (ownerNow() !== me) return;
            // A restart in a gap tries again while the page is still on the canvas.
            if (reconnects > 0 && untrack(() => state.live) && reconnects < MAX_RECONNECTS && props.active) {
              scheduleReconnect();
              return;
            }
            clearTimers();
            setState(() => ({
              live: false,
              message: errorMessage(error, t("browser.liveView.failed")),
              reference: errorReference(error),
              notice: null,
            }));
          },
        )
        .finally(() => {
          starting -= 1;
        });
      return () => {
        // A view that another view replaced leaves that view's stream running.
        if (ownerNow() !== me) return;
        ownership.setOwner(null);
        // The end of a stream this view stops itself is not a dropped stream.
        starting += 1;
        void runtime
          .stopLiveView()
          .catch(() => undefined)
          .finally(() => {
            starting -= 1;
          });
      };
    },
  );
  onCleanup(() => {
    if (ownerNow() === me) ownership.setOwner(null);
  });

  createEffect(
    () => ({ drawn: frame(), onFrameSize: props.onFrameSize }),
    ({ drawn, onFrameSize }) => {
      if (drawn) onFrameSize?.({ width: drawn.width, height: drawn.height });
    },
  );

  const send = (input: BrowserLiveViewInput) => {
    // While the agent acts, the person's input waits for a take over: two hands on one page click
    // each other's targets. The acknowledgement of a drawn frame is not input.
    if (props.locked && input.type !== "ack") return;
    void runtime.sendLiveViewInput(input).catch(() => undefined);
  };

  // A view nobody clicks still has to say which frame is on screen. The host otherwise keeps
  // every frame it sent for the whole session.
  createEffect(
    () => frame(),
    (drawn) => {
      if (!drawn) return;
      send({ type: "ack", sequence: drawn.sequence });
    },
  );

  /**
   * Where on the frame the pointer is, which is not where on the canvas it is. The canvas fills the
   * panel and draws the frame with `object-fit: contain`, so a frame of a different shape sits
   * letterboxed inside it - a wide page in a narrow panel is a band with most of the panel above and
   * below it. A fraction of the canvas box would put every click that many bars away from the point
   * the user aimed at. The box is read after the view's zoom, so a zoomed page needs nothing more.
   *
   * Null means there is no point to send. The bars are not the page, and a point on one clamped to
   * the edge of the frame would work the first or last row of a page the user never pointed at.
   * Nothing drawn yet is the same answer: there is no frame to be a fraction of.
   */
  /**
   * The box the frame is drawn in on the screen. The canvas holds the image's pixels, which can be
   * fewer than the page's (a host scales a large page down), and `object-fit: contain` keeps the
   * image's shape, so the box comes from the canvas's own size.
   */
  const drawnBox = () => {
    const element = canvas();
    const bounds = element?.getBoundingClientRect();
    const size = frame();
    if (!element || !bounds || !size || bounds.width === 0 || bounds.height === 0) return null;
    const pixels = { width: element.width || size.width, height: element.height || size.height };
    if (pixels.width === 0 || pixels.height === 0 || size.width === 0 || size.height === 0) return null;
    const scale = Math.min(bounds.width / pixels.width, bounds.height / pixels.height);
    const width = pixels.width * scale;
    const height = pixels.height * scale;
    return {
      left: bounds.left + (bounds.width - width) / 2,
      top: bounds.top + (bounds.height - height) / 2,
      width,
      height,
      size,
    };
  };

  const point = (
    at: { clientX: number; clientY: number },
    toEdge = false,
  ): { x: number; y: number; sequence: number } | null => {
    const box = drawnBox();
    if (!box) return null;
    const x = (at.clientX - box.left) / box.width;
    const y = (at.clientY - box.top) / box.height;
    // A held button works the page wherever the mouse goes, as a drag out of a browser window does.
    if (toEdge) return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), sequence: box.size.sequence };
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y, sequence: box.size.sequence };
  };

  /** Page pixels for one CSS pixel on the screen, after the zoom. */
  const pagePixelsPerScreenPixel = (): number => {
    const box = drawnBox();
    return box ? box.size.width / box.width : 1;
  };

  /** A mouse that a touch made up. The touch already sent its own input. */
  let lastTouchAt = 0;
  const fromTouch = () => performance.now() - lastTouchAt < 800;

  /**
   * A mouse button pressed on the page. The canvas captures the pointer, so the moves and the release
   * come here when the mouse leaves the view. A release outside used to stay on this side, and the
   * page dragged on every move after it, selecting text, until the next click.
   */
  let mouseHeld = false;
  const pointer = (event: MouseEvent, action: "move" | "down" | "up") => {
    if (fromTouch()) return;
    const at = point(event, mouseHeld && action !== "down");
    if (action === "up" && event.buttons === 0) mouseHeld = false;
    if (!at) return;
    if (action === "down") mouseHeld = true;
    send({
      type: "pointer",
      action,
      ...at,
      button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left",
      clickCount: Math.min(Math.max(event.detail, 1), 3),
      modifiers: modifiers(event),
    });
  };

  // Touch: one finger taps or scrolls, two fingers zoom and move the view.
  const touches = new Map<number, { x: number; y: number }>();
  let gesture:
    | { kind: "tap" | "scroll"; start: { x: number; y: number }; last: { x: number; y: number }; at: number }
    | { kind: "pinch"; distance: number; scale: number; content: { x: number; y: number } }
    | { kind: "done" }
    | null = null;
  let lastTap: { x: number; y: number; at: number } | null = null;
  let scrollPending = { x: 0, y: 0, at: { clientX: 0, clientY: 0 } };
  let scrollFrame: number | undefined;
  onCleanup(() => {
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
  });

  const fingers = () => [...touches.values()];
  const midpoint = () => {
    const [first, second] = fingers();
    if (!first || !second) return { x: 0, y: 0 };
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  };
  const spread = () => {
    const [first, second] = fingers();
    if (!first || !second) return 1;
    return Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
  };
  /** The view's own offset, kept so the zoomed page always covers the view. */
  const clampZoom = (next: { scale: number; x: number; y: number }) => {
    const box = root?.getBoundingClientRect();
    const scale = clamp(next.scale, 1, MAX_ZOOM);
    if (!box || scale === 1) return { scale: 1, x: 0, y: 0 };
    return {
      scale,
      x: clamp(next.x, box.width - box.width * scale, 0),
      y: clamp(next.y, box.height - box.height * scale, 0),
    };
  };

  const flushScroll = () => {
    scrollFrame = undefined;
    const pending = scrollPending;
    scrollPending = { x: 0, y: 0, at: pending.at };
    if (pending.x === 0 && pending.y === 0) return;
    const at = point(pending.at);
    if (!at) return;
    // CDP reads a wheel delta the way the DOM event carries it: down is positive. A finger that
    // moves up scrolls the page down, as on the phone's own pages.
    send({ type: "pointer", action: "wheel", ...at, button: "left", deltaX: pending.x, deltaY: pending.y });
  };

  /** Moves a zoomed view first; what the view cannot take scrolls the page. */
  const drag = (dx: number, dy: number, at: { clientX: number; clientY: number }) => {
    const current = zoom();
    let restX = dx;
    let restY = dy;
    if (current.scale > 1) {
      const moved = clampZoom({ scale: current.scale, x: current.x + dx, y: current.y + dy });
      restX = dx - (moved.x - current.x);
      restY = dy - (moved.y - current.y);
      setZoom(moved);
    }
    if (restX === 0 && restY === 0) return;
    const ratio = pagePixelsPerScreenPixel();
    scrollPending = {
      x: scrollPending.x - restX * ratio,
      y: scrollPending.y - restY * ratio,
      at,
    };
    if (scrollFrame === undefined) scrollFrame = requestAnimationFrame(flushScroll);
  };

  const tap = (at: { clientX: number; clientY: number }) => {
    const target = point(at);
    if (!target) return;
    const now = performance.now();
    const double =
      lastTap !== null &&
      now - lastTap.at < DOUBLE_TAP_MS &&
      Math.hypot(lastTap.x - at.clientX, lastTap.y - at.clientY) < DOUBLE_TAP_PX;
    lastTap = double ? null : { x: at.clientX, y: at.clientY, at: now };
    const clickCount = double ? 2 : 1;
    send({ type: "pointer", action: "move", ...target, button: "left" });
    send({ type: "pointer", action: "down", ...target, button: "left", clickCount });
    send({ type: "pointer", action: "up", ...target, button: "left", clickCount });
  };

  const touchDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse") canvas()?.setPointerCapture?.(event.pointerId);
    if (event.pointerType !== "touch") return;
    // The view takes the finger: no compatibility mouse event, no scroll or zoom of this page.
    event.preventDefault();
    lastTouchAt = performance.now();
    setTouch(true);
    canvas()?.setPointerCapture?.(event.pointerId);
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 1) {
      const start = { x: event.clientX, y: event.clientY };
      gesture = { kind: "tap", start, last: start, at: performance.now() };
      return;
    }
    if (touches.size === 2) {
      const box = root?.getBoundingClientRect();
      const current = zoom();
      const mid = midpoint();
      gesture = {
        kind: "pinch",
        distance: spread(),
        scale: current.scale,
        content: {
          x: (mid.x - (box?.left ?? 0) - current.x) / current.scale,
          y: (mid.y - (box?.top ?? 0) - current.y) / current.scale,
        },
      };
    }
  };

  const touchMove = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !touches.has(event.pointerId)) return;
    event.preventDefault();
    lastTouchAt = performance.now();
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = gesture;
    if (!current || current.kind === "done") return;
    if (current.kind === "pinch") {
      if (touches.size < 2) return;
      const box = root?.getBoundingClientRect();
      const scale = clamp((current.scale * spread()) / current.distance, 1, MAX_ZOOM);
      const mid = midpoint();
      setZoom(
        clampZoom({
          scale,
          x: mid.x - (box?.left ?? 0) - current.content.x * scale,
          y: mid.y - (box?.top ?? 0) - current.content.y * scale,
        }),
      );
      return;
    }
    const position = { x: event.clientX, y: event.clientY };
    if (current.kind === "tap" && Math.hypot(position.x - current.start.x, position.y - current.start.y) < TAP_SLOP_PX)
      return;
    const dx = position.x - current.last.x;
    const dy = position.y - current.last.y;
    gesture = { ...current, kind: "scroll", last: position };
    drag(dx, dy, { clientX: position.x, clientY: position.y });
  };

  const touchUp = (event: PointerEvent, cancelled: boolean) => {
    if (event.pointerType !== "touch" || !touches.has(event.pointerId)) return;
    event.preventDefault();
    lastTouchAt = performance.now();
    touches.delete(event.pointerId);
    const current = gesture;
    if (touches.size > 0) {
      // A pinch that loses a finger ends: the other finger does not start a scroll.
      if (current?.kind === "pinch") gesture = { kind: "done" };
      return;
    }
    gesture = null;
    if (cancelled || current?.kind !== "tap") return;
    tap({ clientX: event.clientX, clientY: event.clientY });
    // The tap is a user gesture, so the keyboard the user opened stays up for a field they tapped.
    if (keyboard()) keys?.focus({ preventScroll: true });
  };

  /**
   * Ask the host for its selection, and write it to the user's clipboard when it comes. The host's
   * clipboard is not the user's, so the text has to come back here. A copy already waiting is the
   * same copy: the Edit menu fires one after the key press that started it. A cut deletes the text
   * on the host only once it is on the clipboard, so a write that fails loses nothing.
   */
  const copy = (cut: boolean) => {
    if (pendingCopy) return;
    let failure: "empty" | "tooLarge" | undefined;
    let copied = "";
    const answer = new Promise<CopyAnswer>((resolve) => {
      pendingCopy = resolve;
    });
    const text = answer.then((reply) => {
      if (reply === "tooLarge" || !reply?.text) {
        failure = reply === "tooLarge" ? "tooLarge" : "empty";
        throw new Error("The host sent no text to copy.");
      }
      copied = reply.text;
      return new Blob([reply.text], { type: "text/plain" });
    });
    send({ type: "copy" });
    // Nothing selected leaves the clipboard as it was, as a copy of nothing does.
    void writeClipboard(text).then(
      () => {
        if (cut) send({ type: "cut", text: copied });
      },
      (error) => {
        if (failure === "tooLarge") toast.error(t("browser.liveView.copyTooLarge"));
        else if (failure !== "empty") toast.error(t("browser.liveView.copyFailed"), { error });
      },
    );
  };

  const key = (event: KeyboardEvent, action: "down" | "up") => {
    const letter = clipboardLetter(event);
    // A paste stays with this window, which fires its own paste event with the user's clipboard. The
    // key still goes to the page, as every other key does: a terminal reads Ctrl+C as an interrupt.
    if (letter !== "v" || !props.clipboard) event.preventDefault();
    send({ type: "key", action, key: event.key, code: event.code, modifiers: modifiers(event) });
    if (action === "down" && letter) {
      if (!props.clipboard)
        toast.error(t("browser.liveView.clipboardUnsupported"), { id: CLIPBOARD_UNSUPPORTED_TOAST });
      else if (letter !== "v") copy(letter === "x");
    }
    // A printable key is two events on the wire: the key itself, and the character it produces.
    if (action === "down" && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      send({ type: "key", action: "char", key: event.key, code: event.code, text: event.key });
    }
  };

  /** One key press, down and up, for a key the on-screen keyboard names. */
  const pressKey = (name: string, code = name, modifierBits = 0) => {
    if (!frame()) return;
    send({ type: "key", action: "down", key: name, code, modifiers: modifierBits });
    send({ type: "key", action: "up", key: name, code, modifiers: modifierBits });
  };

  /**
   * Text from the on-screen keyboard: each character is a key press with its character, as a typed
   * key is. A line break is Enter. A character outside one UTF-16 unit still goes as one character.
   */
  const typeText = (text: string) => {
    if (!frame()) return;
    for (const character of text) {
      const named = NAMED_KEY_CODES[character];
      if (named) {
        pressKey(named);
        continue;
      }
      send({ type: "key", action: "down", key: character, code: "" });
      send({ type: "key", action: "char", key: character, code: "", text: character });
      send({ type: "key", action: "up", key: character, code: "" });
    }
  };

  /** Backspace that the key event already sent, so the input event of the same press does not send it again. */
  let keyDeleted = false;
  const keysDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    // A hardware keyboard on a tablet: shortcuts go to the page as on a computer.
    if ((event.ctrlKey || event.metaKey) && event.key.length === 1) {
      if (clipboardLetter(event) === "v" && props.clipboard) return;
      event.preventDefault();
      pressKey(event.key, event.code, modifiers(event));
      return;
    }
    if (!NAMED_KEYS.has(event.key)) return;
    event.preventDefault();
    keyDeleted = event.key === "Backspace" || event.key === "Delete";
    pressKey(event.key, event.code || event.key, modifiers(event));
  };
  const keysInput = (event: InputEvent) => {
    const element = keys;
    if (event.isComposing || !element) return;
    const value = element.value;
    element.value = "";
    if (value) {
      typeText(value);
      return;
    }
    // A keyboard that gives no key for Backspace still deletes, and says so in the input event.
    if (event.inputType === "deleteContentBackward" && !keyDeleted) pressKey("Backspace");
    if (event.inputType === "deleteContentForward" && !keyDeleted) pressKey("Delete");
    keyDeleted = false;
  };
  const keysCompositionEnd = () => {
    const element = keys;
    if (!element) return;
    const value = element.value;
    element.value = "";
    if (value) typeText(value);
  };

  const paste = (event: ClipboardEvent) => {
    event.preventDefault();
    if (!props.clipboard) {
      toast.error(t("browser.liveView.clipboardUnsupported"), { id: CLIPBOARD_UNSUPPORTED_TOAST });
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    if (text.length > BROWSER_LIVE_VIEW_MAX_PASTE_TEXT) {
      toast.error(t("browser.liveView.pasteTooLong"));
      return;
    }
    send({ type: "paste", text });
  };

  // Copy or Cut from the Edit menu. The event is not cancelled: a cancelled copy with no data would
  // empty the clipboard before the host's answer arrives.
  const menuCopy = (cut: boolean) => {
    if (props.clipboard) copy(cut);
    else toast.error(t("browser.liveView.clipboardUnsupported"), { id: CLIPBOARD_UNSUPPORTED_TOAST });
  };

  /**
   * Chromium sends a clipboard event to the node of the text selection, not to the focused element.
   * A click on the canvas leaves the selection where it was, such as in the chat input, so a paste
   * would go there, or nowhere. While the canvas or the keyboard field has the focus, the event is
   * the page's wherever it was sent.
   */
  createEffect(
    () => canvas(),
    (element) => {
      if (!element) return;
      const document = element.ownerDocument;
      const clipboardEvent = (event: ClipboardEvent) => {
        const focused = document.activeElement;
        const ours = event.target === element || focused === element || (keys !== undefined && focused === keys);
        if (!ours) return;
        event.stopImmediatePropagation();
        if (event.type === "paste") paste(event);
        else menuCopy(event.type === "cut");
      };
      for (const type of CLIPBOARD_EVENTS) document.addEventListener(type, clipboardEvent, true);
      return () => {
        for (const type of CLIPBOARD_EVENTS) document.removeEventListener(type, clipboardEvent, true);
      };
    },
  );

  const zoomStyle = () => {
    const current = zoom();
    return current.scale === 1
      ? undefined
      : { transform: `translate(${current.x}px, ${current.y}px) scale(${current.scale})` };
  };

  return (
    <div
      class="browser-live-view"
      ref={root}
      data-touch={touch() ? "" : undefined}
      data-fit={props.fitPage ? "" : undefined}
      data-locked={props.locked ? "" : undefined}
    >
      <canvas
        ref={setCanvas}
        tabindex="0"
        role="img"
        aria-label={t("browser.liveView.label")}
        hidden={!state.live}
        style={zoomStyle()}
        onPointerDown={touchDown}
        onPointerMove={touchMove}
        onPointerUp={(event) => touchUp(event, false)}
        onPointerCancel={(event) => touchUp(event, true)}
        onMouseMove={(event) => pointer(event, "move")}
        onMouseDown={(event) => {
          if (fromTouch()) return;
          canvas()?.focus();
          pointer(event, "down");
        }}
        onMouseUp={(event) => pointer(event, "up")}
        onContextMenu={(event) => event.preventDefault()}
        onWheel={(event) => {
          const at = point(event);
          if (!at) return;
          send({
            type: "pointer",
            action: "wheel",
            ...at,
            button: "left",
            // CDP reads a wheel delta the way the DOM event carries it: down is positive.
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            modifiers: modifiers(event),
          });
        }}
        onKeyDown={(event) => key(event, "down")}
        onKeyUp={(event) => key(event, "up")}
      />
      <Show when={!state.live}>
        <div class="browser-empty-state">
          <span>{state.message ?? t("browser.liveView.connecting")}</span>
          <ErrorReference reference={state.reference} />
        </div>
      </Show>
      <Show when={state.live && props.locked}>
        <div class="browser-live-view-lock" role="status">
          <span>{t("browser.liveView.agentUsing")}</span>
          <Show when={props.onTakeOver}>
            {(takeOver) => (
              <Button variant="secondary" size="xs" onClick={() => takeOver()()}>
                {t("island.action.takeOver")}
              </Button>
            )}
          </Show>
        </div>
      </Show>
      <Show when={state.live && state.notice}>
        {(notice) => (
          <div class="browser-live-view-notice" role="status">
            {notice()}
          </div>
        )}
      </Show>
      {/* The phone raises its keyboard for a focused text field, so the keys come through one. */}
      <Input
        ref={(element: HTMLInputElement) => {
          keys = element;
        }}
        class="browser-live-view-keys"
        type="text"
        aria-label={t("browser.liveView.keyboardInput")}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
        enterkeyhint="enter"
        data-cuelume-type={undefined}
        onKeyDown={keysDown}
        onInput={keysInput}
        onCompositionEnd={keysCompositionEnd}
        onFocus={() => setKeyboard(true)}
        onBlur={() => setKeyboard(false)}
      />
      <Show when={touch() && state.live}>
        <div class="browser-live-view-controls">
          <Show when={zoom().scale > 1}>
            <IconButton
              variant="secondary"
              label={t("browser.liveView.fit")}
              onClick={() => setZoom({ scale: 1, x: 0, y: 0 })}
            >
              <Scan aria-hidden="true" />
            </IconButton>
          </Show>
          <IconButton
            variant={keyboard() ? "default" : "secondary"}
            label={t("browser.liveView.keyboard")}
            aria-pressed={keyboard() ? "true" : "false"}
            // The field must take the focus in the press itself, or the phone keeps its keyboard down.
            onPointerDown={(event: PointerEvent) => {
              if (event.pointerType === "touch") event.preventDefault();
            }}
            onClick={() => {
              if (keyboard()) keys?.blur();
              else keys?.focus({ preventScroll: true });
            }}
          >
            <Keyboard aria-hidden="true" />
          </IconButton>
        </div>
      </Show>
    </div>
  );
}

const CLIPBOARD_EVENTS = ["paste", "copy", "cut"] as const;
// One toast for a key press and the Edit menu event that follows it.
const CLIPBOARD_UNSUPPORTED_TOAST = "browser-live-view-clipboard-unsupported";

/** The host's answer to a copy: its text, a selection too long to send, or no answer at all. */
type CopyAnswer = { text: string } | "tooLarge" | null;

/**
 * Ctrl or Cmd with C, V or X. On a layout whose letters are not Latin, such as Russian, the key is
 * the letter of that layout, so the place of the key decides.
 */
function clipboardLetter(event: KeyboardEvent): "c" | "v" | "x" | undefined {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return undefined;
  const letter = /^[a-z]$/iu.test(event.key)
    ? event.key.toLowerCase()
    : /^Key[A-Z]$/u.test(event.code)
      ? event.code.slice(3).toLowerCase()
      : "";
  return letter === "c" || letter === "v" || letter === "x" ? letter : undefined;
}

/**
 * Write text that is still on its way. A `ClipboardItem` made in the key press keeps that press's
 * permission while the host answers; Safari allows no later write. Without one, the text is written
 * when it arrives.
 */
function writeClipboard(text: Promise<Blob>): Promise<void> {
  if (typeof ClipboardItem !== "undefined")
    return navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
  return text.then((blob) => blob.text()).then((value) => navigator.clipboard.writeText(value));
}

function modifiers(event: MouseEvent | KeyboardEvent): number {
  return (
    (event.altKey ? ALT : 0) + (event.ctrlKey ? CONTROL : 0) + (event.metaKey ? META : 0) + (event.shiftKey ? SHIFT : 0)
  );
}
