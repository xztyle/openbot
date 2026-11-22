// Checks that an MCP server whose tool schema has a boolean property schema (`"data": true`, which
// JSON Schema permits) can be tested and added (upstream 718cbbdbd). Runs the real MCP probe on a
// stdio server that answers `tools/list` with such a tool. Before, the SDK's `listTools` refused the
// page, and the test failed with "Invalid input".
// Run: `bun scripts/mcp-boolean-schema-e2e.ts`. Writes .openbot-build/mcp-boolean-schema-e2e/report.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { testMcpServer } from "../src/backend/mcp-probe";

const OUT = resolve(import.meta.dirname, "../.openbot-build/mcp-boolean-schema-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-mcp-boolean-schema-"));
const serverPath = join(root, "server.cjs");

// A stdio MCP server with two tools; the second has a boolean property schema.
const SERVER = `
let buffer = "";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === "initialize")
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "boolean-schema", version: "1" } } });
    else if (message.method === "tools/list")
      write({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "plain", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        { name: "any_data", inputSchema: { type: "object", properties: { data: true } } },
      ] } });
    else write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;

const report: { passed: boolean; toolCount?: number | null; error?: string | null } = { passed: false };
try {
  await writeFile(serverPath, SERVER);
  const result = await Effect.runPromise(
    testMcpServer(
      {
        id: "boolean-schema",
        name: "Boolean schema",
        transport: "stdio",
        enabled: true,
        command: process.execPath,
        args: [serverPath],
        env: [],
        envPassthrough: [],
        workingDirectory: root,
        url: "",
        headers: [],
      },
      20_000,
    ),
  );
  report.toolCount = result.toolCount;
  report.error = result.error;
  report.passed = result.toolCount === 2 && !result.error;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.passed ? 0 : 1);
