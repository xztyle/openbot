// The Loops view on a real loop service, for `scripts/loops-ui-e2e.ts`: the script serves the page and
// answers `/loops/board` and `/loops/action` with `LoopService` on a fresh database, so what the page
// shows is what the host stores. `?read-only` shows it to a member who may not edit. `window.harness`
// reloads the board (as the view's timer does) and opens a decision, as a link from Today does.
import {
  decodeWorkspaceLoops,
  type WorkspaceLoopAction,
  type WorkspaceLoopActionResult,
  type WorkspaceLoops,
} from "@openbot/contracts/ipc";
import { LoopsView } from "@openbot/ui/features/workspace/LoopsView";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { StaticI18nProvider } from "../src/i18n-context";
import { AGENTS } from "./workspace/workspace-fixtures";
import "../src/styles.css";

declare global {
  interface Window {
    harness?: { reload(): Promise<void>; open(loopId: string, decisionId: string): void };
  }
}

const params = new URLSearchParams(location.search);
document.documentElement.dataset.atelierTheme = params.get("theme") ?? "craft";
document.documentElement.dataset.openbotColorScheme = params.get("scheme") ?? "dark";

/** One call to the loop host of the script: the board it answers, or its refusal as an error. */
async function post(path: string, body: unknown): Promise<WorkspaceLoopActionResult> {
  const response = await fetch(path, { method: "POST", body: JSON.stringify(body) });
  const text = await response.text();
  const refused = /^\{"error":(".*")\}$/su.exec(text)?.[1];
  if (refused) throw new Error(JSON.parse(refused));
  return decodeWorkspaceLoops(JSON.parse(text));
}

const [board, setBoard] = createSignal<WorkspaceLoops | null>(null);
const [focus, setFocus] = createSignal<{ loopId: string; decisionId: string } | null>(null);
const reload = async () => {
  setBoard(await post("/loops/board", { spaceId: "uo" }));
};
window.harness = { reload, open: (loopId, decisionId) => setFocus({ loopId, decisionId }) };
void reload();

render(
  () => (
    <StaticI18nProvider locale="en">
      <div style={{ height: "100vh", display: "flex", "flex-direction": "column" }}>
        <LoopsView
          board={board()}
          agents={AGENTS}
          canEdit={!params.has("read-only")}
          initialLoopId={focus()?.loopId}
          focusDecisionId={focus()?.decisionId}
          onAction={async (action: WorkspaceLoopAction) => {
            const result = await post("/loops/action", action);
            setBoard(result);
            return result;
          }}
        />
      </div>
    </StaticI18nProvider>
  ),
  document.getElementById("root") ?? document.body,
);
