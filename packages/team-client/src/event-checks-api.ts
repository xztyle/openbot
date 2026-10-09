import {
  decodeEventCheck,
  decodeEventCheckAccount,
  decodeEventCheckEnvironmentStatus,
  decodeEventCheckExecution,
  decodeEventCheckList,
  decodeEventCheckTool,
  type EventCheckApi,
} from "@openbot/contracts/event-checks";
import { EVENT_CHECK_API_ROUTES } from "@openbot/contracts/team-protocol/event-check-api-v1";
import { EVENT_CHECKS_ROUTES } from "@openbot/contracts/team-protocol/event-checks-v1";
import { decodeTeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import type { TeamApiRequest } from "./team-api-requests";
export function eventChecksApi(request: TeamApiRequest, apiSupported: () => boolean = () => false): EventCheckApi {
  const call = <A>(path: string, input: unknown, decode: (value: unknown) => A) =>
    request(
      "POST",
      apiSupported() ? path.replace("/v1/event-checks/", "/v1/event-check-api/") : path,
      decode,
      decodeTeamProtocolV2Json(input),
    );
  return {
    get environment() {
      return apiSupported()
        ? (input: { agentId: string; id: string }) =>
            call(EVENT_CHECK_API_ROUTES.environment, input, (v) =>
              decodeEventCheckList(v, decodeEventCheckEnvironmentStatus, 20),
            )
        : undefined;
    },
    get setEnvironment() {
      return apiSupported()
        ? (input: import("@openbot/contracts/event-checks").EventCheckEnvironmentInput) =>
            call(EVENT_CHECK_API_ROUTES.setEnvironment, input, (v) =>
              decodeEventCheckList(v, decodeEventCheckEnvironmentStatus, 20),
            )
        : undefined;
    },
    get test() {
      return apiSupported()
        ? (input: { agentId: string; id: string }) =>
            call(EVENT_CHECK_API_ROUTES.test, input, decodeEventCheckExecution)
        : undefined;
    },
    list: (input) => call(EVENT_CHECKS_ROUTES.list, input, (v) => decodeEventCheckList(v, decodeEventCheck)),
    save: (input) => call(EVENT_CHECKS_ROUTES.save, input, decodeEventCheck),
    remove: (input) => call(EVENT_CHECKS_ROUTES.remove, input, () => undefined),
    checkNow: (input) => call(EVENT_CHECKS_ROUTES.checkNow, input, decodeEventCheckExecution),
    history: (input) =>
      call(EVENT_CHECKS_ROUTES.history, input, (v) => decodeEventCheckList(v, decodeEventCheckExecution, 10)),
    accounts: (input) =>
      call(EVENT_CHECKS_ROUTES.accounts, input, (v) => decodeEventCheckList(v, decodeEventCheckAccount)),
    tools: (input) => call(EVENT_CHECKS_ROUTES.tools, input, (v) => decodeEventCheckList(v, decodeEventCheckTool, 500)),
  };
}
