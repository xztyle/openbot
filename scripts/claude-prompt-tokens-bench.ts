// Measures what one Claude agent request costs before the conversation: the system prompt (Claude
// Code's own text plus OpenBot's developer instructions), the tool definitions, and the first user
// message. The real Claude CLI sends one turn to a local fake Messages API, which records the
// request, so the count is what the model gets. No account or key is used.
//
// `bun scripts/claude-prompt-tokens-bench.ts [--claude <cli>] [--config <dir>] [--workspace <dir>]`
//   --claude     the Claude CLI to run (default: the SDK's bundled CLI)
//   --config     a Claude config folder to copy (settings.json, skills, CLAUDE.md), such as a copy of
//                the server's ~/.claude without its credentials and projects
//   --workspace  an agent workspace to copy (its .claude/skills, CLAUDE.md)
// Writes .openbot-build/claude-prompt-tokens-bench/report.json and prints a summary.
//
// Tokens are estimated: Claude's tokenizer is not public. The estimate is bytes / 3.6 for prose and
// bytes / 3.0 for JSON schemas, which matched the first-turn cache writes of the server's Sonnet
// agents within about 5%. The bytes are exact.
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { type AgentMemory, type AgentSummary, DEFAULT_AGENT_DEFAULTS } from "@openbot/contracts/ipc";
import { developerInstructions, memoryContext, memoryContextUpdate } from "../src/backend/agent/developer-instructions";
import { claudeAgentQueryOptions, claudeOpenBotServer } from "../src/backend/claude-client";

const OUT = resolve(import.meta.dirname, "../.openbot-build/claude-prompt-tokens-bench");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const proseTokens = (bytes: number) => Math.round(bytes / 3.6);
const schemaTokens = (bytes: number) => Math.round(bytes / 3.0);
const bytes = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));

const agent: AgentSummary = {
  id: "agent-1",
  name: "Ana",
  title: "Growth marketer",
  description: "Runs the paid ads and the weekly growth report for the shop.",
  notifications: true,
  provider: "claude",
  model: "claude-sonnet-5-5",
  reasoningEffort: "medium",
  threadId: null,
  workspacePath: "/workspace",
  preview: "",
  updatedAt: null,
  avatarSeed: "agent-1",
  avatarHue: null,
  avatarUrl: null,
};

/** The options that `ThreadLifecycle.#instructions` passes for a typical agent on the server. */
const instructionOptions = {
  computerUseInOwnChat: false,
  passwordVault: false,
  vaultItems: { available: true, cards: false, contacts: true },
  serverHost: true,
  storedMemoryCount: 3,
  memoriesInTurns: true,
  teammatesInTurns: true,
  sectionTeammates: {
    name: "Growth",
    members: [
      { id: "agent-2", name: "Ben", title: "Designer" },
      { id: "agent-3", name: "Cleo", title: "Copywriter" },
    ],
  },
  spaceName: "Shop",
  homeSkills: [],
  workBoard: true,
};

function memory(id: string, text: string): AgentMemory {
  const at = "2026-11-01T00:00:00.000Z";
  return { id, agentId: agent.id, text, origin: "manual", sourceTurnId: null, createdAt: at, updatedAt: at };
}

interface Recorded {
  path: string;
  model: string;
  system: string;
  tools: Array<{ name: string; defer_loading?: boolean; [key: string]: unknown }>;
  firstUser: string;
  body: number;
}

