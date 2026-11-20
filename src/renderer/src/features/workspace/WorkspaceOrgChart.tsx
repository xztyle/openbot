import { agentManagers } from "@openbot/contracts/agent-org";
import { type AgentReasoningEffort, isQueuedAgentNote } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { toast } from "@openbot/ui";
import { type OrgChartAgent, type OrgChartMessage, OrgChartView } from "@openbot/ui/features/org-chart/OrgChartView";
import { useText } from "@openbot/ui/text";
import { createMemo } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { agentMember } from "./workspace-model";

const EFFORT_LABEL = {
  low: "provider.effort.low",
  medium: "provider.effort.medium",
  high: "provider.effort.high",
  xhigh: "provider.effort.xhigh",
  max: "provider.effort.max",
} as const satisfies Record<AgentReasoningEffort, AppTextKey>;

/** A message between two agents counts as new for this long after the host queued it. */
const MESSAGE_WINDOW_MS = 60_000;

/**
 * The org chart of the space that shows. The lines come from each agent's manager, else its
 * creator; the state comes from the fleet, the queues and the failed turns that the sidebar reads.
 */
export function WorkspaceOrgChart() {
  const ws = useWorkspace();
  const { t } = useText();
  const agents = createMemo((): OrgChartAgent[] => {
    const hidden = ws.env.hiddenAgentIds();
    const profiles = ws
      .spaceAgents()
      .filter((agent) => !hidden.has(agent.id))
      .sort((left, right) => left.name.localeCompare(right.name));
    const managers = agentManagers(profiles);
    const fleet = new Map(ws.fleet.agents().map((entry) => [entry.member.id, entry]));
    const runtime = ws.env.agentRuntime?.();
    return profiles.map((profile): OrgChartAgent => {
      const work = fleet.get(profile.id);
      const status = work?.status ?? { state: "idle" as const };
      const failed = status.state === "idle" && Boolean(runtime?.failedTurns[profile.id]);
      const queued = runtime?.queues[profile.id]?.deliveries.filter(
        (delivery) => delivery.status === "queued" && !isQueuedAgentNote(delivery),
      ).length;
      return {
        member: agentMember(profile, status.state === "working"),
        title: profile.title || undefined,
        managerId: managers.get(profile.id) ?? null,
        model: profile.model,
        effort: t(EFFORT_LABEL[profile.reasoningEffort]),
        state: failed ? "failed" : status.state,
        status,
        activity: work?.currentStep ?? (status.state === "working" ? status.task : undefined),
        queued: queued || undefined,
        preview: profile.preview || undefined,
        background: profile.background,
      };
    });
  });
  /** The messages that agents sent each other lately, from their queues. */
  const messages = createMemo((): OrgChartMessage[] => {
    const queues = ws.env.agentRuntime?.().queues ?? {};
    const since = Date.now() - MESSAGE_WINDOW_MS;
    return Object.values(queues).flatMap((queue) =>
      queue.deliveries.flatMap((delivery) =>
        delivery.sender.kind === "agent" && Date.parse(delivery.createdAt) >= since
          ? [{ id: delivery.id, from: delivery.sender.agentId, to: delivery.recipientAgentId }]
          : [],
      ),
    );
  });
  /** The name, and the title that tells apart two agents of one name. */
  const name = (agentId: string | null) => {
    const agent = agents().find((candidate) => candidate.member.id === agentId);
    return [agent?.member.name, agent?.title].filter(Boolean).join(" · ");
  };
  const changeManager = (agentId: string, managerId: string | null) => {
    const set = ws.env.setAgentManager;
    if (!set) return Promise.resolve();
    const before = agents().find((agent) => agent.member.id === agentId)?.managerId ?? null;
    return set(agentId, managerId).then(() => {
      // Undo instead of a second confirm: the agent goes back under its manager before the move.
      toast(
        managerId === null
          ? t("workspace.org.movedTop", { name: name(agentId) })
          : t("workspace.org.moved", { name: name(agentId), manager: name(managerId) }),
        {
          action: {
            label: t("common.undo"),
            onClick: () =>
              void set(agentId, before).catch((error: unknown) =>
                toast.error(t("workspace.org.moveFailed"), { error, fallback: t("workspace.org.moveFailed") }),
              ),
          },
        },
      );
    });
  };
  return (
    <OrgChartView
      agents={agents()}
      messages={messages()}
      onOpenChat={(agentId) => ws.openAgent(agentId)}
      onChangeManager={ws.env.setAgentManager ? changeManager : undefined}
      onBack={() => ws.back()}
    />
  );
}
