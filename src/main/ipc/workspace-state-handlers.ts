// The reader's own workspace state on a server: the read position and follow of each thread, and
// mark unread. The
// local host answers from the channel service as the host user of this computer; a joined server
// answers through workspace-read-state-v1 (`fork-host-v1`), and one without it fails.

import {
  decodeWorkspaceReadPosition,
  decodeWorkspaceThreadState,
  decodeWorkspaceThreadStates,
  parseWorkspaceFollowThreadInput,
  parseWorkspaceMarkUnreadInput,
  parseWorkspaceReadThreadInput,
  parseWorkspaceThreadStatesInput,
} from "@openbot/contracts/ipc";
import {
  WORKSPACE_READ_STATE_CAPABILITY,
  WORKSPACE_READ_STATE_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-read-state-v1";
import { sourceText } from "@openbot/i18n/source";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { HostService } from "../host-service";
import type { ResponseDecoder } from "../remote-host-decoding";
import type { RemoteServerManager } from "../remote-server-manager";
import { scopedHandler } from "./scoped-handler";

export interface WorkspaceStateIpcDependencies {
  service: AgentService;
  host: HostService;
  remoteServers: RemoteServerManager;
}

/** The handlers of the `agent` group for the reader's thread states; `agentIpcHandlers` spreads them. */
export function workspaceStateHandlers({ service, host, remoteServers }: WorkspaceStateIpcDependencies) {
  const remote = <Body, T>(serverId: string, path: string, body: Body, decoder: ResponseDecoder<T>) => {
    if (!remoteServers.supportsCapability(serverId, WORKSPACE_READ_STATE_CAPABILITY))
      throw new Error(sourceText("error.team.workspaceUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, path, decoder, { method: "POST", body }));
  };
  return {
    workspaceThreadStates: scopedHandler(parseWorkspaceThreadStatesInput, {
      local: (input) => service.channels.threadStates(input, host.channelViewer()),
      remote: (input, serverId) =>
        remote(serverId, WORKSPACE_READ_STATE_ROUTES.threadStates, input, decodeWorkspaceThreadStates),
    }),
    workspaceReadThread: scopedHandler(parseWorkspaceReadThreadInput, {
      local: (input) => service.channels.readThread(input, host.channelActor(), host.channelViewer()),
      remote: (input, serverId) =>
        remote(serverId, WORKSPACE_READ_STATE_ROUTES.readThread, input, decodeWorkspaceThreadState),
    }),
    workspaceFollowThread: scopedHandler(parseWorkspaceFollowThreadInput, {
      local: (input) => service.channels.followThread(input, host.channelActor(), host.channelViewer()),
      remote: (input, serverId) =>
        remote(serverId, WORKSPACE_READ_STATE_ROUTES.followThread, input, decodeWorkspaceThreadState),
    }),
    workspaceMarkUnread: scopedHandler(parseWorkspaceMarkUnreadInput, {
      // The reader here is the host user of this computer, as in `listChannels`.
      local: (input) => service.channels.markUnread(input, host.channelActor(), host.channelViewer(), true),
      remote: (input, serverId) =>
        remote(serverId, WORKSPACE_READ_STATE_ROUTES.markUnread, input, decodeWorkspaceReadPosition),
    }),
  };
}
