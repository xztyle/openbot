import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebMobilePane } from "./WebMobileNavigation";
import { createWebPaneHistory } from "./web-pane-history";

function setup(initial: WebMobilePane) {
  let pane = initial;
  const setPane = vi.fn((next: WebMobilePane) => {
    pane = next;
  });
  const closeOverlay = vi.fn();
  const history = createWebPaneHistory({ pane: () => pane, setPane, closeOverlay });
  return { history, setPane, closeOverlay, pane: () => pane, show: (next: WebMobilePane) => (pane = next) };
}
const popped = () =>
  new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));

afterEach(() => {
  window.history.replaceState(null, "");
});

describe("web pane history", () => {
  it("makes the back button go from a chat to the list of agents", async () => {
    const app = setup("conversation");
    app.history.start();
    expect(window.history.state).toMatchObject({ openbotPane: "conversation" });
    const back = popped();
    window.history.back();
    await back;
    expect(app.setPane).toHaveBeenCalledWith("workspace");
    app.history.stop();
  });

  it("adds an entry when the user opens a chat from the list, and steps back when the user picks the list", async () => {
    const app = setup("workspace");
    app.history.start();
    app.show("conversation");
    app.history.sync("conversation");
    expect(window.history.state).toMatchObject({ openbotPane: "conversation" });
    const back = popped();
    app.show("workspace");
    app.history.sync("workspace");
    await back;
    expect(window.history.state).toMatchObject({ openbotPane: "workspace" });
    expect(app.setPane).not.toHaveBeenCalled();
    app.history.stop();
  });

  it("keeps the pane of a reloaded entry", () => {
    window.history.replaceState({ openbotPane: "workspace" }, "");
    const app = setup("conversation");
    app.history.start();
    expect(app.setPane).toHaveBeenCalledWith("workspace");
    app.history.stop();
  });

  it("closes an overlay with the back button and stays on the pane", async () => {
    const app = setup("conversation");
    app.history.start();
    app.history.syncOverlay(true);
    expect(window.history.state).toMatchObject({ openbotPane: "conversation", openbotOverlay: true });
    const back = popped();
    window.history.back();
    await back;
    expect(app.closeOverlay).toHaveBeenCalledOnce();
    expect(app.setPane).not.toHaveBeenCalled();
    expect(window.history.state).toMatchObject({ openbotPane: "conversation" });
    expect(window.history.state).not.toMatchObject({ openbotOverlay: true });
    app.history.stop();
  });

  it("removes the entry of an overlay that the user closes in the page", async () => {
    const app = setup("conversation");
    app.history.start();
    app.history.syncOverlay(true);
    const back = popped();
    app.history.syncOverlay(false);
    await back;
    expect(app.closeOverlay).not.toHaveBeenCalled();
    expect(window.history.state).not.toMatchObject({ openbotOverlay: true });
    app.history.stop();
  });

  it("steps over the entry of an overlay that a pane change left under the pane", async () => {
    const app = setup("workspace");
    app.history.start();
    app.history.syncOverlay(true);
    // A search result opens a chat and closes the search in the same step.
    app.show("conversation");
    app.history.sync("conversation");
    app.history.syncOverlay(false);
    expect(window.history.state).toMatchObject({ openbotPane: "conversation" });
    expect(window.history.state).not.toMatchObject({ openbotOverlay: true });
    window.history.back();
    await vi.waitFor(() => expect(window.history.state).toMatchObject({ openbotPane: "workspace" }));
    expect(window.history.state).not.toMatchObject({ openbotOverlay: true });
    expect(app.setPane).toHaveBeenCalledWith("workspace");
    expect(app.closeOverlay).not.toHaveBeenCalled();
    app.history.stop();
  });
});
