import { providerDisplayName } from "@openbot/contracts/agent-providers";
import { SpaceAgentsView } from "@openbot/ui/features/spaces/SpaceAgentsView";
import { createMemo } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { agentMember } from "./workspace-model";

/** The Agents view of the space that shows: every agent of it, to open, move or delete. */
export function WorkspaceSpaceAgentsView() {
  const ws = useWorkspace();
  const rows = createMemo(() =>
    ws.spaceAgents().map((agent) => {
      const at = agent.updatedAt ? Date.parse(agent.updatedAt) : Number.NaN;
      return {
        member: agentMember(agent, ws.directory().agentStates[agent.id]?.kind === "working"),
        title: agent.title,
        model: `${providerDisplayName(agent.provider)} · ${agent.model}`,
        lastActivityAt: Number.isFinite(at) ? at : null,
      };
    }),
  );
  const deleteAgent = ws.env.deleteAgent;
  return (
    <SpaceAgentsView
      spaceName={ws.spaces.space(ws.spaces.current())?.name ?? ""}
      agents={rows()}
      onOpenChat={(agentId) => ws.openAgent(agentId)}
      onMove={
        ws.isAdmin() && ws.spaces.available()
          ? (agentIds) => ws.openDialog({ kind: "space-move", agentIds, channelIds: [] })
          : undefined
      }
      onDelete={
        deleteAgent && ws.isAdmin()
          ? async (agentIds) => {
              for (const agentId of agentIds) await deleteAgent(agentId);
            }
          : undefined
      }
      onAddAgent={ws.env.createAgent}
      onBack={() => ws.back()}
    />
  );
}
