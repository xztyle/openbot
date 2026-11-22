/*
 * The insight report for the views that show its numbers outside Insights (Today and Money), and the
 * link that opens Insights on one of its tabs.
 */
import type { WorkspaceInsight } from "@openbot/contracts/ipc";
import type { InsightTab } from "@openbot/ui/features/workspace/InsightView";
import { useText } from "@openbot/ui/text";
import { createSignal, onCleanup, untrack } from "solid-js";
import type { useWorkspace } from "./workspace-context";
import { refreshOnReturn } from "./workspace-host-feeds";

type Workspace = ReturnType<typeof useWorkspace>;

/** The reader's own zone, for the days of a report. */
function readerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The insight report of the last `days` days while the caller lives, read again every two minutes and
 * when the reader comes back to the host; null for a reader who may not see it or a host without it.
 */
export function useInsightReport(ws: Workspace, days: () => number) {
  const { format } = useText();
  const [report, setReport] = createSignal<WorkspaceInsight | null>(null);
  const [failed, setFailed] = createSignal(false);
  async function refresh() {
    const read = ws.channels.port().agent.workspaceInsight;
    if (!read || !ws.viewAvailable("insights")) return;
    try {
      setReport(await read({ days: days(), timeZone: readerZone(), language: format.locale }));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }
  // The host says the reader's role only after it connects: the first read waits for it.
  refreshOnReturn(
    ws,
    () => Boolean(ws.channels.port().agent.workspaceInsight) && ws.viewAvailable("insights"),
    () => void untrack(refresh),
  );
  // Only while the page shows: a hidden page has nobody to read it, and coming back reads it at once.
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, 120_000);
  onCleanup(() => clearInterval(timer));
  return { report, failed, refresh };
}

/** Opens Insights on one of its tabs: the view starts on the tab it saved last. */
export function openInsightTab(ws: Workspace, tab: InsightTab): void {
  try {
    window.localStorage.setItem("openbot:insight-tab", tab);
  } catch {
    // Private mode: Insights opens on its first tab.
  }
  ws.openView("insights");
}
