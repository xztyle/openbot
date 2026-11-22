// The interactive cards of a chat (`[card:<id>]`): the local portfolio service, or a joined server's
// portfolio-v1. Only an owner or an admin answers: the user of this computer owns the local host, and
// a joined host checks the role on each route. A joined server without portfolio-v1 has no cards.

import type { ChatCard } from "@openbot/contracts/portfolio";
import {
  decodeChatCardFromMain,
  decodeChatCardsFromMain,
  parseAnswerChatCardInput,
  parseChatCardIds,
} from "@openbot/contracts/portfolio";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { TeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import { FORK_HOST_CAPABILITY } from "@openbot/contracts/team-protocol/fork-host-v1";
import { PORTFOLIO_ROUTES } from "@openbot/contracts/team-protocol/portfolio-v1";
import { Effect, Result } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { PortfolioService } from "../../backend/portfolio/portfolio-service";
import type { ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import type { RemoteWorkflowError } from "../remote-service-effects";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler } from "./scoped-handler";

interface ChatCardRemoteServers {
  supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean;
  request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: RemoteRequestInit,
  ): Effect.Effect<T, RemoteWorkflowError>;
}

export interface ChatCardIpcDependencies {
  /** The local portfolio service, attached once the host started. */
  portfolio: () => Pick<PortfolioService, "cards"> | undefined;
  remoteServers: ChatCardRemoteServers;
  /** The person at this computer, who answers a card of the local host. */
  localPerson: () => { id: string; name: string };
}

function field<T>(name: string, decode: (value: unknown) => T): ResponseDecoder<T> {
  return (value) => {
    if (!isDynamicRecord(value)) throw new Error("Invalid card answer.");
    return decode(value[name]);
  };
}

/** Runs a local card call; a refusal (an unknown or closed card) rejects with its own message. */
async function localCall<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isSuccess(result)) return result.success;
  throw result.failure instanceof Error ? result.failure : new Error("The card could not be read.");
}

export function chatCardIpcHandlers({
  portfolio,
  remoteServers,
  localPerson,
}: ChatCardIpcDependencies): Pick<IpcGroupHandlers, "chatCards"> {
  const local = () => {
    const service = portfolio();
    if (!service) throw new Error("Cards are not ready yet.");
    return service.cards;
  };
  return {
    chatCards: {
      get: scopedHandler(parseChatCardIds, {
        local: (input): Promise<ChatCard[]> => localCall(local().get(input.cardIds)),
        remote: async (input, serverId) => {
          if (!remoteServers.supportsCapability(serverId, FORK_HOST_CAPABILITY)) return [];
          return runCauseEffect(
            remoteServers.request(serverId, PORTFOLIO_ROUTES.cards, field("cards", decodeChatCardsFromMain), {
              method: "POST",
              body: input,
            }),
          );
        },
      }),
      answer: scopedHandler(parseAnswerChatCardInput, {
        local: (input): Promise<ChatCard> => localCall(local().answer(input.cardId, input.answer, localPerson())),
        remote: (input, serverId) =>
          runCauseEffect(
            remoteServers.request(serverId, PORTFOLIO_ROUTES.answerCard, field("card", decodeChatCardFromMain), {
              method: "POST",
              body: input,
            }),
          ),
      }),
    },
  };
}
