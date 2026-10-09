import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  createMcpServerId,
  isMcpKeyValue,
  isReservedMcpServerName,
  type McpKeyValue,
  type McpServerConfig,
  mcpConfigErrors,
  normalizeMcpConfig,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { databaseRow, databaseRows, requiredStringColumn } from "./database/database-rows";
import { MCP_CATALOG_SUCCESSORS, type McpCatalogSuccessor } from "./mcp-catalog-successors.generated";
import { registerMcpSecretValues } from "./mcp-redaction";
import type { OpenBotDatabase } from "./openbot-database";

/**
 * The MCP server configurations this machine holds.
 *
 * These are written straight to the table, not through `database.dispatch`. A dispatch writes its
 * payload into the append-only `orchestration_events` table, and an MCP configuration carries
 * `Authorization` values and API keys: those must not land in a log that nothing ever deletes.
 * `channel-store.ts` and `database/agent-usage.ts` write directly for the same class of reason.
 *
 * Every write runs `normalizeMcpConfig` - the same function the settings form previews with - so a
 * stored row can never hold something the user was not shown.
 */
/**
 * A configuration the user can correct: a name already in use, the list at its limit, a row that was
 * deleted. Not a broken database, which stays an unexpected failure.
 *
 * The type is what carries the sentence out of the process. A local save reads `error.message` in a
 * toast, but the Team API answers a plain `Error` with a 500 "Request failed." - so a remote
 * administrator was told a duplicate name was a server fault, with nothing to correct it by. The
 * single catch in `team-api-server.ts` classifies by `instanceof`, and this class is what it reads.
 */
export class McpServerError extends Error {}

/**
 * The six sign-in listings as the shipped catalog described them before native OAuth: a stdio
 * row running the third-party `mcp-remote` bridge. The current catalog
 * (`marketplace/plugin-catalog/plugins/<slug>/plugin.json`, generated into
 * `marketplace-plugin-catalog.ts`) reaches the same servers over native http instead.
 *
 * A row installed from one of these still names the server, so the marketplace reads it as
 * installed and offers no way back in - while the bridge it runs no longer signs in. The migration
 * below rewrites exactly these rows.
 */
const MCP_REMOTE_BRIDGES: ReadonlyArray<{ name: string; remoteUrl: string; url: string }> = [
  { name: "canva", remoteUrl: "https://mcp.canva.com/mcp", url: "https://mcp.canva.com/mcp" },
  { name: "linear", remoteUrl: "https://mcp.linear.app/sse", url: "https://mcp.linear.app/mcp" },
  { name: "notion", remoteUrl: "https://mcp.notion.com/mcp", url: "https://mcp.notion.com/mcp" },
  { name: "figma", remoteUrl: "https://mcp.figma.com/mcp", url: "https://mcp.figma.com/mcp" },
  { name: "sentry", remoteUrl: "https://mcp.sentry.dev/mcp", url: "https://mcp.sentry.dev/mcp" },
  { name: "stripe", remoteUrl: "https://mcp.stripe.com", url: "https://mcp.stripe.com" },
];

const MCP_REMOTE_ARGS = (remoteUrl: string): string[] => ["-y", "mcp-remote@latest", remoteUrl];

export class McpServerStore {
  constructor(private readonly database: OpenBotDatabase) {}

  list(): McpServerConfig[] {
    return databaseRows(
      this.database.connection.prepare("SELECT * FROM projection_mcp_servers ORDER BY position, mcp_server_id").all(),
    ).map(toConfig);
  }

  listEnabled(): McpServerConfig[] {
    return this.list().filter((config) => config.enabled);
  }

  get(mcpServerId: string): McpServerConfig | null {
    const row = databaseRow(
      this.database.connection.prepare("SELECT * FROM projection_mcp_servers WHERE mcp_server_id = ?").get(mcpServerId),
    );
    return row ? toConfig(row) : null;
  }

