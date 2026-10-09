import { createFileRoute } from "@tanstack/solid-router";
import { mcpOAuthCallbackResponse } from "../server/mcp-oauth-callback";

export const Route = createFileRoute("/mcp-auth")({ server: { handlers: { GET: mcpOAuthCallbackResponse } } });
