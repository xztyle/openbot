import { decodeEventCheckTemplateList, type EventCheckTemplateApi } from "@openbot/contracts/event-check-templates";
import { decodeEventCheck } from "@openbot/contracts/event-checks";
import { EVENT_CHECK_TEMPLATES_ROUTES } from "@openbot/contracts/team-protocol/event-check-templates-v1";
import { decodeTeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import type { TeamApiRequest } from "./team-api-requests";

export function eventCheckTemplatesApi(request: TeamApiRequest): EventCheckTemplateApi {
  const call = <A>(path: string, input: unknown, decode: (value: unknown) => A) =>
    request("POST", path, decode, decodeTeamProtocolV2Json(input));
  return {
    list: () => call(EVENT_CHECK_TEMPLATES_ROUTES.list, {}, decodeEventCheckTemplateList),
    install: (input) => call(EVENT_CHECK_TEMPLATES_ROUTES.install, input, decodeEventCheck),
    update: (input) => call(EVENT_CHECK_TEMPLATES_ROUTES.update, input, decodeEventCheck),
    adopt: (input) => call(EVENT_CHECK_TEMPLATES_ROUTES.adopt, input, decodeEventCheck),
  };
}
