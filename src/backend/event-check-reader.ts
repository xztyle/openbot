import type { EventCheckAccount, EventCheckTool } from "@openbot/contracts/event-checks";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import type { Effect } from "effect";
import type { McpOperationError } from "./mcp-effects";

export type EventCheckData = TeamProtocolV2Json;
export type EventCheckArguments = { [key: string]: EventCheckData };
export interface EventCheckReadSession {
  tools: EventCheckTool[];
  valid(): boolean;
  call(toolName: string, args: EventCheckArguments): Effect.Effect<EventCheckData, McpOperationError>;
}
/** A host-only read boundary. It never exposes credentials or grants additional app access. */
export interface EventCheckReader {
  accounts(agentId: string): EventCheckAccount[];
  read<A>(
    agentId: string,
    connectionId: string,
    use: (session: EventCheckReadSession) => Effect.Effect<A, McpOperationError>,
  ): Effect.Effect<A, McpOperationError>;
}
