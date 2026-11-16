import type { McpServerConfig } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { type McpSecretReader, mcpConfigIsPersonal, personalizeMcpConfig } from "./mcp-agent-values";

const row = (headers: Array<[string, string]>, env: Array<[string, string]> = []): McpServerConfig => ({
  id: "mcp-1",
  name: "motion",
  transport: "http",
  enabled: true,
  command: "",
  args: [],
  env: env.map(([key, value]) => ({ key, value })),
  envPassthrough: [],
  workingDirectory: "",
  url: "http://motion/mcp",
  headers: headers.map(([key, value]) => ({ key, value })),
});

const keys: Record<string, string> = { "shared/MOTION_TOKEN": "mt_shared", "agent-1/MOTION_TOKEN": "mt_own" };
const secret: McpSecretReader = (scope, agentId, name) => {
  const own = scope !== "shared" && agentId ? keys[`${agentId}/${name}`] : undefined;
  return own ?? (scope === "agent" ? null : (keys[`shared/${name}`] ?? null));
};
const agent = {
  id: "agent-1",
  name: "Diseñador de Curso",
  space: { id: "54e4359b", name: "Universidad Online", slug: "universidad-online" },
};

describe("personalizeMcpConfig", () => {
  it("leaves a plain row as stored", () => {
    const config = row([["Authorization", "Bearer x"]]);
    expect(mcpConfigIsPersonal(config)).toBe(false);
    expect(personalizeMcpConfig(config, agent, secret)).toBe(config);
  });

  it("fills secrets and the agent, percent-encoding the name in headers", () => {
    const config = row(
      [
        ["Authorization", "Bearer {{secret:shared/MOTION_TOKEN}}"],
        ["X-Motion-Agent", "{{agent.id}}"],
        ["X-Motion-Agent-Name", "{{agent.name}}"],
      ],
      [["TOKEN", "openbot-secret:agent/MOTION_TOKEN"]],
    );
    const filled = personalizeMcpConfig(config, agent, secret);
    expect(filled?.headers).toEqual([
      { key: "Authorization", value: "Bearer mt_shared" },
      { key: "X-Motion-Agent", value: "agent-1" },
      { key: "X-Motion-Agent-Name", value: "Dise%C3%B1ador%20de%20Curso" },
    ]);
    expect(filled?.env).toEqual([{ key: "TOKEN", value: "mt_own" }]);
  });

  it("fills the agent's space, percent-encoding its name in headers", () => {
    const config = row(
      [
        ["X-Motion-Workspace-Key", "{{space.id}}"],
        ["X-Motion-Workspace-Name", "{{ space.name }}"],
      ],
      [["SPACE", "{{space.slug}}/{{space.name}}"]],
    );
    expect(mcpConfigIsPersonal(config)).toBe(true);
    const filled = personalizeMcpConfig(config, agent, secret);
    expect(filled?.headers).toEqual([
      { key: "X-Motion-Workspace-Key", value: "54e4359b" },
      { key: "X-Motion-Workspace-Name", value: "Universidad%20Online" },
    ]);
    expect(filled?.env).toEqual([{ key: "SPACE", value: "universidad-online/Universidad Online" }]);
    expect(personalizeMcpConfig(config, null, secret)?.headers).toEqual([]);
  });

  it("prefers the agent's own key for {{secret:NAME}}", () => {
    const filled = personalizeMcpConfig(row([["Authorization", "Bearer {{secret:MOTION_TOKEN}}"]]), agent, secret);
    expect(filled?.headers[0]?.value).toBe("Bearer mt_own");
  });

  it("drops agent headers when there is no agent", () => {
    const config = row([
      ["Authorization", "Bearer {{secret:MOTION_TOKEN}}"],
      ["X-Motion-Agent", "{{agent.id}}"],
    ]);
    expect(personalizeMcpConfig(config, null, secret)?.headers).toEqual([
      { key: "Authorization", value: "Bearer mt_shared" },
    ]);
  });

  it("answers null when a named key is missing", () => {
    expect(personalizeMcpConfig(row([["Authorization", "openbot-secret:shared/NOPE"]]), agent, secret)).toBeNull();
  });
});
