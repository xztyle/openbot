/*
 * Insights: the goals, money, agent costs and daily briefing of the host, for its owner and admins.
 * The view reads one report from the host and sends each change as one action; the host answers
 * with the new report. The alerts of the report also show in Needs you (`workspace-insight-alerts`).
 */
import type {
  InsightBriefingSettings,
  InsightGoalDraft,
  InsightMoneyDraft,
  WorkspaceInsight,
  WorkspaceInsightAction,
} from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { type InsightTab, InsightView } from "@openbot/ui/features/workspace/InsightView";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { setInsightAlerts } from "./workspace-insight-alerts";
import { memberById } from "./workspace-model";

const TAB_KEY = "openbot:insight-tab";
const TABS: readonly InsightTab[] = ["goals", "money", "costs", "briefing"];

function savedTab(): InsightTab {
  try {
    const value = window.localStorage.getItem(TAB_KEY);
    return TABS.find((tab) => tab === value) ?? "goals";
  } catch {
    return "goals";
  }
}

/** The reader's own zone, for the days of the report and the briefing's zone until one is saved. */
function readerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function WorkspaceInsightView() {
  const { t, errorMessage, format } = useText();
  const ws = useWorkspace();
  const agent = () => ws.channels.port().agent;
  const [tab, setTab] = createSignal<InsightTab>(savedTab());
  const [days, setDays] = createSignal(7);
  const [report, setReport] = createSignal<WorkspaceInsight | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  function show(next: WorkspaceInsight) {
    setReport(next);
    setInsightAlerts(next.alerts);
  }

  async function refresh() {
    const read = agent().workspaceInsight;
    if (!read) {
      setLoadError(t("error.team.workspaceUnsupported"));
      return;
    }
    try {
      show(await read({ days: days(), timeZone: readerZone(), language: format.locale }));
      setLoadError(null);
    } catch (error) {
      if (report() === null) setLoadError(errorMessage(error, t("insight.loadFailed")));
      else toast.error(t("insight.loadFailed"));
    }
  }
  onSettled(() => void refresh());
  // The numbers move while agents work: read again every two minutes while the view shows.
  const timer = setInterval(() => void refresh(), 120_000);
  onCleanup(() => clearInterval(timer));

  /** Sends one change; the host answers with the new report. A failure is thrown on to the form. */
  async function act(action: WorkspaceInsightAction, done?: string) {
    const send = agent().workspaceInsightAction;
    if (!send) throw new Error(t("error.team.workspaceUnsupported"));
    show(await send(action));
    if (done) toast.success(done);
  }
  /** A change from a row button: the failure shows as a toast. */
  async function quick(action: WorkspaceInsightAction, done?: string) {
    try {
      await act(action, done);
    } catch (error) {
      toast.error(errorMessage(error, t("insight.failed")));
      throw error;
    }
  }

  const spaces = createMemo(() => ws.spaces.list().map((space) => ({ id: space.id, name: space.name })));

  return (
    <InsightView
      tab={tab()}
      onTabChange={(next) => {
        setTab(next);
        try {
          window.localStorage.setItem(TAB_KEY, next);
        } catch {
          // Private mode: the tab is not remembered.
        }
      }}
      report={report()}
      loadError={loadError()}
      onRetry={() => {
        setLoadError(null);
        void refresh();
      }}
      days={days()}
      onDaysChange={(next) => {
        setDays(next);
        void refresh();
      }}
      spaces={spaces()}
      member={(agentId) => memberById(ws.directory(), agentId)}
      onSaveGoal={(goal: InsightGoalDraft) => act({ kind: "goal-save", goal }, t("insight.saved"))}
      onRemoveGoal={(goalId) => quick({ kind: "goal-remove", goalId })}
      onSetProgress={(goalId, value) => quick({ kind: "goal-progress", goalId, value })}
      onAddMoney={(entry: InsightMoneyDraft) => act({ kind: "money-add", entry })}
      onRemoveMoney={(entryId) => quick({ kind: "money-remove", entryId })}
      onSync={() => quick({ kind: "money-sync" })}
      onDismissAlert={(alertId) => void quick({ kind: "alert-dismiss", alertId }).catch(() => undefined)}
      onSaveBriefing={(settings: InsightBriefingSettings) =>
        act({ kind: "briefing-save", settings }, t("insight.saved"))
      }
      onSendBriefing={() => quick({ kind: "briefing-send" })}
      onOpenChannel={(channelId) => ws.openChannel(channelId)}
      onBack={() => ws.back()}
    />
  );
}
