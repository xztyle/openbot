import {
  decodeEventCheck,
  decodeEventCheckAccount,
  decodeEventCheckEnvironmentInput,
  decodeEventCheckEnvironmentStatus,
  decodeEventCheckExecution,
  decodeEventCheckInput,
  decodeEventCheckList,
  decodeEventCheckTarget,
  decodeEventCheckTool,
} from "../event-checks";
import { adminRoute, fields, identifier, type OptionalRouteCodec } from "./admin-wire";
import { decodeTeamProtocolV2Json } from "./v2";

export const EVENT_CHECK_API_CAPABILITY = "event-check-api-v1";
/**
 * Optional fields on the event check routes above and in `event-checks-v1`: `delivery` on a check
 * (a digest window and item filters), `health` on a listed check, and `filteredCount` on an execution.
 * A host that advertises it reads and keeps `delivery`. A client that does not know the fields ignores
 * them, and a client that does not send `delivery` leaves the saved value as it is.
 */
export const EVENT_CHECK_DELIVERY_CAPABILITY = "event-check-delivery-v1";
export const EVENT_CHECK_API_ROUTES = {
  environment: "/v1/event-check-api/environment",
  setEnvironment: "/v1/event-check-api/set-environment",
  test: "/v1/event-check-api/test",
  list: "/v1/event-check-api/list",
  save: "/v1/event-check-api/save",
  remove: "/v1/event-check-api/remove",
  checkNow: "/v1/event-check-api/check-now",
  history: "/v1/event-check-api/history",
  accounts: "/v1/event-check-api/accounts",
  tools: "/v1/event-check-api/tools",
} as const;
const checked =
  <A>(decode: (value: unknown) => A) =>
  (value: unknown) =>
    decodeTeamProtocolV2Json(decode(value));
const agent = fields({ agentId: identifier });
const target = checked(decodeEventCheckTarget);
const check = checked(decodeEventCheck);
const execution = checked(decodeEventCheckExecution);
export const EVENT_CHECK_API_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    EVENT_CHECK_API_ROUTES.environment,
    adminRoute(
      target,
      checked((v) => decodeEventCheckList(v, decodeEventCheckEnvironmentStatus, 20)),
    ),
  ],
  [
    EVENT_CHECK_API_ROUTES.setEnvironment,
    adminRoute(
      checked(decodeEventCheckEnvironmentInput),
      checked((v) => decodeEventCheckList(v, decodeEventCheckEnvironmentStatus, 20)),
    ),
  ],
  [EVENT_CHECK_API_ROUTES.test, adminRoute(target, execution)],
  [
    EVENT_CHECK_API_ROUTES.list,
    adminRoute(
      agent,
      checked((v) => decodeEventCheckList(v, decodeEventCheck)),
    ),
  ],
  [EVENT_CHECK_API_ROUTES.save, adminRoute(checked(decodeEventCheckInput), check)],
  [EVENT_CHECK_API_ROUTES.remove, adminRoute(target, () => null)],
  [EVENT_CHECK_API_ROUTES.checkNow, adminRoute(target, execution)],
  [
    EVENT_CHECK_API_ROUTES.history,
    adminRoute(
      target,
      checked((v) => decodeEventCheckList(v, decodeEventCheckExecution, 10)),
    ),
  ],
  [
    EVENT_CHECK_API_ROUTES.accounts,
    adminRoute(
      agent,
      checked((v) => decodeEventCheckList(v, decodeEventCheckAccount)),
    ),
  ],
  [
    EVENT_CHECK_API_ROUTES.tools,
    adminRoute(
      fields({ agentId: identifier, connectionId: identifier }),
      checked((v) => decodeEventCheckList(v, decodeEventCheckTool, 500)),
    ),
  ],
]);
