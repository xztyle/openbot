import { afterEach, describe, expect, it } from "vitest";
import { createScrollFollow, listenForScrollIntent, type ScrollFollow } from "./scroll-follow";

/** A scroll element with the geometry of a long transcript. `scrollTop` writes stay in the object. */
function scroller(geometry: { height: number; client: number; top: number }): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperties(element, {
    scrollHeight: { get: () => geometry.height, configurable: true },
    clientHeight: { get: () => geometry.client, configurable: true },
    scrollTop: {
      get: () => geometry.top,
      set: (value: number) => {
        geometry.top = Math.min(value, geometry.height - geometry.client);
      },
      configurable: true,
    },
  });
  return element;
}

function harness() {
  const clock = { now: 1000 };
  const frames: Array<() => void> = [];
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const stickChanges: boolean[] = [];
  const follow = createScrollFollow({
    now: () => clock.now,
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: (handle) => {
      frames[handle - 1] = () => {};
    },
    setTimer: (callback, ms) => {
      timers.push({ callback, ms, cleared: false });
      return timers.length;
    },
    clearTimer: (handle) => {
      const timer = timers[Number(handle) - 1];
      if (timer) timer.cleared = true;
    },
    onStickChange: (value) => stickChanges.push(value),
  });
  return {
    follow,
    clock,
    stickChanges,
    runFrames: () => {
      for (const frame of frames.splice(0)) frame();
    },
    runTimers: () => {
      for (const timer of timers) if (!timer.cleared) timer.callback();
    },
  };
}

/** The reader scrolls and the browser reports it. */
function readerScrollsTo(follow: ScrollFollow, element: HTMLDivElement, geometry: { top: number }, top: number) {
  geometry.top = top;
  follow.scroll(element);
}

