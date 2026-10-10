import type { EventCheckApi, EventCheckEnvironmentStatus } from "@openbot/contracts/event-checks";

/**
 * What the person changed in the private variables of one check, and has not saved yet. It lives in
 * the memory of the component that shows it: it is never stored and never logged.
 */
export interface VariableDraft {
  /** The text typed in each masked field, by variable name. An empty text is no change. */
  values: Record<string, string>;
  /** The variables that the person marked for removal, by name. */
  removed: Record<string, boolean>;
}

export function emptyVariableDraft(): VariableDraft {
  return { values: {}, removed: {} };
}

/** One write that Save has to make. `value` is null for a removal. */
export interface VariableChange {
  name: string;
  value: string | null;
}

/** The writes of a draft, in the order of `order`, then the other names in the order they were typed. */
export function variableChanges(draft: VariableDraft, order: readonly string[] = []): VariableChange[] {
  const names = [...new Set([...order, ...Object.keys(draft.values), ...Object.keys(draft.removed)])];
  const changes: VariableChange[] = [];
  for (const name of names) {
    if (draft.removed[name]) changes.push({ name, value: null });
    else if ((draft.values[name] ?? "") !== "") changes.push({ name, value: draft.values[name] ?? "" });
  }
  return changes;
}

export function hasVariableChanges(draft: VariableDraft): boolean {
  return variableChanges(draft).length > 0;
}

export interface VariableWriteOutcome {
  /** The status that the host gave after the last write that worked. */
  variables?: EventCheckEnvironmentStatus[];
  /** The first write that failed. The ones after it were not tried. */
  failed?: { name: string; error: unknown };
}

/**
 * Writes the changes one after the other. A failure stops the run: the values after it stay typed,
 * and the host keeps what was written before it. `written` is called after each write that worked,
 * so the owner can clear that value and no other.
 */
export async function writeVariables(
  api: EventCheckApi,
  target: { agentId: string; id: string },
  changes: readonly VariableChange[],
  written: (change: VariableChange, variables: EventCheckEnvironmentStatus[]) => void,
): Promise<VariableWriteOutcome> {
  const outcome: VariableWriteOutcome = {};
  for (const change of changes) {
    // A host without the call cannot keep a value. The owner shows its own text for an unknown error.
    if (!api.setEnvironment) return { ...outcome, failed: { name: change.name, error: undefined } };
    try {
      const variables = await api.setEnvironment({ ...target, name: change.name, value: change.value });
      outcome.variables = variables;
      written(change, variables);
    } catch (error) {
      outcome.failed = { name: change.name, error };
      return outcome;
    }
  }
  return outcome;
}
