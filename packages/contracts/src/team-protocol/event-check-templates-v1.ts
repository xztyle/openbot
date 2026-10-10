import {
  decodeEventCheckDiscoverCheckInput,
  decodeEventCheckPickerOptions,
  decodeEventCheckTemplateAdoptInput,
  decodeEventCheckTemplateDiscoverInput,
  decodeEventCheckTemplateInstallInput,
  decodeEventCheckTemplateList,
} from "../event-check-templates";
import { decodeEventCheck, decodeEventCheckTarget } from "../event-checks";
import { adminRoute, fields, type OptionalRouteCodec } from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import { decodeTeamProtocolV2Json } from "./v2";

export const EVENT_CHECK_TEMPLATES_CAPABILITY = FORK_HOST_CAPABILITY;
export const EVENT_CHECK_TEMPLATES_ROUTES = {
  list: "/v1/event-check-templates/list",
  install: "/v1/event-check-templates/install",
  update: "/v1/event-check-templates/update",
  adopt: "/v1/event-check-templates/adopt",
  /**
   * Lists the choices of a picker setting, with private values the user typed that the host uses once.
   * Behind `fork-host-v1`, like the routes above: a host that has it answers, and an older host does
   * not, so a client shows the setting as plain text there.
   */
  discover: "/v1/event-check-templates/discover",
  /** The same for an installed check, with the private values that it holds. */
  discoverCheck: "/v1/event-check-templates/discover-check",
} as const;
const checked =
  <A>(decode: (value: unknown) => A) =>
  (value: unknown) =>
    decodeTeamProtocolV2Json(decode(value));
export const EVENT_CHECK_TEMPLATES_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [EVENT_CHECK_TEMPLATES_ROUTES.list, adminRoute(fields({}), checked(decodeEventCheckTemplateList))],
  [
    EVENT_CHECK_TEMPLATES_ROUTES.install,
    adminRoute(checked(decodeEventCheckTemplateInstallInput), checked(decodeEventCheck)),
  ],
  [EVENT_CHECK_TEMPLATES_ROUTES.update, adminRoute(checked(decodeEventCheckTarget), checked(decodeEventCheck))],
  [
    EVENT_CHECK_TEMPLATES_ROUTES.adopt,
    adminRoute(checked(decodeEventCheckTemplateAdoptInput), checked(decodeEventCheck)),
  ],
  [
    EVENT_CHECK_TEMPLATES_ROUTES.discover,
    adminRoute(checked(decodeEventCheckTemplateDiscoverInput), checked(decodeEventCheckPickerOptions)),
  ],
  [
    EVENT_CHECK_TEMPLATES_ROUTES.discoverCheck,
    adminRoute(checked(decodeEventCheckDiscoverCheckInput), checked(decodeEventCheckPickerOptions)),
  ],
]);
