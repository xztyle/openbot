/*
 * Today, the owner's home on a phone and a computer: the decision queue of the space that shows with
 * one-tap answers, the agents that work now with Stop, and the briefing as cards (spend, goals, what
 * the agents made). A new workspace also gets a short guide to goals, loops, the briefing and costs.
 */
import { GENERAL_SPACE_ID } from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { type TodayStep, TodayView, type TodayWorker } from "@openbot/ui/features/workspace/TodayView";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, onSettled } from "solid-js";
import { openArtifact } from "./workspace-artifact-open";
import { useWorkspace } from "./workspace-context";
import { useDecisionQueue } from "./workspace-decisions";
import { createWorkspaceFileViewer } from "./workspace-file-viewer";
import { openInsightTab, useInsightReport } from "./workspace-insight-report";

type Workspace = ReturnType<typeof useWorkspace>;

/** Remembers a step of the first-run guide that is done by visiting a place. */
function guideKey(ws: Workspace, name: string) {
  return `openbot:today-guide:${ws.env.storageKey()}:${name}`;
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Private mode: the guide forgets it.
  }
}

/** The agents that work now, from every space, with Stop where the host says what runs. */
export function useWorkingAgents(ws: Workspace) {
  const { t, errorMessage } = useText();
  const [stopping, setStopping] = createSignal<ReadonlySet<string>>(new Set());
  async function stop(agentId: string, name: string, channelId: string, taskId: string) {
    if (stopping().has(agentId)) return;
    setStopping((current) => new Set([...current, agentId]));
    const release = () => setStopping((current) => new Set([...current].filter((id) => id !== agentId)));
    // A host that never reports the end leaves Stop pressable again.
    setTimeout(release, 8_000);
    try {
      await ws.channels.port().agent.channelCommand({
        type: "stop",
        operationId: crypto.randomUUID(),
        channelId,
        taskId,
        recipientAgentId: null,
      });
      ws.fleet.refresh?.();
    } catch (error) {
      release();
      toast.error(errorMessage(error, t("workspace.typing.stopFailed", { name })));
    }
  }
  return createMemo((): TodayWorker[] =>
    ws.fleet
      .agents()
      .filter((agent) => agent.status.state === "working" && agent.status.queued === undefined)
      .map((agent) => {
        const status = agent.status;
        const channelName = status.state === "working" ? status.channelName : undefined;
        const spaceId = ws.spaces.agentSpace(agent.member.id);
        const space = ws.spaces.available() && spaceId ? ws.spaces.space(spaceId)?.name : undefined;
        const run = agent.run;
        const channelId = run?.channelId;
        const taskId = run?.taskId;
        return {
          member: agent.member,
          task: agent.currentStep || (status.state === "working" ? status.task : ""),
          where: [space, channelName ? `#${channelName}` : undefined].filter(Boolean).join(" · ") || undefined,
          startedAt: run?.startedAt,
          todayCostUsd: agent.todayCostUsd,
          onStop:
            channelId && taskId && ws.env.connectionReady()
              ? () => void stop(agent.member.id, agent.member.name, channelId, taskId)
              : undefined,
          stopping: stopping().has(agent.member.id),
          onOpen: () => (channelId ? ws.openChannel(channelId) : ws.openAgent(agent.member.id)),
        };
      }),
  );
}

