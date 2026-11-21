// Checks that the host's live browser view stays open on a slow link, as a member on a relayed
// WebRTC path has it. It runs the real `BrowserViewGateway` on a local HTTP server. A page source
// sends frames as a busy page does (thirty a second), and the member's side reads the socket the way
// the host's tunnel does: at once, into a pipe that carries a fixed number of bytes a second. The
// member draws each frame when it arrives and acknowledges it, as `BrowserLiveView` does.
//
// Before the view paced its frames on the member's acknowledgements, the loopback socket never
// filled, the tunnel queued every frame, and the gateway closed the view as "fell too far behind"
// after 120 frames. The client then started again and fell behind again.
//
// `bun scripts/browser-view-slow-link-e2e.ts [--seconds=20] [--bytes-per-second=600000]`
// Writes .openbot-build/browser-view-slow-link-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  BROWSER_VIEW_FRAME_ACK_QUERY,
  decodeBrowserViewFrame,
  encodeBrowserViewInput,
} from "@openbot/contracts/team-protocol/browser-view-v1";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import WebSocket from "ws";
import { BrowserViewGateway, type BrowserViewGatewayOptions } from "../src/main/browser-view-gateway";
import { rawDataBytes } from "../src/main/ws-raw-data";

const logger = createOpenBotLogger("browser-view-slow-link-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/browser-view-slow-link-e2e");

function option(name: string, fallback: number): number {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value === undefined ? fallback : Number(value);
}

const SECONDS = option("seconds", 20);
/** About 5 Mbit/s: a TURN relay on a busy mobile link. */
const BYTES_PER_SECOND = option("bytes-per-second", 600_000);
const FRAME_BYTES = 80_000;
const FRAME_INTERVAL_MS = 33;
const TEAM_SESSION = "slow-link-session";

/** A page that changes all the time: one frame of the same size every interval. */
const browser: BrowserViewGatewayOptions["browser"] = {
  startView: (_tabId, onFrame) =>
    Effect.sync(() => {
      let sequence = 0;
      const image = new Uint8Array(FRAME_BYTES).fill(7);
      const timer = setInterval(() => {
        sequence += 1;
        onFrame({ sequence, width: 1280, height: 800, image });
      }, FRAME_INTERVAL_MS);
      return () => Effect.sync(() => clearInterval(timer));
    }),
  dispatchViewInput: () => Effect.void,
  copyViewSelection: () => Effect.succeed(""),
};

/**
 * The tunnel between the host and the member: everything the host's socket gives it goes into one
 * queue, and the queue drains at the link's rate. Nothing is dropped, as the data channel drops nothing.
 */
function createLink(deliver: (data: Buffer) => void) {
  const queue: Buffer[] = [];
  let busyUntil = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pump = () => {
    timer = undefined;
    const next = queue.shift();
    if (!next) return;
    deliver(next);
    const wait = (next.byteLength / BYTES_PER_SECOND) * 1000;
    busyUntil = Math.max(Date.now(), busyUntil) + wait;
    timer = setTimeout(pump, Math.max(0, busyUntil - Date.now()));
  };
  return {
    send(data: Buffer) {
      queue.push(data);
      if (!timer) timer = setTimeout(pump, 0);
    },
    queuedBytes: () => queue.reduce((sum, item) => sum + item.byteLength, 0),
    stop() {
      if (timer) clearTimeout(timer);
      queue.length = 0;
    },
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const gateway = new BrowserViewGateway({ browser, authenticate: () => null });
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (gateway.handlesUpgrade(url)) gateway.handleUpgrade(request, socket, head, url);
    else socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "The server has a port.");
  const port = address.port;

  const session = gateway.createSession({ memberId: "member", teamSessionId: TEAM_SESSION, tabId: "tab-1" });
  const url = `ws://127.0.0.1:${port}${session.streamPath}?${BROWSER_VIEW_FRAME_ACK_QUERY}=1`;
  const socket = new WebSocket(url, { headers: { "x-openbot-webrtc-session": TEAM_SESSION } });

  const startedAt = Date.now();
  let closed: { code: number; reason: string; atMs: number } | null = null;
  let framesDrawn = 0;
  let lastSequence = 0;
  const latencies: number[] = [];
  const sentAt = new Map<number, number>();
  // The host's side of the tunnel reads each frame at once; the member gets it at the link's rate.
  const link = createLink((data) => {
    const frame = decodeBrowserViewFrame(new Uint8Array(data));
    framesDrawn += 1;
    lastSequence = frame.sequence;
    const sent = sentAt.get(frame.sequence);
    if (sent !== undefined) latencies.push(Date.now() - sent);
    // The member's acknowledgement is a few bytes and goes the other way at once.
    if (socket.readyState === WebSocket.OPEN)
      socket.send(encodeBrowserViewInput({ type: "ack", sequence: frame.sequence }));
  });
  socket.on("message", (data, binary) => {
    if (!binary) return;
    const bytes = Buffer.from(rawDataBytes(data));
    sentAt.set(bytes.readUInt32BE(4), Date.now());
    link.send(bytes);
  });
  socket.on("close", (code, reason) => {
    closed = { code, reason: reason.toString(), atMs: Date.now() - startedAt };
  });
  await new Promise<void>((done, fail) => {
    socket.once("open", () => done());
    socket.once("error", fail);
  });

  await new Promise((done) => setTimeout(done, SECONDS * 1000));
  const queuedBytes = link.queuedBytes();
  const openAtEnd = socket.readyState === WebSocket.OPEN;
  socket.close();
  link.stop();
  await Effect.runPromise(gateway.stop());
  server.close();

  const tail = latencies.slice(-30);
  const recentLatencyMs = tail.length ? Math.round(tail.reduce((sum, value) => sum + value, 0) / tail.length) : null;
  const report = {
    seconds: SECONDS,
    bytesPerSecond: BYTES_PER_SECOND,
    frameBytes: FRAME_BYTES,
    framesDrawn,
    lastSequence,
    recentLatencyMs,
    queuedBytesAtEnd: queuedBytes,
    openAtEnd,
    closed,
    passed: false,
  };
  try {
    assert.equal(closed, null, `The view closed: ${JSON.stringify(closed)}`);
    assert.ok(openAtEnd, "The view is open at the end.");
    // The member sees the page's frames, or as many as the link carries when it is slower.
    const expected = Math.min(BYTES_PER_SECOND / FRAME_BYTES, 1000 / FRAME_INTERVAL_MS) * SECONDS;
    assert.ok(framesDrawn > expected * 0.5, `The member saw ${framesDrawn} frames; the link carries ${expected}.`);
    assert.ok(recentLatencyMs !== null && recentLatencyMs < 1_500, `The frames arrive ${recentLatencyMs} ms late.`);
    report.passed = true;
  } finally {
    writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    logger.info(report.passed ? "Passed." : "Failed.", report);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    logger.error("The slow-link check failed.", { error: String(error) });
    process.exit(1);
  },
);
