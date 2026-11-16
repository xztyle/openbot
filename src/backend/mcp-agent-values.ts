import type { McpKeyValue, McpServerConfig } from "@openbot/contracts/ipc";
import { registerSecretValue } from "@openbot/logging";

/** The agent an MCP connection is opened for. */
export interface McpAgent {
  id: string;
  name: string;
}

/** Reads one saved key: the agent's own when `agentId` is set and it has one, else the shared key. */
export type McpSecretReader = (
  scope: "agent" | "shared" | "any",
  agentId: string | null,
  name: string,
) => string | null;

const NAME = "[A-Z][A-Z0-9_]{0,63}";
// A whole value that is a link to a key in Secrets, the same form event checks store.
const LINK = new RegExp(`^openbot-secret:(shared|agent)/(${NAME})$`);
const TEMPLATE = new RegExp(`\\{\\{\\s*(agent\\.id|agent\\.name|secret:(?:shared/)?${NAME})\\s*\\}\\}`, "g");

/**
 * Whether a configuration names a key in Secrets or the agent it runs for. Such a row is filled
 * for each agent when it leaves for a provider or a connection, and is stored only as written.
 */
export function mcpConfigIsPersonal(config: McpServerConfig): boolean {
  return [...config.headers, ...config.env].some((pair) => LINK.test(pair.value) || hasTemplate(pair.value));
}

function hasTemplate(value: string): boolean {
  TEMPLATE.lastIndex = 0;
  return TEMPLATE.test(value);
}

/**
 * One configuration with its links and templates filled for `agent`.
 *
 * - `openbot-secret:shared/NAME` or `openbot-secret:agent/NAME` as a whole value is that key.
 * - `{{secret:NAME}}` is the agent's own key, else the shared one; `{{secret:shared/NAME}}` the shared one.
 * - `{{agent.id}}` and `{{agent.name}}` name the agent. In a header the name is percent-encoded,
 *   because a header carries only ASCII. A pair that names the agent is left out when there is none,
 *   such as the Test button, so the server answers as the token's owner.
 *
 * Answers null when a named key is missing: the connection would only fail, so it is not offered.
 */
export function personalizeMcpConfig(
  config: McpServerConfig,
  agent: McpAgent | null,
  secret: McpSecretReader,
): McpServerConfig | null {
  if (!mcpConfigIsPersonal(config)) return config;
  let missing = false;
  const fill = (pairs: readonly McpKeyValue[], header: boolean): McpKeyValue[] =>
    pairs.flatMap((pair) => {
      const value = fillValue(pair.value, agent, header, (scope, name) => {
        const found = secret(scope, agent?.id ?? null, name);
        if (found === null) missing = true;
        else registerSecretValue(found);
        return found ?? "";
      });
      return value === null ? [] : [{ key: pair.key, value }];
    });
  const filled = { ...config, headers: fill(config.headers, true), env: fill(config.env, false) };
  return missing ? null : filled;
}

function fillValue(
  value: string,
  agent: McpAgent | null,
  header: boolean,
  secret: (scope: "agent" | "shared" | "any", name: string) => string,
): string | null {
  const link = LINK.exec(value);
  if (link?.[1] && link[2]) return secret(link[1] === "shared" ? "shared" : "agent", link[2]);
  let withoutAgent = false;
  const filled = value.replace(TEMPLATE, (_match, token: string) => {
    if (token === "agent.id" || token === "agent.name") {
      if (!agent) {
        withoutAgent = true;
        return "";
      }
      if (token === "agent.id") return agent.id;
      return header ? encodeURIComponent(agent.name) : agent.name;
    }
    const name = token.slice("secret:".length);
    return name.startsWith("shared/") ? secret("shared", name.slice("shared/".length)) : secret("any", name);
  });
  return withoutAgent ? null : filled;
}
