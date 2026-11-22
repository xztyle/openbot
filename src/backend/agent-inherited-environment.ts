/**
 * The part of main's environment that a provider process, and so every command an agent runs, starts
 * from. OpenBot's own values for an agent (its provider variables, the agent display, the CPU limit)
 * are added on top by each client, so they are not listed here.
 *
 * On a desktop the environment is the user's own shell, which the agent works in for the user: it
 * stays whole. On a server it is the environment of the service or the container, which an operator
 * filled for OpenBot, not for agents, so only the names below pass: the system basics, the locale,
 * proxies and certificates, git, and the variables that the provider CLIs read for their sign-in and
 * endpoints. The host's own secrets already left the environment at start
 * (`src/main/host-secret-environment.ts`).
 */

const SERVER_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "HOSTNAME",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  // The keyring of the session: Codex, gh and other CLIs can keep their sign-in there.
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "GH_CONFIG_DIR",
  "NO_AT_BRIDGE",
  "FC_FONTATIONS",
  "OPENBOT_SERVER",
  "OPENBOT_HOSTED_SERVER",
  "OPENBOT_AGENT_DISPLAY",
  "OPENBOT_AGENT_PROCESS",
  "OPENBOT_AUTOMATION_DIR",
]);

const SERVER_PREFIXES = [
  "LC_",
  "XDG_",
  "GIT_",
  // Provider sign-in, endpoints and settings.
  "ANTHROPIC_",
  "CLAUDE_",
  "CODEX_",
  "OPENAI_",
  "AZURE_OPENAI_",
  "XAI_",
  "GROK_",
  "GEMINI_",
  "GOOGLE_",
  "VERTEX_",
  "CLOUD_ML_",
  "AWS_",
  "OPENCODE_",
  "OPENROUTER_",
  "DEEPSEEK_",
  "MUSE_",
  "OLLAMA_",
  "PLAYWRIGHT_",
];

/** True on a self-hosted, container or hosted server, where the environment is the operator's. */
export function isServerEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.OPENBOT_SERVER === "1" || environment.OPENBOT_HOSTED_SERVER === "1";
}

export function agentInheritedEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!isServerEnvironment(environment)) return { ...environment };
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (SERVER_NAMES.has(name) || SERVER_PREFIXES.some((prefix) => name.startsWith(prefix))) kept[name] = value;
  }
  return kept;
}
