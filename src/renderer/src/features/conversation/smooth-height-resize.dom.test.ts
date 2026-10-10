import { createSmoothHeightResize } from "@openbot/ui/features/conversation/createSmoothHeightResize";
import { createRoot, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("smooth height resize", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the computed style of the root once for each resize", () => {
    let notify: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
    const container = document.createElement("div");
    const content = document.createElement("div");
    document.body.append(container);
    container.append(content);
    let height = 100;
    vi.spyOn(content, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 100, height));
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel() {} }));
    Object.defineProperty(container, "animate", { value: animate, configurable: true });
    const dispose = createRoot((disposeRoot) => {
      createSmoothHeightResize({ container: () => container, content: () => content });
      return disposeRoot;
    });
    flush();
    expect(notify).toBeDefined();
    // The first observation only records the height.
    notify?.();
    const read = vi.spyOn(window, "getComputedStyle");
    height = 160;
    notify?.();
    const rootReads = read.mock.calls.filter(([element]) => element === document.documentElement);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(rootReads).toHaveLength(1);
    expect(animate.mock.calls[0]).toEqual([
      [{ height: "100px" }, { height: "160px" }],
      { duration: 240, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
    ]);
    dispose();
    vi.unstubAllGlobals();
    container.remove();
  });
});
