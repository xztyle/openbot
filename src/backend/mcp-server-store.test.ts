// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCauseEffect } from "./effect-boundary";
import { McpServerStore } from "./mcp-server-store";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), "openbot-mcp-store-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  // A hand-edited or older database can hold what the table checks now refuse.
  database.connection.exec("PRAGMA ignore_check_constraints = ON");
  const warnings: unknown[] = [];
  const store = new McpServerStore(database, { warn: (...args: unknown[]) => warnings.push(args) });
  return { database, store, warnings };
}

const draft = (name: string) => ({
  id: "",
  name,
  transport: "http" as const,
  enabled: true,
  command: "",
  args: [],
  env: [],
  envPassthrough: [],
  workingDirectory: "",
  url: "https://mcp.example.com/mcp",
  headers: [{ key: "Authorization", value: "Bearer secret" }],
});

// Startup reads this table: one bad row stopped the app from opening (upstream #3643).
describe("an MCP server row that cannot be read", () => {
  it("lists the server turned off with the unreadable column empty", async () => {
    const { database, store, warnings } = await openStore();
    const saved = store.save(draft("Broken"));
    store.save(draft("Fine"));
    database.connection
      .prepare("UPDATE projection_mcp_servers SET headers_json = ? WHERE mcp_server_id = ?")
      .run("{not json", saved.id);

    const list = store.list();
    expect(list.map((server) => server.name)).toEqual(["Broken", "Fine"]);
    expect(list[0]).toMatchObject({ enabled: false, headers: [] });
    expect(list[1]).toMatchObject({ enabled: true });
    store.list();
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain("not json");
  });

  it("leaves out a row whose transport cannot be read, and keeps its name taken", async () => {
    const { database, store } = await openStore();
    const saved = store.save(draft("Gone"));
    database.connection
      .prepare("UPDATE projection_mcp_servers SET transport = 'carrier-pigeon' WHERE mcp_server_id = ?")
      .run(saved.id);

    expect(store.list()).toEqual([]);
    expect(() => store.save(draft("Gone"))).toThrow();
  });

  it("stores the shown row when it is turned on again", async () => {
    const { database, store } = await openStore();
    const saved = store.save(draft("Broken"));
    database.connection
      .prepare("UPDATE projection_mcp_servers SET headers_json = ? WHERE mcp_server_id = ?")
      .run("[1]", saved.id);

    expect(store.setEnabled(saved.id, true)).toMatchObject({ enabled: true, headers: [] });
    expect(store.get(saved.id)).toMatchObject({ enabled: true, headers: [] });
  });
});
