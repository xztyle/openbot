import { sourceText } from "@openbot/i18n/source";
import type { OpenBotDatabase } from "./openbot-database";

interface TransactionScope {
  readonly rollback: (() => void)[];
  readonly commit: (() => void)[];
}

/** Only the caller that opened the transaction holds a scope, so a nested call finds the owner's. */
const openTransactions = new WeakMap<OpenBotDatabase, TransactionScope>();

/**
 * Runs `work` inside a SQLite transaction, opening one only when the caller is not already inside
 * another. Nesting is load-bearing: `deleteRoutine` drives a routine mutation whose `beforeMutate`
 * hook appends a run transition in the same transaction, and an approval response can append a
 * hosted-site event inside an outer one. This is the only `BEGIN IMMEDIATE` under `src/backend/agent`.
 *
 * `onCommit` exists because a nested caller must not publish in-memory state the owner can still
 * discard: there is no partial rollback here, so effects that make rows visible to the rest of the
 * app are queued on the owner and run once, after `COMMIT`. `onRollback` is queued the same way, so
 * an owner that fails *after* a nested call succeeded still undoes that call's in-memory slice.
 */
export function withDatabaseTransaction<T>(
  database: OpenBotDatabase,
  work: () => T,
  onRollback?: () => void,
  onCommit?: () => void,
): T {
  // `isTransaction`, not the map, decides who opens one: a transaction started anywhere else would
  // otherwise make this call BEGIN IMMEDIATE inside it, which SQLite rejects.
  if (database.connection.isTransaction) {
    const owner = openTransactions.get(database);
    let result: T;
    try {
      result = work();
    } catch (error) {
      // Our own work failed, so undo our in-memory slice now rather than queueing it: the owner's
      // ROLLBACK will undo the rows, and a queued restorer would run a second time.
      onRollback?.();
      throw error;
    }
    if (owner) {
      if (onRollback) owner.rollback.push(onRollback);
      if (onCommit) owner.commit.push(onCommit);
    } else {
      // An ambient transaction this helper did not open has no queue to defer onto, so the
      // effects run as they always did.
      onCommit?.();
    }
    return result;
  }
  database.connection.exec("BEGIN IMMEDIATE");
  const scope: TransactionScope = { rollback: [], commit: [] };
  openTransactions.set(database, scope);
  let result: T;
  try {
    result = work();
    database.connection.exec("COMMIT");
  } catch (error) {
    if (database.connection.isTransaction) database.connection.exec("ROLLBACK");
    openTransactions.delete(database);
    // Innermost first, so each restorer sees the state the one after it has already put back.
    for (const restore of [...scope.rollback].reverse()) restore();
    onRollback?.();
    throw error;
  }
  // Past COMMIT the rows are durable, so the effects run outside the block above: a listener that
  // throws while a conversation is published must not reach the restorers, which would put the
  // in-memory projection back to a state SQLite no longer holds. Only `work` and `COMMIT` roll back.
  //
  // The scope is cleared first because publishing can re-enter this function, which must then open
  // its own transaction instead of joining one that is already committed.
  openTransactions.delete(database);
  // Every effect runs, so a throw from one does not skip the rest. The rows are already durable,
  // and an effect that keeps memory in step with them is the only thing left to put it back.
  const failures: unknown[] = [];
  const runEffect = (effect: (() => void) | undefined): void => {
    try {
      effect?.();
    } catch (error) {
      failures.push(error);
    }
  };
  for (const effect of scope.commit) runEffect(effect);
  runEffect(onCommit);
  // One failure keeps its own message, because a single failing listener already names the cause.
  // Several report together, so no cause is lost.
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, sourceText("error.agent.commitEffectsFailed"));
  return result;
}
