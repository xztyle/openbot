// Checks that Signal (`remote/api`) ends a host socket that went half open, so clients are held for
// the host instead of being given a dead socket. A host that restarts or loses its network can leave
// its old socket open with no close; Signal kept it as the host's current socket until its idle
// timeout (two minutes), and each client hello in that time got `ready` and then waited 30 s for an
// offer that never came. Starts the real Signal service on free local ports with throwaway keys:
// - the host says hello through a TCP relay; a tab connects with `waitForHost` and gets `ready`;
// - the relay stops passing bytes both ways and keeps both sockets open (a half-open host);
// - within 45 s a new tab's hello is held with `host-waiting`, not given the dead socket;
// - the host says hello again on a new socket, and the waiting tab gets `ready` with a `peer-ready`.
// No account service, TURN server or browser is needed.
//
// `bun scripts/signal-host-liveness-e2e.ts`
// Writes .openbot-build/signal-host-liveness-e2e/report.json and exits non-zero when a check fails.
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as connectNet, createServer as createNetServer, type Socket as NetSocket } from "node:net";
import { resolve } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  REMOTE_TICKET_AUDIENCE,
  REMOTE_TICKET_PROTOCOL_VERSION,
  type RemoteTicketClaims,
} from "@openbot/contracts/signal-protocol/ticket";
import { createOpenBotLogger } from "@openbot/logging";
import { exportJWK, SignJWT } from "jose";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/signal-host-liveness-e2e");
const WAIT_MS = 10_000;
const HOST_ID = "host-liveness-e2e";
const USER_ID = "member-liveness-e2e";

const logger = createOpenBotLogger("signal-host-liveness-e2e");

interface Check {
  name: string;
  passed: boolean;
  evidence: string;
}
const checks: Check[] = [];

async function check(name: string, run: () => Promise<string>) {
  try {
    const evidence = await run();
    checks.push({ name, passed: true, evidence });
    logger.info(`PASS ${name}`);
  } catch (error) {
    const evidence = error instanceof Error ? error.message : String(error);
    checks.push({ name, passed: false, evidence });
    logger.error(`FAIL ${name}: ${evidence}`);
  }
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("No port.")),
      );
    });
  });
}

// The account service that Signal asks whether a ticket's session is still active. Every session of
// this run is. (Signal signs these requests; signal-security-e2e checks that.)
function startControlPlane(port: number): Promise<Server> {
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === "/v2/remote/resume/validate") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ valid: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolveServer) => server.listen(port, "127.0.0.1", () => resolveServer(server)));
}

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicJwk = { ...(await exportJWK(publicKey)), kid: "e2e-1", alg: "ES256", use: "sig" };

/** A ticket as the account service signs it: the host's, or a member tab's for one session. */
function ticket(role: RemoteTicketClaims["role"], sessionId: string) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    jti: randomUUID(),
    sessionId,
    hostId: HOST_ID,
    userId: role === "host" ? "owner-liveness-e2e" : USER_ID,
    membershipId: role === "host" ? `${HOST_ID}:host` : `${HOST_ID}:member`,
    role,
    authEpoch: 1,
    protocolMinimum: REMOTE_TICKET_PROTOCOL_VERSION,
    protocolMaximum: REMOTE_TICKET_PROTOCOL_VERSION,
    sessionExpiresAt: now + 86_400,
    ...(role === "host" ? {} : { clientPublicKey: randomBytes(32).toString("base64url") }),
  })
    .setProtectedHeader({ alg: "ES256", kid: "e2e-1" })
    .setAudience(REMOTE_TICKET_AUDIENCE)
    .setIssuedAt(now - 5)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

/** The fields of a Signal frame that this run reads. */
interface Frame {
  type?: unknown;
  sessionId?: unknown;
  connectionId?: unknown;
  sdp?: unknown;
}

function decodeFrame(data: unknown): Frame {
  const value = JSON.parse(String(data));
  if (!isDynamicRecord(value)) return {};
  return { type: value.type, sessionId: value.sessionId, connectionId: value.connectionId, sdp: value.sdp };
}

