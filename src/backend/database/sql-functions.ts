import type { DatabaseSync } from "node:sqlite";

/**
 * A SQL function that turns each run of whitespace into one space. Search uses it so that a query
 * with a space finds a message that a line break splits.
 */
export const COLLAPSE_WHITESPACE_FUNCTION = "openbot_collapse_whitespace";

/**
 * A SQL function that lowercases text with the full Unicode rules. SQLite `LOWER` changes only
 * ASCII letters, so "État" would not match the query "état".
 */
export const LOWERCASE_FUNCTION = "openbot_lowercase";

/**
 * Adds the application's SQL functions to one connection. The main connection and each read worker
 * connection add the same ones, so a query reads the same on both. Imports only `node:sqlite` types:
 * the read worker loads this file.
 */
export function registerSqlFunctions(db: DatabaseSync): void {
  db.function(COLLAPSE_WHITESPACE_FUNCTION, { deterministic: true }, (value) =>
    typeof value === "string" ? value.replace(/\s+/gu, " ") : value,
  );
  db.function(LOWERCASE_FUNCTION, { deterministic: true }, (value) =>
    typeof value === "string" ? value.toLocaleLowerCase() : value,
  );
}
