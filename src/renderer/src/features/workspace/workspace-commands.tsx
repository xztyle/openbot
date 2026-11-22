/*
 * The actions of the command bar (⌘K / Ctrl+K, and the phone's Jump to): it does things, not only
 * opens them. "ask Research compare the prices" sends the rest of the line to Research; "approve"
 * lists what waits for the owner's OK; "stop" lists the agents at work; "goal" opens a new goal. A
 * sentence that matches nothing goes to the space's lead agent as a task.
 */
import { toast } from "@openbot/ui";
import type { TodayDecision } from "@openbot/ui/features/workspace/TodayView";
import { useText } from "@openbot/ui/text";
import { useWorkingAgents } from "./WorkspaceToday";
import { APPROVE, askTarget, fold, GOAL, STOP } from "./workspace-command-text";
import { useWorkspace } from "./workspace-context";
import { useDecisionQueue } from "./workspace-decisions";
import { openInsightTab } from "./workspace-insight-report";
import { memberById } from "./workspace-model";

/** One action of the command bar. */
export interface CommandAction {
  id: string;
  label: string;
  /** What Enter does, in a few words: "send", "approve". */
  hint: string;
  kind: "ask" | "approve" | "decline" | "stop" | "goal" | "today";
  agentId?: string | undefined;
  run: () => void;
}

/** The actions of the command bar for what the reader typed. */
export function useCommandActions() {
  const ws = useWorkspace();
  const { t, errorMessage } = useText();
  const queue = useDecisionQueue();
  const working = useWorkingAgents(ws);
  const send = ws.env.sendToAgent;
  /** The agents the reader may ask from here: their main chat is the reader's. */
  const askable = () =>
    send
      ? ws.env
          .agents()
          .filter((agent) => !ws.env.hiddenAgentIds().has(agent.id) && ws.env.agentDmIsMainChat())
          .sort((left, right) => Number(ws.spaces.agentInCurrent(right.id)) - Number(ws.spaces.agentInCurrent(left.id)))
      : [];
  const ask = (agentId: string, name: string, text: string): CommandAction => ({
    id: `ask:${agentId}:${text}`,
    label: t("workspace.command.ask", { name, text }),
    hint: t("workspace.command.hint.send"),
    kind: "ask",
    agentId,
    run: () => {
      if (!send) return;
      void send(agentId, text).then(
        () => {
          toast.success(t("workspace.command.sent", { name }));
          ws.openAgent(agentId);
        },
        (error: unknown) => toast.error(errorMessage(error, t("workspace.command.sendFailed", { name }))),
      );
    },
  });
  const decide = (decision: TodayDecision, approve: boolean): CommandAction => ({
    id: `${approve ? "approve" : "decline"}:${decision.key}`,
    label: t(approve ? "workspace.command.approve" : "workspace.command.decline", {
      action: decision.summary || decision.action,
      name: decision.member.name,
    }),
    hint: t(approve ? "workspace.command.hint.approve" : "workspace.command.hint.decline"),
    kind: approve ? "approve" : "decline",
    agentId: decision.member.id,
    run: () => {
      const action = approve ? decision.approve : decision.reject;
      if (!action) return;
      void action().then(
        () => toast.success(t("workspace.today.sent")),
        (error: unknown) => toast.error(errorMessage(error, t("workspace.today.answerFailed"))),
      );
    },
  });
  const approvals = (filter: string): CommandAction[] =>
    queue
      .queue()
      .filter(
        (decision) =>
          (decision.approve || decision.reject) &&
          (!filter || fold(`${decision.member.name} ${decision.action} ${decision.summary ?? ""}`).includes(filter)),
      )
      .flatMap((decision) => [
        ...(decision.approve ? [decide(decision, true)] : []),
        ...(decision.reject ? [decide(decision, false)] : []),
      ]);
  const stops = (filter: string): CommandAction[] =>
    working()
      .filter((worker) => worker.onStop && (!filter || fold(worker.member.name).includes(filter)))
      .map((worker) => ({
        id: `stop:${worker.member.id}`,
        label: t("workspace.command.stop", { name: worker.member.name, task: worker.task }),
        hint: t("workspace.command.hint.stop"),
        kind: "stop",
        agentId: worker.member.id,
        run: () => worker.onStop?.(),
      }));
  const goal: CommandAction = {
    id: "goal",
    label: t("workspace.command.goal"),
    hint: t("workspace.command.hint.open"),
    kind: "goal",
    run: () => openInsightTab(ws, "goals"),
  };

  /** The actions for a query, before the names that match it. */
  function actions(query: string): CommandAction[] {
    const text = query.trim();
    if (!text) {
      const waiting = queue.queue().length;
      return waiting > 0
        ? [
            {
              id: "today",
              label: t("workspace.command.waiting", { count: waiting }),
              hint: t("workspace.command.hint.open"),
              kind: "today",
              run: () => ws.openView("today"),
            },
          ]
        : [];
    }
    const lower = fold(text);
    if (APPROVE.test(lower)) return approvals(fold(text.replace(APPROVE, "").trim()));
    if (STOP.test(lower)) return stops(fold(text.replace(STOP, "").trim()));
    if (GOAL.test(lower) && ws.viewAvailable("insights")) return [goal];
    const agents = askable();
    const target = askTarget(text, agents);
    if (target?.kind === "named" && target.message) return [ask(target.agent.id, target.agent.name, target.message)];
    if (target) {
      const picks = target.kind === "named" ? [target.agent] : target.agents;
      return picks.map((agent) => ({
        id: `pick:${agent.id}`,
        label: t("workspace.command.askPick", { name: agent.name }),
        hint: t("workspace.command.hint.pick"),
        kind: "ask",
        agentId: agent.id,
        run: () => ws.openAgent(agent.id),
      }));
    }
    // A sentence that is no name: offer it to the space's lead as a task, as quick capture.
    const lead = agents[0];
    if (lead && text.split(/\s+/u).length >= 3) return [ask(lead.id, lead.name, text)];
    return [];
  }

  return { actions, member: (agentId: string) => memberById(ws.directory(), agentId) };
}
