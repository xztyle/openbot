/**
 * The host route that the Motion board posts its ticket events to: `POST /v1/motion/events` on the
 * address of `OPENBOT_MOTION_EVENTS_LISTEN` (`host:port`, for example the host's address on the
 * private network that Motion shares with it). It answers only a request that Motion signed with the
 * shared secret (`OPENBOT_MOTION_EVENTS_SECRET` in the host environment, never an agent key), within five
 * minutes of its timestamp. Without a secret it refuses every request. A request reaches the service
 * only after the check, so a stranger on the network can neither wake an agent nor learn anything
 * but the status code.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readBodyWithin } from "../http-body";
import { decodeMotionEvent, MOTION_EVENT_BODY_LIMIT, type MotionEvent, verifyMotionSignature } from "./motion-event";
import type { MotionEventOutcome } from "./motion-events-service";

export const MOTION_EVENTS_PATH = "/v1/motion/events";

export interface MotionEventsServerOptions {
  /** `host:port`. */
  listen: string;
  secret: () => string | null;
  receive: (event: MotionEvent) => Promise<MotionEventOutcome>;
  log: (message: string) => void;
}

/** `host:port`, or null when the value is not one. */
export function parseListenAddress(value: string | undefined): { host: string; port: number } | null {
  const match = /^\[?([0-9A-Za-z.:-]+?)\]?:(\d{1,5})$/u.exec(value?.trim() ?? "");
  const port = Number(match?.[2]);
  return match?.[1] && port >= 0 && port < 65_536 ? { host: match[1], port } : null;
}

function answer(
  response: ServerResponse,
  status: number,
  body: MotionEventOutcome | { error: string } | { outcome: "ignored" },
): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function handle(options: MotionEventsServerOptions, request: IncomingMessage, response: ServerResponse) {
  if ((request.url ?? "").split("?")[0] !== MOTION_EVENTS_PATH) return answer(response, 404, { error: "not_found" });
  if (request.method !== "POST") return answer(response, 405, { error: "method_not_allowed" });
  const secret = options.secret();
  if (!secret) return answer(response, 503, { error: "not_configured" });
  const body = await readBodyWithin(request, MOTION_EVENT_BODY_LIMIT);
  if (!body) return answer(response, 413, { error: "too_large" });
  const header = (name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const refusal = verifyMotionSignature(secret, header("x-motion-timestamp"), header("x-motion-signature"), body);
  if (refusal) {
    options.log(`Refused a Motion event: ${refusal}.`);
    return answer(response, 401, { error: refusal });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return answer(response, 400, { error: "invalid_json" });
  }
  const event = decodeMotionEvent(parsed);
  // An event type of a newer Motion is accepted and dropped, so Motion does not retry it.
  if (!event) return answer(response, 202, { outcome: "ignored" });
  const outcome = await options.receive(event);
  options.log(
    `Motion event ${event.type} ${event.issue.key}: ${outcome.outcome}, ${outcome.deliveries.length} deliveries.`,
  );
  return answer(response, 200, outcome);
}

/** Listens, or rejects when the address cannot be bound. */
export function startMotionEventsServer(options: MotionEventsServerOptions): Promise<Server> {
  const address = parseListenAddress(options.listen);
  if (!address) return Promise.reject(new Error("OPENBOT_MOTION_EVENTS_LISTEN is not host:port."));
  const server = createServer((request, response) => {
    handle(options, request, response).catch(() => {
      if (!response.headersSent) answer(response, 500, { error: "failed" });
    });
  });
  server.requestTimeout = 15_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address.port, address.host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
