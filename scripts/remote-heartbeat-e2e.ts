// Checks that the real Team WebRTC client peer (`createRemoteTeamPeer`) finds a connection that stops
// delivering without an error, against a fake host. The peer runs its real Signal handshake, data
// channels, signed host authentication, framing, heartbeat and probe; only the WebSocket, the
// RTCPeerConnection and the host are stand-ins. The consumer does what the web client does: it
// connects again after an `offline` update, reads the host's turn state after a reconnect or a
// `resync` update, and replaces the connection when a silent turn turns out to be done on the host.
// - idle: a healthy connection with no traffic. The heartbeat probes it, the host answers, and the
//   peer stays online.
// - silent-stall: during a turn the path stops delivering in both directions, and the turn ends on
//   the host. The heartbeat finds it within the idle time and the probe window, the consumer
//   connects again and reads the ended turn, and the host gets the report `heartbeat-timeout`.
// - event-stall: during a turn the host's events stop while reads still work, and the turn ends on
//   the host. The consumer's read finds the ended turn, the peer is replaced with no `offline` or
//   `connecting` update, and the host gets the report `event-stall`.
// Run: `bun scripts/remote-heartbeat-e2e.ts`. Writes .openbot-build/remote-heartbeat-e2e/report.json.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  CONNECTION_REPORT_OPERATION,
  type ConnectionReport,
  decodeConnectionReport,
} from "@openbot/contracts/team-protocol/connection-report-v1";
import { FORK_HOST_CAPABILITY } from "@openbot/contracts/team-protocol/fork-host-v1";
import {
  decodeTeamProtocolV2AuthFrame,
  decodeTeamProtocolV2EventFrame,
  decodeTeamProtocolV2RpcFrame,
  encodeTeamProtocolV2Frame,
  TEAM_PROTOCOL_V2_CHANNELS,
  type TeamProtocolV2Json,
  teamProtocolV2AuthenticationTranscript,
} from "@openbot/contracts/team-protocol/v2";
import { createTeamProtocolV8Event } from "@openbot/contracts/team-protocol/v8-webrtc-adapter";
import {
  createRemoteTeamPeer,
  type RemoteTeamConnectionUpdate,
  type RemoteTeamDiagnostic,
} from "@openbot/team-client/remote-peer";
import { TeamWebRtcPayloadDecoder } from "@openbot/team-client/webrtc-framing";