export function WorkspaceTodayView(props: { actions?: JSX.Element; onBack?: (() => void) | undefined }) {
  const { t } = useText();
  const ws = useWorkspace();
  const queue = useDecisionQueue();
  const working = useWorkingAgents(ws);
  const insight = useInsightReport(ws, () => 7);
  const files = createWorkspaceFileViewer();
  onSettled(() => ws.artifacts.refresh?.());
  const shipped = createMemo(() =>
    ws.artifacts
      .artifacts()
      .filter((artifact) => artifact.createdAt !== undefined)
      .slice()
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
      .slice(0, 4)
      .map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        agent: artifact.agent,
        at: artifact.createdAt ?? 0,
        onOpen: () => openArtifact(ws, artifact.id, undefined, files.view),
      })),
  );
  const todayCost = createMemo(() => ws.fleet.agents().reduce((sum, agent) => sum + (agent.todayCostUsd ?? 0), 0));
  const insights = () => ws.viewAvailable("insights");

  // The first-run guide, for the owner and the admins until each step is done or they hide it. The
  // flags are read in the memo: the storage key names the host, which can arrive after Today mounts.
  const [hiddenNow, setHiddenNow] = createSignal(false);
  const [visits, setVisits] = createSignal(0);
  const visit = (name: string, open: () => void) => {
    writeFlag(guideKey(ws, name));
    setVisits((count) => count + 1);
    open();
  };
  const steps = createMemo((): TodayStep[] => {
    visits();
    // Until the host lists its channels the steps would read as undone, as on a host that did not answer.
    if (hiddenNow() || readFlag(guideKey(ws, "hidden")) || !ws.isAdmin() || !ws.channels.state.listed) return [];
    const report = insight.report();
    const chief = ws.spaceAgents()[0] ?? ws.env.agents()[0];
    const createAgent = ws.env.createAgent;
    // #general lives in General: in another space the step makes a channel of that space instead.
    const otherSpace = ws.spaces.available() && ws.spaces.current() !== GENERAL_SPACE_ID;
    const list: TodayStep[] = [
      // A new space, or a new workspace, has no agent to give a goal or a channel to yet.
      ...(createAgent && ws.spaceAgents().length === 0
        ? [
            {
              id: "agent",
              title: t("workspace.fleet.addAgent"),
              hint: t("workspace.fleet.noAgentsHint"),
              done: false,
              onSelect: () => createAgent(),
            },
          ]
        : []),
      {
        id: "goal",
        title: t("workspace.today.guide.goal"),
        hint: t("workspace.today.guide.goalHint"),
        done: (report?.goals.length ?? 0) > 0,
        onSelect: () =>
          insights() ? openInsightTab(ws, "goals") : chief ? ws.openAgent(chief.id) : ws.openView("fleet"),
      },
      {
        id: "channel",
        title: otherSpace ? t("workspace.app.welcome.createChannel") : t("workspace.today.guide.channel"),
        hint: t("workspace.today.guide.channelHint"),
        done: ws.sidebarChannels().length > 0,
        // #general with the whole team and its agents, as the welcome's button makes it.
        onSelect: () => (otherSpace ? ws.openDialog({ kind: "create-channel" }) : void ws.ensureGeneral()),
      },
      ...(insights()
        ? [
            {
              id: "briefing",
              title: t("workspace.today.guide.briefing"),
              hint: t("workspace.today.guide.briefingHint"),
              done: Boolean(report?.briefing.lastSentAt) || readFlag(guideKey(ws, "briefing")),
              onSelect: () => visit("briefing", () => openInsightTab(ws, "briefing")),
            },
          ]
        : []),
      ...(ws.viewAvailable("loops")
        ? [
            {
              id: "loop",
              title: t("workspace.today.guide.loop"),
              hint: t("workspace.today.guide.loopHint"),
              done: readFlag(guideKey(ws, "loop")),
              onSelect: () => visit("loop", () => ws.openView("loops")),
            },
          ]
        : []),
      ...(ws.viewAvailable("money")
        ? [
            {
              id: "money",
              title: t("workspace.today.guide.money"),
              hint: t("workspace.today.guide.moneyHint"),
              done: readFlag(guideKey(ws, "money")),
              onSelect: () => visit("money", () => ws.openView("money")),
            },
          ]
        : []),
    ];
    return list.every((step) => step.done) ? [] : list;
  });
  const firstName = () => {
    const name = ws.env.reader().name.trim();
    return name.split(/\s+/u)[0] || name;
  };

  return (
    <>
      <TodayView
        name={firstName()}
        decisions={queue.here()}
        working={working()}
        report={insight.report()}
        shipped={shipped()}
        todayCostUsd={todayCost()}
        steps={steps()}
        onHideSteps={() => {
          writeFlag(guideKey(ws, "hidden"));
          setHiddenNow(true);
        }}
        onOpenMoney={ws.viewAvailable("money") ? () => ws.openView("money") : undefined}
        onOpenGoals={insights() ? () => openInsightTab(ws, "goals") : undefined}
        onOpenBriefing={insights() ? () => openInsightTab(ws, "briefing") : undefined}
        onOpenShipped={() => ws.openView("artifacts")}
        onAsk={() => ws.openDialog({ kind: "switcher" })}
        actions={props.actions}
        onBack={props.onBack}
      />
      <files.Viewer />
    </>
  );
}
