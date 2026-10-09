import {
  decodeEventCheck,
  decodeEventCheckAccount,
  decodeEventCheckExecution,
  decodeEventCheckInput,
  decodeEventCheckList,
  decodeEventCheckTarget,
  decodeEventCheckTool,
} from "@openbot/contracts/event-checks";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { EVENT_CHECKS_CAPABILITY, EVENT_CHECKS_ROUTES } from "@openbot/contracts/team-protocol/event-checks-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { EventCheckScheduler } from "../../backend/event-check-scheduler";
import type { RemoteServerManager } from "../remote-server-manager";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler } from "./scoped-handler";
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
): Pick<IpcGroupHandlers, "eventChecks"> {
  const request = <A>(id: string, path: string, body: unknown, decode: (value: unknown) => A) => {
    if (!remote.supportsCapability(id, EVENT_CHECKS_CAPABILITY))
      throw new Error(sourceText("error.backend.eventCheckUnsupported"));
    return runCauseEffect(remote.request(id, path, decode, { method: "POST", body, timeoutMs: 60_000 }));
  };
  return {
    eventChecks: {
      list: scopedHandler(parseCheckAgent, {
        local: (v) => runCauseEffect(checks.list(v)),
        remote: (v, id) => request(id, EVENT_CHECKS_ROUTES.list, v, (r) => decodeEventCheckList(r, decodeEventCheck)),
      }),
      save: scopedHandler(decodeEventCheckInput, {
        local: (v) => runCauseEffect(checks.save(v)),
        remote: (v, id) => request(id, EVENT_CHECKS_ROUTES.save, v, decodeEventCheck),
      }),
      remove: scopedHandler(decodeEventCheckTarget, {
        local: (v) => runCauseEffect(checks.remove(v)),
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
