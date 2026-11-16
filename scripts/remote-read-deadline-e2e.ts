// Checks the read deadline of the real Team WebRTC client peer (`createRemoteTeamPeer`) against a fake
// host. The peer runs its real Signal handshake, data channels, signed host authentication, framing
// and request path; only the WebSocket, the RTCPeerConnection and the host are stand-ins, so the
// script can hold an answer where a TURN path holds it. Each case sends a read with a short deadline:
// - slow-answer: the host answers in 16 KB frames over about 3 s. The read waits while frames arrive.
// - queued-send: the read waits 1.6 s behind 5 MB in the client's rpc channel. Its deadline starts at the send.
// - behind-other-data: the answer comes after 2.5 s while other data reaches the path. The read waits.
// - lost-answer: the host never answers and nothing arrives. The read fails at its deadline, with a
//   `request-timeout` diagnostic.
// Run: `bun scripts/remote-read-deadline-e2e.ts`. Writes .openbot-build/remote-read-deadline-e2e/report.json.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  decodeTeamProtocolV2AuthFrame,
  decodeTeamProtocolV2RpcFrame,
  encodeTeamProtocolV2Frame,
  TEAM_PROTOCOL_V2_CHANNELS,
  teamProtocolV2AuthenticationTranscript,
} from "@openbot/contracts/team-protocol/v2";
import { sourceText } from "@openbot/i18n/source";
import {
  createRemoteTeamPeer,
  type RemoteTeamCommandResult,
  type RemoteTeamDiagnostic,
} from "@openbot/team-client/remote-peer";
import { encodeTeamWebRtcPayload, TeamWebRtcPayloadDecoder } from "@openbot/team-client/webrtc-framing";

