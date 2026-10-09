import {
  decodeEventCheck,
  decodeEventCheckAccount,
  decodeEventCheckExecution,
  decodeEventCheckList,
  decodeEventCheckTool,
  type EventCheckApi,
} from "@openbot/contracts/event-checks";
import { EVENT_CHECKS_ROUTES } from "@openbot/contracts/team-protocol/event-checks-v1";
import { decodeTeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import type { TeamApiRequest } from "./team-api-requests";
export function eventChecksApi(request: TeamApiRequest): EventCheckApi {
  const call = <A>(path: string, input: unknown, decode: (value: unknown) => A) =>
    request("POST", path, decode, decodeTeamProtocolV2Json(input));
  return {
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
