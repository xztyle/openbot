import type { DatabaseSync, PrepareOptions, StatementSync } from "node:sqlite";

/** Compiled statements kept for each connection. Dynamic SQL, such as an `IN` list, makes more. */
const STATEMENT_CACHE_LIMIT = 1_000;

/**
 * Makes `prepare` return the compiled statement of the same SQL again, on this connection. Each
 * caller compiled its SQL on every call: about 5% of the main thread's CPU under load (perf on the
 * production host), and as much as running a long query. A statement can run again with new
 * parameters, and `get`, `all` and `run` reset it, so callers share it. None of them changes a
 * statement's options or iterates one of this connection's statements; a caller that passes options
 * gets a statement of its own. The oldest entry goes first.
 */
export function cacheStatements(db: DatabaseSync): void {
  const compile = db.prepare.bind(db);
  const statements = new Map<string, StatementSync>();
  db.prepare = (sql: string, options?: PrepareOptions): StatementSync => {
    if (options !== undefined) return compile(sql, options);
    const cached = statements.get(sql);
    if (cached) {
      statements.delete(sql);
      statements.set(sql, cached);
      return cached;
    }
    const statement = compile(sql);
    statements.set(sql, statement);
    if (statements.size > STATEMENT_CACHE_LIMIT) {
      const oldest = statements.keys().next();
      if (!oldest.done) statements.delete(oldest.value);
    }
    return statement;
  };
}