const NAME = "remote-read-deadline-e2e";
const OUT = resolve(import.meta.dirname, `../.openbot-build/${NAME}`);
const HOST_ID = "host-read-deadline";
const SESSION_ID = "session-read-deadline";
const TICKET = "ticket-read-deadline";
const CONNECTION_ID = "connection-read-deadline";
const CLIENT_FINGERPRINT = "AA:11:22:33";
const HOST_FINGERPRINT = "BB:44:55:66";
const READ_PATH = "/v1/agents/conversation-reads";
const sdp = (fingerprint: string) => `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const hostKeys = generateKeyPairSync("ed25519");
const hostPublicKey = hostKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

/** The fields of a WebRTC stats report that the peer reads. */
interface FakeStat {
  type: string;
  selectedCandidatePairId?: string;
  state?: string;
  nominated?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  bytesSent?: number;
  bytesReceived?: number;
  currentRoundTripTime?: number;
  candidateType?: string;
  protocol?: string;
}

/** The `type` of a JSON frame, or null. */
function frameType(data: string): string | null {
  const value = JSON.parse(data);
  return isDynamicRecord(value) && isString(value.type) ? value.type : null;
}

/** What the fake host does with the next request. */
type Answer = (requestId: string) => void;
let nextAnswer: Answer = () => {};

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  binaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly #decoder = new TeamWebRtcPayloadDecoder();

  constructor(readonly label: string) {
    super();
  }

  send(data: string | ArrayBuffer): void {
    const decoded = this.#decoder.push(data);
    if (decoded !== undefined) setTimeout(() => host.receive(this, decoded), 1);
  }

  /** A frame from the host. */
  deliver(data: string | ArrayBuffer): void {
    this.onmessage?.({ data });
  }

  /** Sends some of what waits in the channel, as SCTP does when the path takes it. */
  drain(bytes: number): void {
    this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
    if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatchEvent(new Event("bufferedamountlow"));
  }

  close(): void {
    this.readyState = "closed";
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  readonly sctp = { maxMessageSize: 64 * 1024 };
  readonly channels = new Map<string, FakeDataChannel>();
  /** The data bytes that the selected pair received. A case raises it to stand for other traffic. */
  bytesReceived = 0;
  onicecandidate: (() => void) | null = null;
  ondatachannel: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() {
    connections.push(this);
  }

  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label);
    this.channels.set(label, channel);
    return channel;
  }

  async createOffer() {
    return { type: "offer", sdp: sdp(CLIENT_FINGERPRINT) };
  }

  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
  }

  async setRemoteDescription(description: { type: string; sdp: string }) {
    this.remoteDescription = description;
    setTimeout(() => {
      this.connectionState = "connected";
      this.onconnectionstatechange?.();
      for (const channel of this.channels.values()) {
        channel.readyState = "open";
        channel.onopen?.();
      }
    }, 1);
  }

  setConfiguration(): void {}
  restartIce(): void {}
  async addIceCandidate(): Promise<void> {}

  async getStats() {
    return new Map<string, FakeStat>([
      ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
      [
        "pair",
        {
          type: "candidate-pair",
          state: "succeeded",
          nominated: true,
          localCandidateId: "local",
          remoteCandidateId: "remote",
          bytesSent: 0,
          bytesReceived: this.bytesReceived,
          currentRoundTripTime: 0.05,
        },
      ],
      ["local", { type: "local-candidate", candidateType: "relay", protocol: "udp" }],
      ["remote", { type: "remote-candidate", candidateType: "host", protocol: "udp" }],
    ]);
  }

  close(): void {
    this.connectionState = "closed";
  }

  rpc(): FakeDataChannel {
    const channel = this.channels.get(TEAM_PROTOCOL_V2_CHANNELS.rpc);
    assert.ok(channel, "The peer has no rpc channel.");
    return channel;
  }
}

/** Signal: answers the hello with `ready`, and the offer with the host's answer. */
class FakeSignalSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSignalSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    setTimeout(() => {
      this.readyState = FakeSignalSocket.OPEN;
      this.onopen?.();
    }, 1);
  }

  send(data: string): void {
    const type = frameType(data);
    if (type === "hello")
      this.#reply({
        type: "ready",
        version: 1,
        connectionId: CONNECTION_ID,
        resumeToken: "resume-read-deadline",
        iceServers: [{ urls: "turn:turn.invalid:3478", username: "user", credential: "credential" }],
      });
    else if (type === "offer")
      this.#reply({
        type: "answer",
        version: 1,
        connectionId: CONNECTION_ID,
        channel: "team",
        sdp: sdp(HOST_FINGERPRINT),
      });
  }

  close(): void {
    if (this.readyState === FakeSignalSocket.CLOSED) return;
    this.readyState = FakeSignalSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }

  #reply(message: unknown): void {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(message) }), 1);
  }
}

/** The host end: the signed handshake, then each request goes to `nextAnswer`. */
const host = {
  hostNonce: "",
  receive(channel: FakeDataChannel, data: string | ArrayBuffer): void {
    if (channel.label !== TEAM_PROTOCOL_V2_CHANNELS.rpc || typeof data !== "string") return;
    const type = frameType(data);
    if (type === "auth-init") {
      const init = decodeTeamProtocolV2AuthFrame(data);
      if (init.type !== "auth-init") throw new Error("Expected auth-init.");
      this.hostNonce = randomBytes(32).toString("base64url");
      const transcript = teamProtocolV2AuthenticationTranscript({
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        ticket: init.ticket,
        clientPublicKey: init.clientPublicKey,
        clientNonce: init.clientNonce,
        hostNonce: this.hostNonce,
        clientFingerprint: CLIENT_FINGERPRINT,
        hostFingerprint: HOST_FINGERPRINT,
      });
      channel.deliver(
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "auth-ready",
          clientNonce: init.clientNonce,
          hostNonce: this.hostNonce,
          signature: sign(null, Buffer.from(transcript), hostKeys.privateKey).toString("base64url"),
        }),
      );
      return;
    }
    if (type === "auth-complete") {
      const complete = decodeTeamProtocolV2AuthFrame(data);
      if (complete.type !== "auth-complete") throw new Error("Expected auth-complete.");
      channel.deliver(
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "auth-confirmed",
          clientNonce: complete.clientNonce,
          hostNonce: complete.hostNonce,
        }),
      );
      return;
    }
    const request = decodeTeamProtocolV2RpcFrame(data);
    if (request.type === "request") nextAnswer(request.requestId);
  },
};

/** A conversation read state for each of many agents: about 600 KB, as a large page is. */
function largeReads(): Record<string, { unreadCount: number; firstUnreadMessageId: string; throughMessageId: null }> {
  const reads: Record<string, { unreadCount: number; firstUnreadMessageId: string; throughMessageId: null }> = {};
  for (let index = 0; index < 4_000; index++)
    reads[`agent-${String(index).padStart(6, "0")}-${"a".repeat(30)}`] = {
      unreadCount: index,
      firstUnreadMessageId: `message-${"m".repeat(20)}-${index}`,
      throughMessageId: null,
    };
  return reads;
}

function responseFrames(requestId: string, body: unknown, frameBytes: number): Array<string | ArrayBuffer> {
  const frame = encodeTeamProtocolV2Frame({
    version: 2,
    type: "response",
    requestId,
    result: { status: 200, body: JSON.parse(JSON.stringify(body)) },
  });
  return encodeTeamWebRtcPayload(frame, frameBytes);
}

async function deliverSpaced(frames: Array<string | ArrayBuffer>, spacingMs: number): Promise<void> {
  const rpc = connection().rpc();
  for (const frame of frames) {
    rpc.deliver(frame);
    await sleep(spacingMs);
  }
}

const connections: FakePeerConnection[] = [];
const connection = () => {
  const last = connections.at(-1);
  assert.ok(last, "The peer made no connection.");
  return last;
};
Object.assign(globalThis, { WebSocket: FakeSignalSocket, RTCPeerConnection: FakePeerConnection });

const diagnostics: RemoteTeamDiagnostic[] = [];
const peer = createRemoteTeamPeer({
  current: {
    getBootstrap: async () => ({ sessionId: SESSION_ID, signalUrl: "wss://signal.invalid/v1", ticket: TICKET }),
    endSession: async () => {},
    onConnectionUpdate: async () => {},
    onDiagnostic: async (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    onTeamEvent: async () => {},
  },
});

interface CaseReport {
  name: string;
  timeoutMs: number;
  elapsedMs: number;
  ok: boolean;
  error: string | null;
  expectation: string;
  passed: boolean;
}
const report: { cases: CaseReport[]; diagnostics: RemoteTeamDiagnostic[]; passed: boolean } = {
  cases: [],
  diagnostics,
  passed: false,
};
let commandId = 0;

async function read(timeoutMs: number): Promise<{ result: RemoteTeamCommandResult; elapsedMs: number }> {
  const startedAt = Date.now();
  const result = await peer.execute({
    id: `read-${++commandId}`,
    type: "request",
    method: "GET",
    path: READ_PATH,
    body: {},
    timeoutMs,
  });
  return { result, elapsedMs: Date.now() - startedAt };
}

async function check(
  name: string,
  timeoutMs: number,
  expectation: string,
  verify: (result: RemoteTeamCommandResult, elapsedMs: number) => void,
): Promise<void> {
  const { result, elapsedMs } = await read(timeoutMs);
  const entry: CaseReport = {
    name,
    timeoutMs,
    elapsedMs,
    ok: result.ok,
    error: result.error ?? null,
    expectation,
    passed: false,
  };
  report.cases.push(entry);
  verify(result, elapsedMs);
  entry.passed = true;
  // A frame from before a read does not count as its progress; this only keeps the cases apart.
  await sleep(300);
}

let exitCode = 1;
try {
  const connect = await peer.execute({ id: "connect", type: "connect", hostId: HOST_ID, hostPublicKey });
  assert.ok(connect.ok, `The peer did not connect: ${connect.error ?? "no error"}`);
  const body = largeReads();

  // The host answers at once, but the path takes about 3.7 s for the 37 frames of the answer.
  nextAnswer = (requestId) => void deliverSpaced(responseFrames(requestId, body, 16 * 1024), 100);
  await check("slow-answer", 1_500, "answers after its deadline, while frames arrive", (result, elapsedMs) => {
    assert.ok(result.ok, `The slow answer failed: ${result.error}`);
    assert.ok(elapsedMs > 1_500, `The answer came before the deadline (${elapsedMs} ms), so it proves nothing.`);
    assert.equal(Object.keys(result.body ?? {}).length, 4_000);
  });

  // 5 MB waits in the client's rpc channel, and leaves at 500 KB each 200 ms. The host answers 800 ms after the read leaves.
  const rpc = connection().rpc();
  rpc.bufferedAmount = 5 * 1024 * 1024;
  const drain = setInterval(() => {
    rpc.drain(512 * 1024);
    if (rpc.bufferedAmount === 0) clearInterval(drain);
  }, 200);
  nextAnswer = (requestId) =>
    void sleep(800).then(() =>
      deliverSpaced(
        responseFrames(requestId, { "agent-1": body["agent-000001-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }, 64 * 1024),
        0,
      ),
    );
  await check("queued-send", 1_000, "counts its deadline from the send, not from the queue", (result, elapsedMs) => {
    assert.ok(result.ok, `The queued read failed: ${result.error}`);
    assert.ok(elapsedMs > 1_000, `The read did not wait in the queue (${elapsedMs} ms).`);
  });
  clearInterval(drain);

  // Other data, such as events or a browser view, reaches the path; the answer comes after 2.5 s.
  const traffic = setInterval(() => {
    connection().bytesReceived += 50 * 1024;
  }, 200);
  nextAnswer = (requestId) =>
    void sleep(2_500).then(() =>
      deliverSpaced(
        responseFrames(requestId, { "agent-2": body["agent-000002-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }, 64 * 1024),
        0,
      ),
    );
  await check("behind-other-data", 1_000, "waits while the path receives data", (result, elapsedMs) => {
    clearInterval(traffic);
    assert.ok(result.ok, `The read behind other data failed: ${result.error}`);
    assert.ok(elapsedMs >= 2_500, `The answer came too early (${elapsedMs} ms).`);
  });
  clearInterval(traffic);

  // Nothing comes back: the deadline is not extended.
  nextAnswer = () => {};
  await check("lost-answer", 1_000, "fails at its deadline when nothing arrives", (result, elapsedMs) => {
    assert.equal(result.ok, false);
    assert.equal(result.error, sourceText("error.remote.desktopRequestTimeout"));
    assert.ok(elapsedMs >= 1_000 && elapsedMs < 2_500, `The lost answer failed after ${elapsedMs} ms.`);
    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.step === "request-timeout"),
      "The timeout has no diagnostic.",
    );
  });
  report.passed = true;
  exitCode = 0;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await peer.dispose();
  process.stdout.write(`${report.passed ? "Passed" : "Failed"}. Report: ${resolve(OUT, "report.json")}\n`);
  process.exit(exitCode);
}
