// Checks the client labels that Atelier gives the Claude CLI (upstream f81e228bc, 0a870950e). Without
// CLAUDE_CODE_ENTRYPOINT the SDK labels each request `sdk-ts`, and Claude's 5-hour window counts
// `sdk-*` requests about twice. A request on an API key keeps `sdk-ts`. Reads the real query options.
// `bun scripts/claude-client-labels-e2e.ts`. Writes .openbot-build/claude-client-labels-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { claudeAgentQueryOptions, withClaudeClientLabels } from "../src/backend/claude-client";

const OUT = resolve(import.meta.dirname, "../.openbot-build/claude-client-labels-e2e");
const report: {
  cases: { name: string; entrypoint: string | undefined; artifact: string | undefined }[];
  passed: boolean;
  error?: string;
} = {
  cases: [],
  passed: false,
};
const record = (name: string, env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined) => {
  report.cases.push({ name, entrypoint: env?.CLAUDE_CODE_ENTRYPOINT, artifact: env?.CLAUDE_CODE_ARTIFACT });
  return env;
};

try {
  const agent = record("agent query", claudeAgentQueryOptions({ developerInstructions: "" }).env);
  assert.equal(agent?.CLAUDE_CODE_ENTRYPOINT, "openbot");
  assert.equal(agent?.CLAUDE_CODE_ARTIFACT, "0");
  const side = record("side call", claudeAgentQueryOptions({ developerInstructions: "", profileGeneration: true }).env);
  assert.equal(side?.CLAUDE_CODE_ENTRYPOINT, "openbot");
  const plan = record("plan sign-in", withClaudeClientLabels({ PATH: "/bin" }));
  assert.equal(plan?.CLAUDE_CODE_ENTRYPOINT, "openbot");
  const key = record("API key", withClaudeClientLabels({ ANTHROPIC_API_KEY: "key" }));
  assert.equal(key?.CLAUDE_CODE_ENTRYPOINT, "sdk-ts");
  const admin = record("server variable", withClaudeClientLabels({ CLAUDE_CODE_ENTRYPOINT: "custom" }));
  assert.equal(admin?.CLAUDE_CODE_ENTRYPOINT, "custom");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
}
