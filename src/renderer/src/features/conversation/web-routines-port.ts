import type { AgentEvent, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { isRoutineRunFields } from "@openbot/contracts/ipc";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import type { EventRoutinesApi } from "./routine-webhooks-api";
import { eventRoutinesPort } from "./routines-port";
export function webRoutinesPort(
  agentId: string,
  api: EventRoutinesApi,
  request: TeamApiRequest,
  onEvent?: (listener: (event: AgentEvent | TeamRealtimeEvent) => void) => () => void,
) {
  return eventRoutinesPort({ kind: "agent", id: agentId }, api, {
    listRuns: (id, limit) =>
      request(
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}/routines/${encodeURIComponent(id)}/runs?limit=${limit}`,
        (value) => {
          if (!Array.isArray(value) || value.length > 100 || !value.every(isRoutineRunFields))
            throw new Error("Invalid routine history.");
          return value;
        },
      ),
    subscribe: (reload) =>
      onEvent?.((event) => {
        if (event.type === "routines-changed" && event.agentId === agentId) reload();
      }) ?? (() => {}),
  });
}