interface Socket {
  frames: Array<Frame>;
  socket: WebSocket;
  closeCode: number | null;
  closed: Promise<number>;
  next(predicate: (frame: Frame) => boolean, label: string): Promise<Frame>;
  send(value: object): void;
}

function open(url: string): Promise<Socket> {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    const frames: Array<Frame> = [];
    const waiters: Array<{
      predicate: (frame: Frame) => boolean;
      done: (frame: Frame) => void;
    }> = [];
    const peer: Socket = {
      frames,
      socket,
      closeCode: null,
      closed: new Promise<number>((resolveClose) =>
        socket.addEventListener("close", (event) => {
          peer.closeCode = event.code;
          resolveClose(event.code);
        }),
      ),
      next(predicate, label) {
        const seen = frames.find(predicate);
        if (seen) return Promise.resolve(seen);
        return new Promise((resolveFrame, rejectFrame) => {
          const timer = setTimeout(() => rejectFrame(new Error(`No frame: ${label}.`)), WAIT_MS);
          waiters.push({
            predicate,
            done: (frame) => {
              clearTimeout(timer);
              resolveFrame(frame);
            },
          });
        });
      },
      send: (value) => socket.send(JSON.stringify(value)),
    };
    socket.addEventListener("message", (event) => {
      const frame = decodeFrame(event.data);
      frames.push(frame);
      for (const waiter of waiters.splice(0)) {
        if (waiter.predicate(frame)) waiter.done(frame);
        else waiters.push(waiter);
      }
    });
    socket.addEventListener("error", () => reject(new Error("The WebSocket failed.")));
    socket.addEventListener("open", () => resolveSocket(peer));
  });
}

