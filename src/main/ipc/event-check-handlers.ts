import {
  decodeEventCheckDiscoverCheckInput,
  decodeEventCheckPickerOptions,
  decodeEventCheckTemplateAdoptInput,
  decodeEventCheckTemplateDiscoverInput,
  decodeEventCheckTemplateInstallInput,
  decodeEventCheckTemplateList,
} from "@openbot/contracts/event-check-templates";
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
} from "@openbot/contracts/event-checks";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  EVENT_CHECK_API_CAPABILITY,
  EVENT_CHECK_API_ROUTES,
} from "@openbot/contracts/team-protocol/event-check-api-v1";
import {
  EVENT_CHECK_TEMPLATES_CAPABILITY,
  EVENT_CHECK_TEMPLATES_ROUTES,
} from "@openbot/contracts/team-protocol/event-check-templates-v1";
import { EVENT_CHECKS_CAPABILITY, EVENT_CHECKS_ROUTES } from "@openbot/contracts/team-protocol/event-checks-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { EventCheckScheduler } from "../../backend/event-check-scheduler";
import { LOCAL_USER_ACTOR } from "../../backend/security-actor";
import type { RemoteServerManager } from "../remote-server-manager";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler, scopedQueryHandler } from "./scoped-handler";
export function parseCheckAgent(value: unknown): { agentId: string } {
  if (!isDynamicRecord(value) || typeof value.agentId !== "string" || !value.agentId || value.agentId.length > 128)
    throw new Error(sourceText("error.backend.eventCheckFailed"));
  return { agentId: value.agentId };
}
function parseCheckTools(value: unknown): { agentId: string; connectionId: string } {
  const target = parseCheckAgent(value);
  if (
    !isDynamicRecord(value) ||
    typeof value.connectionId !== "string" ||
    !value.connectionId ||
    value.connectionId.length > 128
  )
    throw new Error(sourceText("error.mcp.chatDenied"));
  return { ...target, connectionId: value.connectionId };
}
export function eventCheckIpcHandlers(
  checks: EventCheckScheduler,
  remote: Pick<RemoteServerManager, "request" | "supportsCapability">,
): Pick<IpcGroupHandlers, "eventChecks" | "eventCheckTemplates"> {
  const request = <A>(id: string, path: string, body: unknown, decode: (value: unknown) => A) => {
    if (!remote.supportsCapability(id, EVENT_CHECKS_CAPABILITY))
      throw new Error(sourceText("error.backend.eventCheckUnsupported"));
    const api = remote.supportsCapability(id, EVENT_CHECK_API_CAPABILITY);
    if (path.startsWith("/v1/event-check-api/") && !api)
      throw new Error(sourceText("error.backend.eventCheckUnsupported"));
    const mapped = api ? path.replace("/v1/event-checks/", "/v1/event-check-api/") : path;
    return runCauseEffect(remote.request(id, mapped, decode, { method: "POST", body, timeoutMs: 60_000 }));
  };
  const templates = <A>(id: string, path: string, body: unknown, decode: (value: unknown) => A) => {
    if (!remote.supportsCapability(id, EVENT_CHECK_TEMPLATES_CAPABILITY))
      throw new Error(sourceText("error.backend.eventCheckUnsupported"));
    return runCauseEffect(remote.request(id, path, decode, { method: "POST", body, timeoutMs: 60_000 }));
  };
  return {
    eventCheckTemplates: {
      list: scopedQueryHandler({
        local: () => runCauseEffect(checks.templateList()),
        remote: (id) => templates(id, EVENT_CHECK_TEMPLATES_ROUTES.list, {}, decodeEventCheckTemplateList),
      }),
      install: scopedHandler(decodeEventCheckTemplateInstallInput, {
        local: (v) => runCauseEffect(checks.templateInstall(v, LOCAL_USER_ACTOR)),
        remote: (v, id) => templates(id, EVENT_CHECK_TEMPLATES_ROUTES.install, v, decodeEventCheck),
      }),
      update: scopedHandler(decodeEventCheckTarget, {
        local: (v) => runCauseEffect(checks.templateUpdate(v, LOCAL_USER_ACTOR)),
        remote: (v, id) => templates(id, EVENT_CHECK_TEMPLATES_ROUTES.update, v, decodeEventCheck),
      }),
      adopt: scopedHandler(decodeEventCheckTemplateAdoptInput, {
        local: (v) => runCauseEffect(checks.templateAdopt(v, LOCAL_USER_ACTOR)),
        remote: (v, id) => templates(id, EVENT_CHECK_TEMPLATES_ROUTES.adopt, v, decodeEventCheck),
      }),
      // The payload of `discover` can hold private values. The decoder keeps them out of its messages.
      discover: scopedHandler(decodeEventCheckTemplateDiscoverInput, {
        local: (v) => runCauseEffect(checks.templateDiscover(v, LOCAL_USER_ACTOR)),
        remote: (v, id) => templates(id, EVENT_CHECK_TEMPLATES_ROUTES.discover, v, decodeEventCheckPickerOptions),
      }),
      discoverCheck: scopedHandler(decodeEventCheckDiscoverCheckInput, {
        local: (v) => runCauseEffect(checks.discoverCheck(v, LOCAL_USER_ACTOR)),
        remote: (v, id) => templates(id, EVENT_CHECK_TEMPLATES_ROUTES.discoverCheck, v, decodeEventCheckPickerOptions),
      }),
    },
    eventChecks: {
      environment: scopedHandler(decodeEventCheckTarget, {
        local: (v) => runCauseEffect(checks.environment(v)),
        remote: (v, id) =>
          request(id, EVENT_CHECK_API_ROUTES.environment, v, (r) =>
            decodeEventCheckList(r, decodeEventCheckEnvironmentStatus, 20),
          ),
      }),
      setEnvironment: scopedHandler(decodeEventCheckEnvironmentInput, {
        local: (v) => runCauseEffect(checks.setEnvironment(v, LOCAL_USER_ACTOR)),
        remote: (v, id) =>
          request(id, EVENT_CHECK_API_ROUTES.setEnvironment, v, (r) =>
            decodeEventCheckList(r, decodeEventCheckEnvironmentStatus, 20),
          ),
      }),
      test: scopedHandler(decodeEventCheckTarget, {
        local: (v) => runCauseEffect(checks.test(v)),
        remote: (v, id) => request(id, EVENT_CHECK_API_ROUTES.test, v, decodeEventCheckExecution),
      }),
      list: scopedHandler(parseCheckAgent, {
        local: (v) => runCauseEffect(checks.list(v)),
        remote: (v, id) => request(id, EVENT_CHECKS_ROUTES.list, v, (r) => decodeEventCheckList(r, decodeEventCheck)),
      }),
      save: scopedHandler(decodeEventCheckInput, {
        local: (v) => runCauseEffect(checks.save(v, LOCAL_USER_ACTOR)),
        remote: (v, id) => request(id, EVENT_CHECKS_ROUTES.save, v, decodeEventCheck),
      }),
      remove: scopedHandler(decodeEventCheckTarget, {
        local: (v) => runCauseEffect(checks.remove(v, LOCAL_USER_ACTOR)),
        remote: (v, id) => request(id, EVENT_CHECKS_ROUTES.remove, v, () => undefined),
      }),
      checkNow: scopedHandler(decodeEventCheckTarget, {
        local: (v) => runCauseEffect(checks.checkNow(v)),
        remote: (v, id) => request(id, EVENT_CHECKS_ROUTES.checkNow, v, decodeEventCheckExecution),
      }),
      history: scopedHandler(decodeEventCheckTarget, {
        local: (v) => runCauseEffect(checks.history(v)),
        remote: (v, id) =>
          request(id, EVENT_CHECKS_ROUTES.history, v, (r) => decodeEventCheckList(r, decodeEventCheckExecution, 10)),
      }),
      accounts: scopedHandler(parseCheckAgent, {
        local: (v) => runCauseEffect(checks.accounts(v)),
        remote: (v, id) =>
          request(id, EVENT_CHECKS_ROUTES.accounts, v, (r) => decodeEventCheckList(r, decodeEventCheckAccount)),
      }),
      tools: scopedHandler(parseCheckTools, {
        local: (v) => runCauseEffect(checks.tools(v)),
        remote: (v, id) =>
          request(id, EVENT_CHECKS_ROUTES.tools, v, (r) => decodeEventCheckList(r, decodeEventCheckTool, 500)),
      }),
    },
  };
}
