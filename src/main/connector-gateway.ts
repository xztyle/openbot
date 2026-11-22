import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import type { OwnerMcpServer } from "./owner-mcp-server";
import type { WebhookInbox } from "./webhook-inbox";

const logger = createOpenBotLogger("connector-gateway");

/** `host:port`, such as `127.0.0.1:8452`, or `0.0.0.0:8452` behind the operator's HTTPS proxy. */
export const CONNECTOR_LISTEN_ENV = "OPENBOT_CONNECTOR_LISTEN";
/** The public HTTPS address of the gateway, such as `https://connect.example.com`, for settings to show. */
export const CONNECTOR_PUBLIC_URL_ENV = "OPENBOT_CONNECTOR_PUBLIC_URL";

export interface ConnectorGatewayConfig {
  host: string;
  port: number;
  publicUrl: string | null;
}

/** The gateway's address from the environment, or null when the operator did not set one. */
export function connectorGatewayConfig(env: NodeJS.ProcessEnv = process.env): ConnectorGatewayConfig | null {
  const match = /^([0-9a-fA-F.:]+|localhost):(\d{1,5})$/u.exec(env[CONNECTOR_LISTEN_ENV]?.trim() ?? "");
  const port = Number(match?.[2]);
  if (!match?.[1] || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const raw = env[CONNECTOR_PUBLIC_URL_ENV]?.trim();
  let publicUrl: string | null = null;
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost")
        publicUrl = url.toString().replace(/\/+$/u, "");
    } catch {
      logger.warn(`${CONNECTOR_PUBLIC_URL_ENV} is not a URL.`);
    }
  }
  return { host: match[1], port, publicUrl };
}

/**
 * The host's one inbound HTTP door for outside systems: the owner's MCP endpoint (`/mcp`) and the
 * webhook inboxes (`/hooks/<route id>`). The operator turns it on with `OPENBOT_CONNECTOR_LISTEN`
 * and puts an HTTPS proxy in front. Every path authenticates on its own: a token for MCP, the
 * sender's signature for a hook. Anything else is 404.
 */
export class ConnectorGateway {
  readonly #config: ConnectorGatewayConfig | null;
  readonly #mcp: Pick<OwnerMcpServer, "handle">;
  readonly #inbox: Pick<WebhookInbox, "handle">;
  #server: Server | null = null;

  constructor(options: {
    config: ConnectorGatewayConfig | null;
    mcp: Pick<OwnerMcpServer, "handle">;
    inbox: Pick<WebhookInbox, "handle">;
  }) {
    this.#config = options.config;
    this.#mcp = options.mcp;
    this.#inbox = options.inbox;
  }

  /** The public base address, when the gateway listens and the operator named it. */
  publicUrl(): string | null {
    return this.#server ? (this.#config?.publicUrl ?? null) : null;
  }

  listening(): boolean {
    return this.#server !== null;
  }

  async start(): Promise<void> {
    const config = this.#config;
    if (!config || this.#server) return;
    const server = createServer((request, response) => void this.#route(request, response));
    // A slow sender cannot hold a socket open for long.
    server.requestTimeout = 60_000;
    server.headersTimeout = 15_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      this.#server = server;
      logger.info(`The connector gateway listens on ${config.host}:${config.port}.`);
    } catch (error) {
      logger.warn("The connector gateway could not listen.", toLogValue(error));
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/mcp" || path.startsWith("/mcp/")) return this.#mcp.handle(request, response);
    if (path.startsWith("/hooks/")) return this.#inbox.handle(request, response);
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  }
}