function startFakeModel() {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (!request.url?.startsWith("/v1/messages") || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body || "{}");
      if (request.url.startsWith("/v1/messages/count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const system = Array.isArray(parsed.system)
        ? parsed.system.map((part: { text?: string }) => part.text ?? "").join("\n")
        : String(parsed.system ?? "");
      const first = parsed.messages?.[0];
      const firstUser =
        typeof first?.content === "string"
          ? first.content
          : (first?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("\n");
      requests.push({
        path: request.url,
        model: parsed.model,
        system,
        tools: parsed.tools ?? [],
        firstUser,
        body: Buffer.byteLength(body),
      });
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: parsed.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  return new Promise<{ url: string; requests: Recorded[]; close: () => void }>((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port.");
      done({ url: `http://127.0.0.1:${address.port}`, requests, close: () => server.close() });
    });
  });
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "claude-prompt-bench-"));
  const config = join(root, "config");
  const workspace = join(root, "workspace");
  await mkdir(config, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const configSource = argument("config");
  if (configSource) await cp(configSource, config, { recursive: true });
  const workspaceSource = argument("workspace");
  if (workspaceSource) await cp(workspaceSource, workspace, { recursive: true });
  const model = await startFakeModel();
  const instructions = developerInstructions(
    { ...agent, workspacePath: workspace },
    "/shared",
    [],
    "/automation",
    DEFAULT_AGENT_DEFAULTS,
    instructionOptions,
  );
  const memories = memoryContextUpdate(
    null,
    memoryContext(
      [
        memory("m1", "The shop sells handmade ceramics; the ad budget is 40 EUR a day."),
        memory("m2", "The user wants the weekly report on Monday 9:00 Madrid time."),
      ],
      { storedMemoryCount: 3 },
    ),
  );
  try {
    const options = claudeAgentQueryOptions({ developerInstructions: instructions });
    const run = query({
      prompt: `${memories}\n\nHi, what can you do?`,
      options: {
        ...options,
        cwd: workspace,
        ...(argument("claude") ? { pathToClaudeCodeExecutable: argument("claude") } : {}),
        model: "claude-sonnet-4-5",
        mcpServers: { openbot: claudeOpenBotServer(async () => ({ content: [] })) },
        persistSession: false,
        maxTurns: 1,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          CLAUDE_CONFIG_DIR: config,
          ANTHROPIC_BASE_URL: model.url,
          ANTHROPIC_API_KEY: "sk-ant-bench",
          // The server signs in with a Claude plan, where tool search is on. A custom base URL turns
          // it off by default, so the bench turns it on to match.
          ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH ?? "true",
          DISABLE_AUTOUPDATER: "1",
          ...options.env,
        },
      },
    });
    for await (const _message of run) {
      // The turn ends after the fake answer.
    }
  } finally {
    model.close();
  }
  const main = model.requests.filter((request) => request.tools.length > 0);
  const turn = main[0];
  if (!turn)
    throw new Error(`The CLI sent no request with tools: ${JSON.stringify(model.requests.map((r) => r.model))}`);
  const loaded = turn.tools.filter((tool) => !tool.defer_loading);
  const deferred = turn.tools.filter((tool) => tool.defer_loading);
  const builtIn = loaded.filter((tool) => !tool.name.startsWith("mcp__"));
  const openbotLoaded = loaded.filter((tool) => tool.name.startsWith("mcp__openbot__"));
  const claudeCodeSystem = turn.system.replace(instructions, "");
  const report = {
    developerInstructions: { bytes: bytes(instructions), tokens: proseTokens(bytes(instructions)) },
    claudeCodeSystem: { bytes: bytes(claudeCodeSystem), tokens: proseTokens(bytes(claudeCodeSystem)) },
    tools: {
      count: turn.tools.length,
      loaded: loaded.length,
      deferred: deferred.length,
      builtInNames: builtIn.map((tool) => tool.name),
      openbotLoadedNames: openbotLoaded.map((tool) => tool.name),
      loadedBytes: bytes(loaded),
      loadedTokens: schemaTokens(bytes(loaded)),
      deferredBytes: bytes(deferred),
    },
    firstUser: { bytes: bytes(turn.firstUser), tokens: proseTokens(bytes(turn.firstUser)) },
    requestBytes: turn.body,
    estimatedPrefixTokens:
      proseTokens(bytes(turn.system)) + schemaTokens(bytes(loaded)) + proseTokens(bytes(turn.firstUser)),
    otherRequests: model.requests
      .filter((request) => request !== turn)
      .map((request) => ({
        model: request.model,
        system: bytes(request.system),
        tools: request.tools.length,
      })),
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(OUT, "system.txt"), turn.system);
  await writeFile(join(OUT, "tools.json"), JSON.stringify(turn.tools, null, 2));
  await writeFile(join(OUT, "first-user.txt"), turn.firstUser);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
