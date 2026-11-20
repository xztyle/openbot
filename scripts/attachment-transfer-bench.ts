// Measures one attachment download through the released WebRTC file protocol: the host's
// `TeamWebRtcFileTransfer.sendStream` (as `GET /v1/attachments/:id` uses it) and the client's
// `createRemoteFileReceiver`, joined by a simulated data channel with a fixed one-way delay and
// bandwidth. The report is .openbot-build/attachment-transfer-bench/report.json.
//
// Each size is read alone, then all at the same time.
//
// `bun scripts/attachment-transfer-bench.ts [--delay-ms=40] [--bandwidth-mbps=16] [--sizes=102400,5242880]`
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { createRemoteFileReceiver } from "../packages/team-client/src/file-download";
import type { TeamWebRtcBridge } from "../src/main/team-webrtc-bridge";
import { TeamWebRtcFileTransfer } from "../src/main/team-webrtc-file-transfer";

type BridgeEvents = TeamWebRtcBridge extends EventEmitter<infer Events> ? Events : never;

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build", "attachment-transfer-bench");

function option(name: string, fallback: string): string {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}

const delayMs = Number(option("delay-ms", "40"));
const bytesPerMs = (Number(option("bandwidth-mbps", "16")) * 1024 * 1024) / 8 / 1000;
const sizes = option("sizes", `${100 * 1024},${5 * 1024 * 1024}`)
  .split(",")
  .map(Number);
assert.ok(delayMs >= 0 && bytesPerMs > 0 && sizes.every((size) => size > 0));

/**
 * One direction of the data channel: messages leave in order at the link rate and arrive after the
 * delay, in the order they left, as on an ordered SCTP stream.
 */
function link(deliver: (data: string | ArrayBuffer) => void) {
  let freeAt = 0;
  const queue: { at: number; data: string | ArrayBuffer }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pump = () => {
    timer = null;
    const now = performance.now();
    for (let next = queue[0]; next && next.at <= now; next = queue[0]) {
      queue.shift();
      deliver(next.data);
    }
    if (queue[0]) timer = setTimeout(pump, Math.max(0, queue[0].at - now));
  };
  return (data: string | ArrayBuffer) => {
    const size = typeof data === "string" ? data.length : data.byteLength;
    const now = performance.now();
    freeAt = Math.max(now, freeAt) + size / bytesPerMs;
    queue.push({ at: freeAt + delayMs, data });
    if (!timer) timer = setTimeout(pump, Math.max(0, freeAt + delayMs - now));
  };
}

/** Downloads `sizes` at the same time; each result is the time until that file was in the client. */
async function measure(sizes: number[]): Promise<{ size: number; ms: number }[]> {
  const directory = mkdtempSync(join(tmpdir(), "openbot-transfer-bench-"));
  const bridge = new EventEmitter<BridgeEvents>();
  const peerId = "client";
  let client: ReturnType<typeof createRemoteFileReceiver<never, never>> | null = null;
  const toClient = link((data) => {
    void Effect.runPromise(client?.receive(data) ?? Effect.void);
  });
  const toHost = link((data) => bridge.emit("data", peerId, "files", data));
  client = createRemoteFileReceiver((data: string) => Effect.sync(() => toHost(data)), {
    maxBytes: 100 * 1024 * 1024,
  });
  const fake: ConstructorParameters<typeof TeamWebRtcFileTransfer>[0] = Object.assign(bridge, {
    send: (_peer: string, _channel: string, data: string | ArrayBuffer) =>
      Effect.sync(() => {
        toClient(data);
        return null;
      }),
    disconnectPeer: () => Effect.void,
  });
  const host = new TeamWebRtcFileTransfer(fake, directory);
  host.setPeerAuthenticated(peerId, true);
  const receiver = client;
  const started = performance.now();
  const results = await Promise.all(
    sizes.map(async (size) => {
      const bytes = new Uint8Array(size).map((_, index) => index % 251);
      // The request goes to the host, the RPC answer with the transfer id comes back after the file.
      await new Promise((done) => setTimeout(done, delayMs));
      const { transferId } = await Effect.runPromise(
        host.sendStream(peerId, { name: "image.webp", mimeType: "image/webp", body: [bytes] }),
      );
      await new Promise((done) => setTimeout(done, delayMs));
      const file = await Effect.runPromise(receiver.take(transferId));
      assert.equal(Buffer.from(file.base64, "base64").byteLength, size);
      return { size, ms: Math.round(performance.now() - started) };
    }),
  );
  await Effect.runPromise(host.stop());
  rmSync(directory, { recursive: true, force: true });
  return results;
}

const results: Record<string, { size: number; ms: number }[]> = {};
for (const size of sizes) results[`alone-${size}`] = await measure([size]);
// A small image read while a large file is on its way: both share one ordered channel.
results.together = await measure(sizes);
mkdirSync(OUT, { recursive: true });
const report = {
  createdAt: new Date().toISOString(),
  delayMs,
  bandwidthMbps: Number(option("bandwidth-mbps", "16")),
  results,
};
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