const NAME = "remote-heartbeat-e2e";
const OUT = resolve(import.meta.dirname, `../.openbot-build/${NAME}`);
const HOST_ID = "host-heartbeat";
const SESSION_ID = "session-heartbeat";
const TICKET = "ticket-heartbeat";
const CLIENT_FINGERPRINT = "AA:11:22:33";
const HOST_FINGERPRINT = "BB:44:55:66";
const AGENT_ID = "agent-1";
const THREAD_ID = "thread-1";
/** The read that stands for the host's turn state: the turn's reply makes the chat unread. */
const TURN_STATE_PATH = TEAM_API_ROUTES.agents.conversationReads;
/** Short, so the cases take seconds. The product waits 30 s. */
const HEARTBEAT_IDLE_MS = 1_500;
/** The silence of a running turn after which the consumer reads the turn state. The web client waits 45 s. */
const TURN_SILENCE_MS = 1_500;
const sdp = (fingerprint: string) => `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const hostKeys = generateKeyPairSync("ed25519");
const hostPublicKey = hostKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

function frameType(data: string): string | null {
  const value = JSON.parse(data);
  return isDynamicRecord(value) && isString(value.type) ? value.type : null;
}

/** What reaches the other end. `rpc` and `events` stop a channel; `path` stops everything, as a dead relay does. */
const delivery = { path: true, events: true };

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

  constructor(
    readonly label: string,
    readonly connection: FakePeerConnection,
  ) {
    super();
  }

  send(data: string | ArrayBuffer): void {
    // The frame leaves the client even when the path beyond the first hop is dead.
    this.connection.bytesSent += typeof data === "string" ? data.length : data.byteLength;
    if (!delivery.path || this.connection.closed) return;
    const decoded = this.#decoder.push(data);
    if (decoded !== undefined) setTimeout(() => host.receive(this, decoded), 1);
  }

  /** A frame from the host. A dead path drops it. */
  deliver(data: string): void {
    if (!delivery.path || this.connection.closed || this.readyState !== "open") return;
    this.connection.bytesReceived += data.length;
    setTimeout(() => this.onmessage?.({ data }), 1);
  }

  close(): void {
    this.readyState = "closed";
  }
}

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

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  readonly sctp = { maxMessageSize: 64 * 1024 };
  readonly channels = new Map<string, FakeDataChannel>();
  bytesSent = 0;
  bytesReceived = 0;
  closed = false;
  onicecandidate: (() => void) | null = null;
  ondatachannel: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() {
    connections.push(this);
    // A new connection takes a working path, as a new relay allocation does, and the host starts a new event stream for it.
    delivery.path = true;
    delivery.events = true;
  }

  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label, this);
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
      // ICE reads the path as connected all the time: its checks still pass on the dead path.
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
          bytesSent: this.bytesSent,
          bytesReceived: this.bytesReceived,
          currentRoundTripTime: 0.05,
        },
      ],
      ["local", { type: "local-candidate", candidateType: "relay", protocol: "udp" }],
      ["remote", { type: "remote-candidate", candidateType: "relay", protocol: "udp" }],
    ]);
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  channel(kind: "rpc" | "events"): FakeDataChannel {
    const channel = this.channels.get(TEAM_PROTOCOL_V2_CHANNELS[kind]);
    assert.ok(channel, `The peer has no ${kind} channel.`);
    return channel;
  }
}

let connectionCount = 0;
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
  readonly #connectionId = `connection-${++connectionCount}`;

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
        connectionId: this.#connectionId,
        resumeToken: "resume-heartbeat",
        iceServers: [{ urls: "turn:turn.invalid:3478", username: "user", credential: "credential" }],
      });
    else if (type === "offer")
      this.#reply({
        type: "answer",
        version: 1,
        connectionId: this.#connectionId,
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

const hostReports: ConnectionReport[] = [];
/** The host: the signed handshake, the compatibility read, the turn state, its events, and the reports. */
const host = {
  hostNonce: "",
  /** The turn state that the host holds, whatever reached the client. */
  turn: { id: "", completed: false },
  compatibilityReads: 0,
  reports: hostReports,
  /** The next event sequence of each connection. */
  sequences: new Map<FakePeerConnection, number>(),
  receive(channel: FakeDataChannel, data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;
    if (channel.label === TEAM_PROTOCOL_V2_CHANNELS.events) {
      decodeTeamProtocolV2EventFrame(data);
      return;
    }
    if (channel.label !== TEAM_PROTOCOL_V2_CHANNELS.rpc) return;
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
    if (request.type !== "request") return;
    if (request.operation === CONNECTION_REPORT_OPERATION) {
      const report = decodeConnectionReport(request.payload);
      assert.ok(report, "The client sent a connection report that the host cannot read.");
      this.reports.push(report);
      this.answer(channel, request.requestId, 204, {});
      return;
    }
    const payload = request.payload;
    const path = isDynamicRecord(payload) && isString(payload.path) ? payload.path : "";
    if (path === TEAM_API_ROUTES.compatibility) {
      this.compatibilityReads += 1;
      this.answer(channel, request.requestId, 200, {
        appVersion: "0.0.0-e2e",
        protocol: { minimum: 1, maximum: 8 },
        capabilities: [FORK_HOST_CAPABILITY],
      });
      return;
    }
    if (path === TURN_STATE_PATH) {
      this.answer(channel, request.requestId, 200, {
        [AGENT_ID]: this.turn.completed
          ? { unreadCount: 1, firstUnreadMessageId: `reply-${this.turn.id}`, throughMessageId: null }
          : { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
      });
    }
  },
  answer(channel: FakeDataChannel, requestId: string, status: number, body: TeamProtocolV2Json): void {
    channel.deliver(encodeTeamProtocolV2Frame({ version: 2, type: "response", requestId, result: { status, body } }));
  },
  /** Sends an event of the turn on the newest connection, unless events or the path are stopped. Team API v1 names the agent `botId`. */
  emit(event: Record<string, string>): void {
    const connection = connections.at(-1);
    if (!connection || !delivery.events) return;
    const sequence = this.sequences.get(connection) ?? 1;
    this.sequences.set(connection, sequence + 1);
    connection.channel("events").deliver(encodeTeamProtocolV2Frame(createTeamProtocolV8Event(sequence, event)));
  },
  startTurn(id: string): void {
    this.turn = { id, completed: false };
    this.emit({ type: "turn-started", botId: AGENT_ID, threadId: THREAD_ID, turnId: id });
    this.emit({ type: "turn-progress", botId: AGENT_ID, threadId: THREAD_ID, turnId: id, detail: "Working" });
  },
  completeTurn(): void {
    this.turn.completed = true;
    this.emit({
      type: "turn-completed",
      botId: AGENT_ID,
      threadId: THREAD_ID,
      turnId: this.turn.id,
      status: "completed",
    });
  },
};

const connections: FakePeerConnection[] = [];
Object.assign(globalThis, { WebSocket: FakeSignalSocket, RTCPeerConnection: FakePeerConnection });

const consumerUpdates: Array<RemoteTeamConnectionUpdate & { at: number }> = [];
/** The consumer's view, as the web client keeps it. */
const consumer = {
  turn: { id: "", completed: false },
  lastEventAt: Date.now(),
  updates: consumerUpdates,
};
const diagnostics: Array<RemoteTeamDiagnostic & { at: number }> = [];
let reconnecting: Promise<void> | null = null;

const peer = createRemoteTeamPeer(
  {
    current: {
      getBootstrap: async () => ({ sessionId: SESSION_ID, signalUrl: "wss://signal.invalid/v1", ticket: TICKET }),
      endSession: async () => {},
      onConnectionUpdate: async (update) => {
        consumer.updates.push({ ...update, at: Date.now() });
        // The recovery owner connects again after a lost connection, and reads again after `resync`.
        if (update.state === "offline") reconnecting ??= reconnect().finally(() => (reconnecting = null));
        if (update.state === "online" && update.resync) void resyncTurn();
      },
      onDiagnostic: async (diagnostic) => {
        diagnostics.push({ ...diagnostic, at: Date.now() });
      },
      onTeamEvent: async (_hostId, event) => {
        consumer.lastEventAt = Date.now();
        if (event.type === "turn-started") consumer.turn = { id: event.turnId, completed: false };
        if (event.type === "turn-completed" && event.turnId === consumer.turn.id) consumer.turn.completed = true;
      },
    },
  },
  { heartbeatIdleMs: HEARTBEAT_IDLE_MS },
);

let commandId = 0;
async function connect(): Promise<void> {
  const result = await peer.execute({ id: `connect-${++commandId}`, type: "connect", hostId: HOST_ID, hostPublicKey });
  assert.ok(result.ok, `The peer did not connect: ${result.error ?? "no error"}`);
  // The web client checks the host's protocol on each connect.
  await read(TEAM_API_ROUTES.compatibility);
}

async function reconnect(): Promise<void> {
  // The recovery owner starts its attempt after the update, once the failed peer is closed.
  await sleep(10);
  await connect();
  await resyncTurn();
}

async function read(path: string) {
  const result = await peer.execute({
    id: `read-${++commandId}`,
    type: "request",
    method: "GET",
    path,
    body: {},
    timeoutMs: 15_000,
  });
  assert.ok(result.ok, `The read of ${path} failed: ${result.error ?? "no error"}`);
  return result.body;
}

/** The host's turn state, read as the web client reads the open chat after lost events. */
async function readTurn(): Promise<boolean> {
  const body = await read(TURN_STATE_PATH);
  const state = isDynamicRecord(body) ? body[AGENT_ID] : null;
  return isDynamicRecord(state) && state.firstUnreadMessageId === `reply-${consumer.turn.id}`;
}

async function resyncTurn(): Promise<void> {
  if (await readTurn()) consumer.turn.completed = true;
}

async function waitFor(what: string, limitMs: number, done: () => boolean): Promise<number> {
  const startedAt = Date.now();
  while (!done()) {
    if (Date.now() - startedAt > limitMs) throw new Error(`Timed out after ${limitMs} ms: ${what}.`);
    await sleep(20);
  }
  return Date.now() - startedAt;
}

interface CaseReport {
  name: string;
  expectation: string;
  measurements: Record<string, number | string | boolean>;
  passed: boolean;
}
const report: {
  heartbeatIdleMs: number;
  cases: CaseReport[];
  reports: ConnectionReport[];
  diagnostics: typeof diagnostics;
  passed: boolean;
} = { heartbeatIdleMs: HEARTBEAT_IDLE_MS, cases: [], reports: host.reports, diagnostics, passed: false };

async function check(name: string, expectation: string, run: (measure: CaseReport["measurements"]) => Promise<void>) {
  const entry: CaseReport = { name, expectation, measurements: {}, passed: false };
  report.cases.push(entry);
  await run(entry.measurements);
  entry.passed = true;
}

let exitCode = 1;
try {
  await connect();

  await check("idle", "a healthy idle connection is probed and stays online", async (measure) => {
    const reads = host.compatibilityReads;
    const updates = consumer.updates.length;
    const connectionsBefore = connections.length;
    await sleep(HEARTBEAT_IDLE_MS * 4);
    measure.heartbeatProbes = host.compatibilityReads - reads;
    assert.ok(host.compatibilityReads - reads >= 2, `The heartbeat sent ${host.compatibilityReads - reads} probes.`);
    assert.equal(consumer.updates.length, updates, "A healthy idle connection changed its state.");
    assert.equal(connections.length, connectionsBefore, "A healthy idle connection was replaced.");
  });

  await check(
    "silent-stall",
    "a path that stops delivering is found by the heartbeat, connected again, and the ended turn is read",
    async (measure) => {
      host.startTurn("turn-stall");
      await waitFor("the turn start reaches the client", 2_000, () => consumer.turn.id === "turn-stall");
      const connectionsBefore = connections.length;
      const stalledAt = Date.now();
      delivery.path = false;
      host.completeTurn();
      assert.equal(consumer.turn.completed, false, "The turn end reached the client over a dead path.");
      // Idle time, one heartbeat check, the probe's answer window and a margin.
      const limitMs = HEARTBEAT_IDLE_MS + 500 + 4_000 + 1_000;
      await waitFor("the client finds the dead path", limitMs, () =>
        consumer.updates.some((update) => update.at >= stalledAt && update.state === "offline"),
      );
      measure.detectedAfterMs =
        (consumer.updates.find((u) => u.at >= stalledAt && u.state === "offline")?.at ?? 0) - stalledAt;
      measure.limitMs = limitMs;
      await waitFor("the client reads the ended turn", 5_000, () => consumer.turn.completed);
      measure.resyncedAfterMs = Date.now() - stalledAt;
      assert.ok(connections.length > connectionsBefore, "The client did not make a new connection.");
      await waitFor("the host gets the report", 2_000, () =>
        host.reports.some((item) => item.reason === "heartbeat-timeout"),
      );
      const sent = host.reports.find((item) => item.reason === "heartbeat-timeout");
      assert.equal(sent?.route, "relay/udp -> relay/udp");
      assert.ok(
        diagnostics.some((item) => item.step === "probe" && item.detail === "heartbeat" && item.at >= stalledAt),
        "The heartbeat probe has no diagnostic.",
      );
    },
  );

  await check(
    "event-stall",
    "events that stop while reads work are found by a read of the turn, and the connection is replaced quietly",
    async (measure) => {
      host.startTurn("turn-events");
      await waitFor("the turn start reaches the client", 2_000, () => consumer.turn.id === "turn-events");
      const connectionsBefore = connections.length;
      const updatesBefore = consumer.updates.length;
      const stalledAt = Date.now();
      delivery.events = false;
      host.completeTurn();
      // The consumer's check of a silent turn, as the web client runs it.
      await waitFor(
        "the turn is silent",
        TURN_SILENCE_MS + 1_000,
        () => Date.now() - consumer.lastEventAt >= TURN_SILENCE_MS,
      );
      const ended = await readTurn();
      assert.ok(ended, "The host's turn state does not show the ended turn.");
      peer.replace("event-stall");
      await waitFor("the quiet replacement ends", 5_000, () =>
        consumer.updates.slice(updatesBefore).some((update) => update.state === "online" && update.resync),
      );
      await waitFor("the client reads the ended turn", 3_000, () => consumer.turn.completed);
      measure.resyncedAfterMs = Date.now() - stalledAt;
      const between = consumer.updates.slice(updatesBefore).map((update) => update.state);
      measure.updates = between.join(",");
      assert.ok(!between.includes("offline") && !between.includes("connecting"), `The replacement showed ${between}.`);
      assert.ok(connections.length > connectionsBefore, "The connection was not replaced.");
      await waitFor("the host gets the report", 2_000, () =>
        host.reports.some((item) => item.reason === "event-stall"),
      );
      // The new connection's events arrive again.
      host.startTurn("turn-after");
      await waitFor("an event on the new connection", 2_000, () => consumer.turn.id === "turn-after");
    },
  );
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
