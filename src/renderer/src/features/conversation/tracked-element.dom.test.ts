import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createTrackedElement } from "./tracked-element";

describe("tracked element", () => {
  it("reads as none before an element is set and after the page drops it", () => {
    const tracked = createTrackedElement<HTMLDivElement>();
    expect(tracked.get()).toBeUndefined();
    const element = document.createElement("div");
    tracked.set(element);
    // A detached element is not in the page.
    expect(tracked.get()).toBeUndefined();
    document.body.append(element);
    expect(tracked.get()).toBe(element);
    element.remove();
    expect(tracked.get()).toBeUndefined();
  });

  it("forgets the element when the owner that set it ends", () => {
    const tracked = createTrackedElement<HTMLDivElement>();
    const element = document.createElement("div");
    document.body.append(element);
    const dispose = createRoot((disposeRoot) => {
      tracked.set(element);
      return disposeRoot;
    });
    expect(tracked.get()).toBe(element);
    dispose();
    expect(tracked.get()).toBeUndefined();
    element.remove();
  });

  it("keeps a newer element when the owner of an older one ends", () => {
    const tracked = createTrackedElement<HTMLDivElement>();
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);
    const disposeFirst = createRoot((disposeRoot) => {
      tracked.set(first);
      return disposeRoot;
    });
    const disposeSecond = createRoot((disposeRoot) => {
      tracked.set(second);
      return disposeRoot;
    });
    disposeFirst();
    expect(tracked.get()).toBe(second);
    disposeSecond();
    expect(tracked.get()).toBeUndefined();
    first.remove();
    second.remove();
  });
});
