import { describe, expect, it } from "vitest";
import { removeClaudeCodeSessionEnvironment } from "./claude-session-environment";
import { hostSecret, takeHostSecretEnvironment } from "./host-secret-environment";

describe("takeHostSecretEnvironment", () => {
  it("moves the Motion events secret out of the environment that children inherit", () => {
    const environment: NodeJS.ProcessEnv = { OPENBOT_MOTION_EVENTS_SECRET: " s3cret ", PATH: "/usr/bin" };
    takeHostSecretEnvironment(environment);
    expect(environment).toEqual({ PATH: "/usr/bin" });
    expect(hostSecret("OPENBOT_MOTION_EVENTS_SECRET")).toBe("s3cret");
  });
});

describe("removeClaudeCodeSessionEnvironment", () => {
  it("removes the variables of a Claude Code session and keeps the user's sign-in", () => {
    const environment: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "id",
      CLAUDE_CODE_HOST_PORT: "1",
      CLAUDE_CODE_HOST_CREDS_FILE: "/creds",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      AI_AGENT: "claude-code/2",
    };
    removeClaudeCodeSessionEnvironment(environment);
    expect(environment).toEqual({ CLAUDE_CODE_HOST_CREDS_FILE: "/creds", CLAUDE_CODE_OAUTH_TOKEN: "token" });
  });
});
