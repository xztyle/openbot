// @vitest-environment node
import { expect, it } from "vitest";
import { redactMcpResult } from "./mcp-result-redaction";

it("masks header credentials in structured data and nested MCP JSON text without changing result shape", () => {
  const secret = 'tenant"abc\\def';
  const value = {
    structuredContent: { note: secret },
    content: [{ type: "text", text: JSON.stringify({ note: secret, nested: JSON.stringify({ secret }) }) }],
  };
  const redacted = redactMcpResult(value, [secret]);
  expect(redacted).toEqual({
    structuredContent: { note: "•••" },
    content: [{ type: "text", text: JSON.stringify({ note: "•••", nested: JSON.stringify({ secret: "•••" }) }) }],
  });
  expect(JSON.stringify(redacted)).not.toContain("tenant");
});