describe("scroll follow", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  it("follows the bottom and writes nothing when it is already there", () => {
    const geometry = { height: 3000, client: 500, top: 2500 };
    const element = scroller(geometry);
    const { follow } = harness();
    expect(follow.stick()).toBe(true);
    geometry.height = 3200;
    follow.follow(element);
    expect(geometry.top).toBe(2700);
    // A second writer in the same frame has nothing to do.
    let writes = 0;
    Object.defineProperty(element, "scrollTop", {
      get: () => geometry.top,
      set: () => {
        writes += 1;
      },
      configurable: true,
    });
    follow.follow(element);
    expect(writes).toBe(0);
  });

  it("stops following at once on a wheel move up, even inside the old 80 pixel zone", () => {
    const geometry = { height: 3000, client: 500, top: 2500 };
    const element = scroller(geometry);
    const { follow, runFrames } = harness();
    follow.wheel(element, -40);
    expect(follow.stick()).toBe(false);
    // The scroll that the wheel made ends 30 pixels above the bottom: still not following.
    readerScrollsTo(follow, element, geometry, 2470);
    expect(follow.stick()).toBe(false);
    runFrames();
    expect(follow.stick()).toBe(false);
    // A streamed delta grows the transcript: no writer moves it back.
    geometry.height = 3100;
    follow.follow(element);
    expect(geometry.top).toBe(2470);
  });

  it("keeps following when a wheel move up did not move the transcript", () => {
    const geometry = { height: 3000, client: 500, top: 2500 };
    const element = scroller(geometry);
    const { follow, runFrames } = harness();
    follow.wheel(element, -40);
    expect(follow.stick()).toBe(false);
    // The wheel scrolled a code block inside a row. The transcript stayed at the bottom.
    runFrames();
    expect(follow.stick()).toBe(true);
  });

  it("does not follow after a wheel move up at the top of a short transcript", () => {
    const geometry = { height: 400, client: 500, top: 0 };
    const element = scroller(geometry);
    const { follow } = harness();
    follow.wheel(element, -40);
    expect(follow.stick()).toBe(true);
  });

  it("stops on the up keys, and only for keys that are not typed in a field", () => {
    const geometry = { height: 3000, client: 500, top: 2500 };
    const element = scroller(geometry);
    const { follow } = harness();
    follow.key(element, "ArrowDown");
    expect(follow.stick()).toBe(true);
    follow.key(element, "PageUp");
    expect(follow.stick()).toBe(false);
    follow.setStick(true);
    follow.key(element, "Home");
    expect(follow.stick()).toBe(false);
    follow.setStick(true);
    follow.key(element, " ", true);
    expect(follow.stick()).toBe(false);

    const real = createScrollFollow();
    const listened = scroller({ height: 3000, client: 500, top: 2500 });
    disposers.push(listenForScrollIntent(listened, real));
    const field = document.createElement("textarea");
    listened.append(field);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(real.stick()).toBe(true);
    listened.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(real.stick()).toBe(false);
    real.dispose();
  });

  it("stops on a touch move toward older messages", () => {
    const geometry = { height: 3000, client: 500, top: 2500 };
    const element = scroller(geometry);
    const { follow } = harness();
    follow.touchStart(300);
    // The finger moves up: newer messages. Nothing to release.
    follow.touchMove(element, 250);
    expect(follow.stick()).toBe(true);
    follow.touchMove(element, 320);
    expect(follow.stick()).toBe(false);
  });

  it("sticks again only when the reader's own scroll reaches the bottom", () => {
    const geometry = { height: 3000, client: 500, top: 2500 };
    const element = scroller(geometry);
    const { follow, clock } = harness();
    follow.wheel(element, -400);
    readerScrollsTo(follow, element, geometry, 1500);
    expect(follow.stick()).toBe(false);

    // The browser moves the transcript with no input of the reader, even to the bottom zone: no change.
    clock.now += 5000;
    readerScrollsTo(follow, element, geometry, 2450);
    expect(follow.stick()).toBe(false);

    // The reader scrolls down into the bottom zone.
    follow.wheel(element, 300);
    readerScrollsTo(follow, element, geometry, 2480);
    expect(follow.stick()).toBe(true);
  });

  it("does not release for a scroll that nobody asked for, such as the browser clamping a shrink", () => {
    const geometry = { height: 3000, client: 500, top: 2500 };
    const element = scroller(geometry);
    const { follow, clock } = harness();
    clock.now += 5000;
    geometry.height = 2700;
    readerScrollsTo(follow, element, geometry, 2200);
    expect(follow.stick()).toBe(true);
  });

  it("reads the intent again in a frame that was queued before the reader scrolled up", () => {
    const geometry = { height: 3000, client: 500, top: 2500 };
    const element = scroller(geometry);
    const { follow } = harness();
    // A delta queued a settle frame while the transcript followed.
    const queued = () => {
      if (follow.stick()) follow.follow(element);
    };
    follow.wheel(element, -40);
    readerScrollsTo(follow, element, geometry, 2470);
    geometry.height = 3200;
    queued();
    expect(geometry.top).toBe(2470);
  });

  it("keeps the stick during a smooth jump and writes nothing until it ends", () => {
    const geometry = { height: 3000, client: 500, top: 1000 };
    const element = scroller(geometry);
    const { follow, clock, runTimers } = harness();
    follow.wheel(element, -40);
    readerScrollsTo(follow, element, geometry, 900);
    expect(follow.stick()).toBe(false);
    clock.now += 100;

    follow.beginJump(element);
    expect(follow.stick()).toBe(true);
    expect(follow.jumping()).toBe(true);
    // The steps of the animation are not the reader's, and they do not release the stick.
    readerScrollsTo(follow, element, geometry, 1500);
    expect(follow.stick()).toBe(true);
    // No follower moves the page under the animation.
    geometry.height = 3400;
    follow.follow(element);
    expect(geometry.top).toBe(1500);
    // The animation ends short of the new bottom: the end of the jump follows.
    runTimers();
    expect(follow.jumping()).toBe(false);
    expect(geometry.top).toBe(2900);
  });

  it("lets the reader take over from a jump", () => {
    const geometry = { height: 3000, client: 500, top: 1000 };
    const element = scroller(geometry);
    const { follow } = harness();
    follow.beginJump(element);
    readerScrollsTo(follow, element, geometry, 1200);
    expect(follow.stick()).toBe(true);
    follow.wheel(element, -100);
    readerScrollsTo(follow, element, geometry, 1100);
    expect(follow.jumping()).toBe(false);
    expect(follow.stick()).toBe(false);
  });

  it("does not start a jump when the transcript is at the bottom", () => {
    const geometry = { height: 3000, client: 500, top: 2500 };
    const element = scroller(geometry);
    const { follow } = harness();
    follow.beginJump(element);
    expect(follow.jumping()).toBe(false);
    expect(follow.stick()).toBe(true);
  });

  it("tells the virtualizer about each change of the stick", () => {
    const geometry = { height: 3000, client: 500, top: 2500 };
    const element = scroller(geometry);
    const { follow, stickChanges } = harness();
    follow.wheel(element, -10);
    follow.wheel(element, -10);
    follow.setStick(true);
    expect(stickChanges).toEqual([false, true]);
  });
});
