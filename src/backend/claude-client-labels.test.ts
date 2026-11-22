// @vitest-environment node

import { describe, expect, it } from "vitest";
import { claudeAgentQueryOptions, withClaudeClientLabels } from "./claude-client";

// Without an entrypoint the SDK labels each request `sdk-ts`, which the 5-hour window counts about twice.
describe("Claude client labels", () => {
  it("names Atelier on a plan sign-in and keeps the Artifact tools off", () => {
    const env = claudeAgentQueryOptions({ developerInstructions: "" }).env;
    expect(env).toMatchObject({ CLAUDE_CODE_ENTRYPOINT: "openbot", CLAUDE_CODE_ARTIFACT: "0" });
    expect(withClaudeClientLabels({ PATH: "/bin" })).toMatchObject({ CLAUDE_CODE_ENTRYPOINT: "openbot" });
  });

  it("keeps the SDK label on an API key, and a label that the server sets", () => {
    expect(withClaudeClientLabels({ ANTHROPIC_API_KEY: "key" }).CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
    expect(withClaudeClientLabels({ CLAUDE_CODE_ENTRYPOINT: "custom" }).CLAUDE_CODE_ENTRYPOINT).toBe("custom");
  });
});