  /** Inserts or replaces one configuration and answers the stored form of it. */
  save(config: McpServerConfig, now = new Date().toISOString()): McpServerConfig {
    const normalized = normalizeMcpConfig(config);
    const errors = mcpConfigErrors(normalized);
    const firstError = errors.name ?? errors.command ?? errors.url;
    if (firstError) throw new McpServerError(firstError);

    const db = this.database.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = normalized.id ? this.get(normalized.id) : null;
      const newAccount = /^mcpacct-[a-f0-9-]{36}$/.test(normalized.id);
      if (normalized.id && !existing && !newAccount)
        throw new McpServerError(sourceText("error.backend.mcpServerGone"));
      if (!existing && this.count() >= INPUT_LIMITS.mcpServers)
        throw new McpServerError(sourceText("error.backend.mcpServerLimit", { limit: INPUT_LIMITS.mcpServers }));
      // Reported here rather than left to the unique index, so the user reads a sentence.
      if (this.nameTaken(normalized.name, existing?.id ?? null))
        throw new McpServerError(sourceText("error.backend.mcpServerNameTaken", { name: normalized.name }));

      // A draft carries an empty id, which is not nullish - `??` would store the empty string.
      const stored: McpServerConfig = {
        ...normalized,
        id: existing?.id || (newAccount ? normalized.id : createMcpServerId()),
      };
      db.prepare(
        `INSERT INTO projection_mcp_servers (
           mcp_server_id, name, transport, enabled, command, args_json, env_json, env_passthrough_json,
           working_directory, url, headers_json, position, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mcp_server_id) DO UPDATE SET
           name = excluded.name,
           transport = excluded.transport,
           enabled = excluded.enabled,
           command = excluded.command,
           args_json = excluded.args_json,
           env_json = excluded.env_json,
           env_passthrough_json = excluded.env_passthrough_json,
           working_directory = excluded.working_directory,
           url = excluded.url,
           headers_json = excluded.headers_json,
           updated_at = excluded.updated_at`,
      ).run(
        stored.id,
        stored.name,
        stored.transport,
        stored.enabled ? 1 : 0,
        stored.command,
        JSON.stringify(stored.args),
        JSON.stringify(stored.env),
        JSON.stringify(stored.envPassthrough),
        stored.workingDirectory,
        stored.url,
        JSON.stringify(stored.headers),
        existing ? this.positionOf(stored.id) : this.nextPosition(),
        now,
        now,
      );
      db.exec("COMMIT");
      return stored;
    } catch (error) {
      // SQLite may have rolled back already, and a second ROLLBACK would replace the error that did it.
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  remove(mcpServerId: string): void {
    this.database.connection.prepare("DELETE FROM projection_mcp_servers WHERE mcp_server_id = ?").run(mcpServerId);
  }

  setEnabled(mcpServerId: string, enabled: boolean, now = new Date().toISOString()): McpServerConfig {
    const current = this.get(mcpServerId);
    if (!current) throw new McpServerError("This MCP server no longer exists.");
    this.database.connection
      .prepare("UPDATE projection_mcp_servers SET enabled = ?, updated_at = ? WHERE mcp_server_id = ?")
      .run(enabled ? 1 : 0, now, mcpServerId);
    return { ...current, enabled };
  }

  /**
   * Converts rows installed from the old catalog's `mcp-remote` bridge definitions to the native
   * http rows the current catalog installs, and answers how many rows changed.
   *
   * Only a row that still matches a shipped definition exactly - name, stdio transport, `npx`,
   * and the bridge arguments - is converted. A renamed row cannot be told apart from one the user
   * wrote by hand, and changed arguments are the user's own edits: both stay as they are. Every
   * other column (id, enabled state, position, credentials, working directory) is kept, so the
   * row the user sees is the row they had, reaching its server natively. The converted row holds
   * no sign-in yet; Sign in on it opens the browser like any new installation.
   *
   * This is a data rewrite rather than a schema migration: no DDL changes, and running it again
   * converts nothing, so it runs on every startup rather than behind a schema version.
   */
  migrateCatalogBridgesToHttp(now = new Date().toISOString()): number {
    const db = this.database.connection;
    let converted = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = databaseRows(
        db.prepare("SELECT mcp_server_id, name, transport, command, args_json FROM projection_mcp_servers").all(),
      );
      for (const row of rows) {
        const bridge = MCP_REMOTE_BRIDGES.find(
          (candidate) =>
            row.name === candidate.name &&
            row.transport === "stdio" &&
            row.command === "npx" &&
            isStringList(row.args_json, MCP_REMOTE_ARGS(candidate.remoteUrl)),
        );
        if (!bridge) continue;
        db.prepare(
          `UPDATE projection_mcp_servers
             SET transport = 'http', command = '', args_json = '[]', url = ?, updated_at = ?
             WHERE mcp_server_id = ?`,
        ).run(bridge.url, now, requiredStringColumn(row, "mcp_server_id"));
        converted += 1;
      }
      db.exec("COMMIT");
      return converted;
    } catch (error) {
      // SQLite may have rolled back already, and a second ROLLBACK would replace the error that did it.
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Moves a row of an older catalog release to the current listing, and answers how many rows changed.
   *
   * The catalog lists, for each app, the exact commands or addresses that earlier releases of the
   * listing used. A row is moved only when it still holds one of them word for word, and when it is
   * the app's row: it has the listing's name, or it is an account row (`mcpacct-` id), whose name the
   * user chose. A row with any other word is the user's own edit and stays as it is. Only the words
   * that say how the server is reached change. The id, the name, the credentials, the enabled state and
   * the position stay, so the chat grants of the row (which name the id) and its sign-in stay too.
   *
   * Like the bridge conversion above this is a data rewrite, not a schema migration, and it converts
   * nothing when it runs again.
   */
  migrateCatalogSuccessors(
    successors: readonly McpCatalogSuccessor[] = MCP_CATALOG_SUCCESSORS,
    now = new Date().toISOString(),
  ): number {
    if (successors.length === 0) return 0;
    const db = this.database.connection;
    let moved = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = databaseRows(
        db.prepare("SELECT mcp_server_id, name, transport, command, args_json, url FROM projection_mcp_servers").all(),
      );
      for (const row of rows) {
        const id = requiredStringColumn(row, "mcp_server_id");
        const successor = successors.find(
          (candidate) =>
            (row.name === candidate.serverName || id.startsWith("mcpacct-")) &&
            row.transport === candidate.transport &&
            (candidate.transport === "http"
              ? row.url === candidate.from.url
              : row.command === candidate.from.command && isStringList(row.args_json, candidate.from.args)),
        );
        if (!successor) continue;
        if (successor.transport === "http")
          db.prepare("UPDATE projection_mcp_servers SET url = ?, updated_at = ? WHERE mcp_server_id = ?").run(
            successor.to.url,
            now,
            id,
          );
        else
          db.prepare(
            "UPDATE projection_mcp_servers SET command = ?, args_json = ?, updated_at = ? WHERE mcp_server_id = ?",
          ).run(successor.to.command, JSON.stringify(successor.to.args), now, id);
        moved += 1;
      }
      db.exec("COMMIT");
      return moved;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  private count(): number {
    return this.list().length;
  }

  private nameTaken(name: string, exceptId: string | null): boolean {
    if (isReservedMcpServerName(name)) return true;
    return this.list().some((config) => config.name === name && config.id !== exceptId);
  }

  private positionOf(mcpServerId: string): number {
    const index = this.list().findIndex((config) => config.id === mcpServerId);
    return index < 0 ? this.nextPosition() : index;
  }

  private nextPosition(): number {
    return this.list().length;
  }
}

/**
 * A row becomes a configuration only if every parsed value is the shape the spawn expects. A
 * hand-edited database must not be able to put a non-string into a child process environment.
 */
// Every read goes through here, so each stored secret is masked in logs before any caller can
// pass it to a provider or quote it in an error.
function toConfig(row: DynamicRecord): McpServerConfig {
  const transport = requiredStringColumn(row, "transport");
  if (transport !== "stdio" && transport !== "http") throw new Error("Invalid SQLite column transport.");
  const config: McpServerConfig = {
    id: requiredStringColumn(row, "mcp_server_id"),
    name: requiredStringColumn(row, "name"),
    transport,
    enabled: row.enabled === 1,
    command: requiredStringColumn(row, "command"),
    args: parseStrings(row, "args_json"),
    env: parsePairs(row, "env_json"),
    envPassthrough: parseStrings(row, "env_passthrough_json"),
    workingDirectory: requiredStringColumn(row, "working_directory"),
    url: requiredStringColumn(row, "url"),
    headers: parsePairs(row, "headers_json"),
  };
  registerMcpSecretValues(config);
  return config;
}

// A hand-edited database is untrusted input: a non-string here would reach a spawn's `env`, so
// every parsed column goes through a guard rather than being believed.
function parseStrings(row: DynamicRecord, key: string): string[] {
  return decodeStringList(JSON.parse(requiredStringColumn(row, key)), key);
}

function parsePairs(row: DynamicRecord, key: string): McpKeyValue[] {
  return decodePairList(JSON.parse(requiredStringColumn(row, key)), key);
}

function decodeStringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every(isString)) throw new Error(`Invalid SQLite column ${key}.`);
  return value;
}

/** Whether a JSON column holds exactly the strings expected. A hand-edited value never matches. */
function isStringList(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  return (
    Array.isArray(parsed) &&
    parsed.length === expected.length &&
    parsed.every((item, index) => item === expected[index])
  );
}

function decodePairList(value: unknown, key: string): McpKeyValue[] {
  if (!Array.isArray(value) || !value.every(isMcpKeyValue)) throw new Error(`Invalid SQLite column ${key}.`);
  return value;
}
