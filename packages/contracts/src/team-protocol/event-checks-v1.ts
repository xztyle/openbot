import {
  decodeEventCheckAccount,
  decodeEventCheckExecution,
  decodeEventCheckList,
  decodeEventCheckTarget,
  decodeEventCheckTool,
  decodeMcpEventCheck,
  decodeMcpEventCheckInput,
} from "../event-checks";
import { adminRoute, fields, identifier, type OptionalRouteCodec } from "./admin-wire";
import { decodeTeamProtocolV2Json } from "./v2";

export const EVENT_CHECKS_CAPABILITY = "event-checks-v1";
export const EVENT_CHECKS_ROUTES = {
  list: "/v1/event-checks/list",
  save: "/v1/event-checks/save",
  remove: "/v1/event-checks/remove",
  checkNow: "/v1/event-checks/check-now",
  history: "/v1/event-checks/history",
  accounts: "/v1/event-checks/accounts",
  tools: "/v1/event-checks/tools",
} as const;
const checked =
  <A>(decode: (value: unknown) => A) =>
  (value: unknown) =>
    decodeTeamProtocolV2Json(decode(value));
const agent = fields({ agentId: identifier });
const target = checked(decodeEventCheckTarget);
const check = checked(decodeMcpEventCheck);
const execution = checked(decodeEventCheckExecution);
export const EVENT_CHECKS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    EVENT_CHECKS_ROUTES.list,
    adminRoute(
      agent,
      checked((v) => decodeEventCheckList(v, decodeMcpEventCheck)),
    ),
  ],
  [EVENT_CHECKS_ROUTES.save, adminRoute(checked(decodeMcpEventCheckInput), check)],
  [EVENT_CHECKS_ROUTES.remove, adminRoute(target, () => null)],
  [EVENT_CHECKS_ROUTES.checkNow, adminRoute(target, execution)],
  [
    EVENT_CHECKS_ROUTES.history,
    adminRoute(
      target,
      checked((v) => decodeEventCheckList(v, decodeEventCheckExecution, 10)),
    ),
  ],
  [
    EVENT_CHECKS_ROUTES.accounts,
    adminRoute(
      agent,
      checked((v) => decodeEventCheckList(v, decodeEventCheckAccount)),
    ),
  ],
  [
    EVENT_CHECKS_ROUTES.tools,
    adminRoute(
      fields({ agentId: identifier, connectionId: identifier }),
      checked((v) => decodeEventCheckList(v, decodeEventCheckTool, 500)),
    ),
  ],
]);
