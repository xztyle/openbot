import type { EventCheck, EventCheckApi, EventCheckExecution } from "@openbot/contracts/event-checks";
/** Preview keeps editable records and bounded logs, without making external app calls. */
export function createMockEventChecks(): EventCheckApi &
  Required<Pick<EventCheckApi, "environment" | "setEnvironment" | "test">> {
  let checks: EventCheck[] = [];
  const secrets = new Map<string, Record<string, string>>();
  const logs = new Map<string, EventCheckExecution[]>();
  const get = (agentId: string, id: string) => {
    const check = checks.find((item) => item.agentId === agentId && item.id === id);
    if (!check) throw new Error("Unknown check.");
    return check;
  };
  const environment = async ({ agentId, id }: { agentId: string; id: string }) => {
    const check = get(agentId, id);
    return check.source.kind === "api"
      ? check.source.variables.map((name) => ({ name, configured: Boolean(secrets.get(id)?.[name]) }))
      : [];
  };
  const run = async ({ agentId, id }: { agentId: string; id: string }): Promise<EventCheckExecution> => {
    get(agentId, id);
    const now = new Date().toISOString();
    const execution: EventCheckExecution = {
      id: crypto.randomUUID(),
      checkId: id,
      startedAt: now,
      finishedAt: now,
      status: "baseline",
      itemCount: 0,
      eventCount: 0,
      skippedSelfCount: 0,
      filteredCount: 0,
      durationMs: 0,
      error: null,
    };
    logs.set(id, [execution, ...(logs.get(id) ?? [])].slice(0, 10));
    return execution;
  };
  return {
    environment,
    setEnvironment: async ({ agentId, id, name, value }) => {
      const check = get(agentId, id);
      if (check.source.kind !== "api" || !check.source.variables.includes(name))
        throw new Error("Undeclared variable.");
      const values = { ...secrets.get(id) };
      if (value === null) delete values[name];
      else values[name] = value;
      secrets.set(id, values);
      check.active = false;
      check.revision = crypto.randomUUID();
      return environment({ agentId, id });
    },
    test: run,
    list: async ({ agentId }) => structuredClone(checks.filter((check) => check.agentId === agentId)),
    accounts: async () => [{ id: "preview-linear", name: "Preview Linear" }],
    tools: async () => [
      { name: "list_issues", description: "Preview issue list", inputSchemaJson: '{"type":"object"}' },
    ],
    save: async (input) => {
      if (
        input.active &&
        input.source.kind === "api" &&
        input.source.variables.length > 0 &&
        (!input.id || input.source.variables.some((name) => !secrets.get(input.id ?? "")?.[name]))
      )
        throw new Error("Missing private variable.");
      const now = new Date().toISOString();
      const check: EventCheck = {
        ...structuredClone(input),
        id: input.id ?? crypto.randomUUID(),
        revision: crypto.randomUUID(),
        nextCheckAt: now,
        createdAt: checks.find((item) => item.id === input.id)?.createdAt ?? now,
        updatedAt: now,
      };
      checks = [...checks.filter((item) => item.id !== check.id), check];
      return structuredClone(check);
    },
    remove: async ({ agentId, id }) => {
      checks = checks.filter((item) => item.id !== id || item.agentId !== agentId);
      logs.delete(id);
      secrets.delete(id);
    },
    history: async ({ id }) => structuredClone(logs.get(id) ?? []),
    checkNow: async ({ id }) => {
      const previous = logs.get(id) ?? [];
      const now = new Date().toISOString();
      const execution: EventCheckExecution = {
        id: crypto.randomUUID(),
        checkId: id,
        startedAt: now,
        finishedAt: now,
        status: previous.length ? "unchanged" : "baseline",
        itemCount: 0,
        eventCount: 0,
        skippedSelfCount: 0,
        filteredCount: 0,
        durationMs: 0,
        error: null,
      };
      logs.set(id, [execution, ...previous].slice(0, 10));
      return execution;
    },
  };
}
