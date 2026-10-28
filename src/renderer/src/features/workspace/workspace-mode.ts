import { createSignal } from "solid-js";

/**
 * The classic agent sidebar instead of the workspace. A choice of this computer, like the sidebar
 * width: the workspace is the default, and the classic view stays one menu item away.
 */
const CLASSIC_KEY = "openbot.workspace.classic.v1";

function readClassic(): boolean {
  try {
    return window.localStorage.getItem(CLASSIC_KEY) === "true";
  } catch {
    return false;
  }
}

const [classic, setClassic] = createSignal(readClassic());

export const workspaceClassic = classic;

export function setWorkspaceClassic(value: boolean): void {
  setClassic(value);
  try {
    if (value) window.localStorage.setItem(CLASSIC_KEY, "true");
    else window.localStorage.removeItem(CLASSIC_KEY);
  } catch {
    // A private window keeps the choice for this session.
  }
}
