import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebMobilePane } from "./WebMobileNavigation";
import { createWebPaneHistory } from "./web-pane-history";

function setup(initial: WebMobilePane) {
  let pane = initial;
  const setPane = vi.fn((next: WebMobilePane) => {
    pane = next;
  });
  const history = createWebPaneHistory({ pane: () => pane, setPane });
  return { history, setPane, pane: () => pane, show: (next: WebMobilePane) => (pane = next) };
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
});
