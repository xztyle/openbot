import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentEvent, AgentMemory, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { isAgentMemory } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import type { MemoriesPort } from "./memories-port";

/** The same bound as the desktop's `parseCreateAgentMemory`. The host checks it again. */
function boundedText(text: string): string {
  if (text.length > INPUT_LIMITS.agentMemoryText) throw new Error("The memory is too long.");
  return text;
}

/**
 * The memories of an agent on the connected host, through the Team API routes that the desktop's remote
 * path and the phone use. The host keeps the cap of memories, so `limit` is null here.
 */
export function webMemoriesPort(
  agentId: string,
  agentName: string,
  request: TeamApiRequest,
  onEvent?: (listener: (event: AgentEvent | TeamRealtimeEvent) => void) => () => void,
): MemoriesPort {
  const decodeMemory = (value: unknown): AgentMemory => {
    if (!isAgentMemory(value) || value.agentId !== agentId) throw new Error("The host returned an invalid memory.");
    return value;
  };
  return {
    ownerId: agentId,
    ownerLabel: agentName,
    ownerNoun: "agent",
    limit: null,
    list: () =>
      request("GET", TEAM_API_ROUTES.agent.memories(agentId), (value) => {
        if (!Array.isArray(value) || !value.every(isAgentMemory) || value.some((memory) => memory.agentId !== agentId))
          throw new Error("The host returned invalid memories.");
        return value;
      }),
    create: async (text) => {
      await request("POST", TEAM_API_ROUTES.agent.memories(agentId), decodeMemory, { text: boundedText(text) });
    },
    update: async (memoryId, text) => {
      await request("PATCH", TEAM_API_ROUTES.agent.memory(agentId, memoryId), decodeMemory, {
        text: boundedText(text),
      });
    },
    remove: async (memoryId) => {
      await request("DELETE", TEAM_API_ROUTES.agent.memory(agentId, memoryId), () => undefined);
    },
    clear: async () => {
      await request("DELETE", TEAM_API_ROUTES.agent.memories(agentId), () => undefined);
    },
    subscribe: (reload) =>
      onEvent?.((event) => {
        if (event.type === "memories-changed" && event.agentId === agentId) reload();
      }) ?? (() => {}),
  };
}
