// The owner routes of a joined fork host (sleep, reviews, learning, the decision queue, knowledge,
// the portfolio, trust and the guardrails), which the browser client sends itself. Main sends the
// window's request on unchanged, and the joined host checks the role on each route. The window
// decodes the answer with the route's own codec. This computer's own host has no such routes here.

import type { TeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import { FORK_HOST_CAPABILITY } from "@openbot/contracts/team-protocol/fork-host-v1";
import {
  FORK_LONG_ROUTE_TIMEOUT_MS,
  FORK_LONG_ROUTES,
  parseForkRouteRequest,
} from "@openbot/contracts/team-protocol/fork-routes";
import type { Effect } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import type { RemoteWorkflowError } from "../remote-service-effects";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler } from "./scoped-handler";

interface ForkRouteRemoteServers {
  supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean;
  request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: RemoteRequestInit,
  ): Effect.Effect<T, RemoteWorkflowError>;
}

const answer: ResponseDecoder<unknown> = (value) => value;

export function forkRouteIpcHandlers({
  remoteServers,
}: {
  remoteServers: ForkRouteRemoteServers;
}): Pick<IpcGroupHandlers, "forkRoutes"> {
  return {
    forkRoutes: {
      request: scopedHandler(parseForkRouteRequest, {
        local: () => {
          throw new Error("This computer's host does not serve this.");
        },
        remote: (input, serverId) => {
          if (!remoteServers.supportsCapability(serverId, FORK_HOST_CAPABILITY))
            throw new Error("This server does not support this.");
          return runCauseEffect(
            remoteServers.request(serverId, input.path, answer, {
              method: "POST",
              body: input.body,
              ...(FORK_LONG_ROUTES.has(input.path) ? { timeoutMs: FORK_LONG_ROUTE_TIMEOUT_MS } : {}),
            }),
          );
        },
      }),
    },
  };
}
