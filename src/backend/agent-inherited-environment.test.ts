import { describe, expect, it } from "vitest";
import { agentInheritedEnvironment } from "./agent-inherited-environment";

describe("agentInheritedEnvironment", () => {
  it("keeps the whole environment on a desktop", () => {
    const environment = { PATH: "/usr/bin", JAVA_HOME: "/opt/java", OPENBOT_AUTH_API_URL: "https://x" };
    expect(agentInheritedEnvironment(environment)).toEqual(environment);
  });

  it("passes only the listed names on a server", () => {
    expect(
      agentInheritedEnvironment({
        OPENBOT_SERVER: "1",
        PATH: "/usr/bin",
        HOME: "/data",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_COUNT: "1",
        ANTHROPIC_BASE_URL: "https://proxy",
        CLAUDE_CODE_OAUTH_TOKEN: "token",
        HTTPS_PROXY: "http://proxy",
        OPENBOT_AGENT_DISPLAY: ":1",
        OPENBOT_AUTH_API_URL: "https://auth",
        OPENBOT_MCP_REMOTE_CALLBACK_URL: "https://callback",
        DATABASE_URL: "postgres://secret",
        STRIPE_SECRET_KEY: "sk_live",
      }),
    ).toEqual({
      OPENBOT_SERVER: "1",
      PATH: "/usr/bin",
      HOME: "/data",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_COUNT: "1",
      ANTHROPIC_BASE_URL: "https://proxy",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      HTTPS_PROXY: "http://proxy",
      OPENBOT_AGENT_DISPLAY: ":1",
    });
  });
});
