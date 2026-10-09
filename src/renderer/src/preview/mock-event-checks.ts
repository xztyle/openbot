import type { EventCheck, EventCheckApi, EventCheckExecution } from "@openbot/contracts/event-checks";
/** Preview keeps editable records and bounded logs, without making external app calls. */
export function createMockEventChecks(): EventCheckApi {
  let checks: EventCheck[] = [];
  const logs = new Map<string, EventCheckExecution[]>();
  return {
    list: async ({ agentId }) => structuredClone(checks.filter((check) => check.agentId === agentId)),
    accounts: async () => [{ id: "preview-linear", name: "Preview Linear" }],
    tools: async () => [
      { name: "list_issues", description: "Preview issue list", inputSchemaJson: '{"type":"object"}' },
    ],
    save: async (input) => {
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
        durationMs: 0,
        error: null,
      };
      logs.set(id, [execution, ...previous].slice(0, 10));
      return execution;
    },
  };
}