async function waitForReady(url: string, child: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Signal exited with code ${child.exitCode}.`);
    if (
      await fetch(url).then(
        (response) => response.ok,
        () => false,
      )
    )
      return;
    await new Promise((wake) => setTimeout(wake, 200));
  }
  throw new Error("Signal did not become ready.");
}

const [signalPort, healthPort, controlPlanePort] = await Promise.all([freePort(), freePort(), freePort()]);
const controlPlane = await startControlPlane(controlPlanePort);
const serviceOutput: string[] = [];
const child = spawn("bun", [resolve(ROOT, "remote/api/src/index.ts")], {
  cwd: resolve(ROOT, "remote/api"),
  // Only what Signal needs, so no developer or production secret reaches it.
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    REMOTE_SIGNAL_HOST: "127.0.0.1",
    REMOTE_SIGNAL_PORT: String(signalPort),
    REMOTE_HEALTH_PORT: String(healthPort),
    REMOTE_TLS_DISABLED: "true",
    REMOTE_TICKET_PUBLIC_KEYS: JSON.stringify({ keys: [publicJwk] }),
    REMOTE_CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlanePort}`,
    REMOTE_SESSION_SECRET: randomBytes(32).toString("base64url"),
    REMOTE_AUTH_WEBHOOK_SECRET: randomBytes(32).toString("base64url"),
    TURN_SHARED_SECRET: randomBytes(32).toString("base64url"),
    TURN_HOST: "127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout?.on("data", (chunk: Buffer) => serviceOutput.push(chunk.toString()));
child.stderr?.on("data", (chunk: Buffer) => serviceOutput.push(chunk.toString()));

const signalUrl = `ws://127.0.0.1:${signalPort}/v1/signal`;
const isType = (type: string) => (frame: Frame) => frame.type === type;

/** A TCP relay to Signal that can stop passing bytes while it keeps both sockets open. */
async function startRelay(targetPort: number) {
  const port = await freePort();
  let frozen = false;
  const pairs: Array<[NetSocket, NetSocket]> = [];
  const server = createNetServer((inbound) => {
    const outbound = connectNet(targetPort, "127.0.0.1");
    pairs.push([inbound, outbound]);
    inbound.on("data", (chunk) => {
      if (!frozen) outbound.write(chunk);
    });
    outbound.on("data", (chunk) => {
      if (!frozen) inbound.write(chunk);
    });
    inbound.on("error", () => outbound.destroy());
    outbound.on("error", () => inbound.destroy());
  });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", () => done()));
  return {
    port,
    freeze() {
      frozen = true;
    },
    close() {
      for (const [inbound, outbound] of pairs) {
        inbound.destroy();
        outbound.destroy();
      }
      server.close();
    },
  };
}

async function openHost(url: string) {
  const host = await open(url);
  host.send({
    type: "hello",
    version: 1,
    peer: "host",
    token: await ticket("host", `host-${HOST_ID}`),
    multiplex: true,
  });
  await host.next(isType("ready"), "host ready");
  return host;
}

let relay: Awaited<ReturnType<typeof startRelay>> | null = null;
try {
  await waitForReady(`http://127.0.0.1:${healthPort}/health/ready`, child);
  relay = await startRelay(signalPort);
  const relayedHost = await openHost(`ws://127.0.0.1:${relay.port}/v1/signal`);

  await check("A tab reaches the host through the relay", async () => {
    const session = `tab-${randomUUID()}`;
    const tab = await open(signalUrl);
    tab.send({ type: "hello", version: 1, peer: "client", token: await ticket("member", session), waitForHost: true });
    await tab.next(isType("ready"), "tab ready");
    await relayedHost.next((frame) => frame.type === "peer-ready" && frame.sessionId === session, "peer-ready");
    tab.socket.close();
    return "ready and peer-ready";
  });

  relay.freeze();
  const frozenAt = Date.now();
  const held: { tab: Socket | null; session: string } = { tab: null, session: "" };
  await check("Within 45 s of a half-open host, a tab's hello is held for the host", async () => {
    // Each attempt is a new hello, as the web client makes after a failed attempt.
    while (Date.now() - frozenAt < 45_000) {
      const session = `tab-${randomUUID()}`;
      const tab = await open(signalUrl);
      tab.send({
        type: "hello",
        version: 1,
        peer: "client",
        token: await ticket("member", session),
        waitForHost: true,
      });
      const answer = await tab.next((frame) => frame.type === "ready" || frame.type === "host-waiting", "an answer");
      if (answer.type === "host-waiting") {
        held.tab = tab;
        held.session = session;
        return `held after ${Math.round((Date.now() - frozenAt) / 1000)} s`;
      }
      tab.socket.close();
      await new Promise((wake) => setTimeout(wake, 3_000));
    }
    throw new Error("Signal still gave the half-open host every hello after 45 s.");
  });

  await check("The host says hello again and the held tab gets ready at once", async () => {
    const tab = held.tab;
    if (!tab) throw new Error("No tab is held.");
    const startedAt = Date.now();
    const host = await openHost(signalUrl);
    await tab.next(isType("ready"), "the held tab's ready");
    await host.next((frame) => frame.type === "peer-ready" && frame.sessionId === held.session, "peer-ready");
    const took = Date.now() - startedAt;
    expect(took < 5_000, `the held tab waited ${took} ms`);
    tab.socket.close();
    host.socket.close();
    return `ready ${took} ms after the host's hello`;
  });
} catch (error) {
  checks.push({
    name: "Signal starts and admits a host",
    passed: false,
    evidence: error instanceof Error ? error.message : String(error),
  });
  logger.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  relay?.close();
  child.kill("SIGTERM");
  controlPlane.close();
}

mkdirSync(OUT, { recursive: true });
const failed = checks.filter((item) => !item.passed);
const report = { service: "remote/api", checks, passed: checks.length - failed.length, failed: failed.length };
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
if (failed.length > 0) logger.error(serviceOutput.join("").slice(-4_000));
logger.info(
  `Wrote .openbot-build/signal-host-liveness-e2e/report.json: ${report.passed} passed, ${report.failed} failed.`,
);
process.exit(failed.length === 0 ? 0 : 1);
