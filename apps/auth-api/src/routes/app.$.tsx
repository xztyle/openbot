import { createFileRoute } from "@tanstack/solid-router";

/**
 * A place in the web client, such as `/app/<space>/c/<channel>/t/<thread>`. The `/app` route above
 * draws the client and gives its head and headers; the client reads the rest of the path itself
 * (`src/renderer/src/features/web-client/web-location.ts`). Without this route a reload of such an
 * address would answer 404.
 */
export const Route = createFileRoute("/app/$")({});
