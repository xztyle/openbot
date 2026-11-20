// Checks that several browser tabs can have one host open at once. Each tab of a web client gets its
// own remote session from the account service (`clientInstanceId`), so Signal gives each tab its own
// connection and the host makes a peer for each, the same as for a phone and a computer. Starts the
// real Signal service (`remote/api`) on free local ports with throwaway keys and drives one host and
// two tabs of one account over real WebSockets:
// - both tabs get `ready` and stay open, and the host gets a `peer-ready` for each tab's session;
// - each tab's signalling reaches the host on its own connection, and the host's answer on each
//   connection reaches only its tab, so both tabs send and both receive at the same time;
// - a tab that closes leaves the other tab connected;
// - two sockets with ONE session, as the tabs had before, still replace each other (close 4000),
//   which is why each tab needs a session of its own.
// No account service, TURN server or browser is needed.
//
// `bun scripts/signal-tab-sessions-e2e.ts`
// Writes .openbot-build/signal-tab-sessions-e2e/report.json and exits non-zero when a check fails.
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
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
const OUT = resolve(ROOT, ".openbot-build/signal-tab-sessions-e2e");
const WAIT_MS = 10_000;
const HOST_ID = "host-tabs-e2e";
const USER_ID = "member-tabs-e2e";

const logger = createOpenBotLogger("signal-tab-sessions-e2e");

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
    userId: role === "host" ? "owner-tabs-e2e" : USER_ID,
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

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}.`)), WAIT_MS)),
  ]);
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

/** A tab that says hello with its session, as the web client's peer does, and waits for `ready`. */
async function openTab(sessionId: string, label: string) {
  const tab = await open(signalUrl);
  tab.send({ type: "hello", version: 1, peer: "client", token: await ticket("member", sessionId), waitForHost: true });
  const ready = await tab.next(isType("ready"), `${label} ready`);
  return { tab, connectionId: String(ready.connectionId) };
}

try {
  await waitForReady(`http://127.0.0.1:${healthPort}/health/ready`, child);
  logger.info(`Signal is ready on port ${signalPort}.`);

  // The desktop host serves several devices at once, so it says hello with `multiplex`.
  const host = await open(signalUrl);
  host.send({
    type: "hello",
    version: 1,
    peer: "host",
    token: await ticket("host", `host-${HOST_ID}`),
    multiplex: true,
  });
  await host.next(isType("ready"), "host ready").catch((error) => {
    throw new Error(`${error.message} Frames: ${JSON.stringify(host.frames)}, close ${host.closeCode}`);
  });

  // Two tabs of one browser: one account session, but each tab has its own remote session.
  const sessionA = `tab-a-${randomUUID()}`;
  const sessionB = `tab-b-${randomUUID()}`;
  const a = await openTab(sessionA, "tab A");
  const b = await openTab(sessionB, "tab B");

  await check("Two tabs with their own sessions are both connected to the host", async () => {
    const peerReady = (sessionId: string) => (frame: Frame) =>
      frame.type === "peer-ready" && frame.sessionId === sessionId;
    const readyA = await host.next(peerReady(sessionA), "peer-ready for tab A");
    const readyB = await host.next(peerReady(sessionB), "peer-ready for tab B");
    expect(readyA.connectionId === a.connectionId, "The host has another connection for tab A.");
    expect(readyB.connectionId === b.connectionId, "The host has another connection for tab B.");
    expect(a.connectionId !== b.connectionId, "Both tabs got one connection.");
    // A replaced socket closes at once; give it time to.
    await new Promise((wake) => setTimeout(wake, 500));
    expect(a.tab.closeCode === null && b.tab.closeCode === null, `closed: A ${a.tab.closeCode}, B ${b.tab.closeCode}`);
    return `host has connections ${a.connectionId} and ${b.connectionId}; both sockets open`;
  });

  await check("Both tabs send to the host and both get its answers at the same time", async () => {
    const offer = (connectionId: string, sdp: string) => ({
      type: "offer",
      version: 1,
      connectionId,
      channel: "team",
      sdp,
    });
    a.tab.send(offer(a.connectionId, "offer-from-a"));
    b.tab.send(offer(b.connectionId, "offer-from-b"));
    const fromA = await host.next((frame) => frame.type === "offer" && frame.sdp === "offer-from-a", "tab A's offer");
    const fromB = await host.next((frame) => frame.type === "offer" && frame.sdp === "offer-from-b", "tab B's offer");
    expect(
      fromA.connectionId === a.connectionId && fromB.connectionId === b.connectionId,
      "An offer came on the wrong connection.",
    );
    const answer = (connectionId: string, sdp: string) => ({
      type: "answer",
      version: 1,
      connectionId,
      channel: "team",
      sdp,
    });
    host.send(answer(a.connectionId, "answer-to-a"));
    host.send(answer(b.connectionId, "answer-to-b"));
    await a.tab.next((frame) => frame.type === "answer" && frame.sdp === "answer-to-a", "the answer to tab A");
    await b.tab.next((frame) => frame.type === "answer" && frame.sdp === "answer-to-b", "the answer to tab B");
    expect(!a.tab.frames.some((frame) => frame.sdp === "answer-to-b"), "Tab A got tab B's answer.");
    expect(!b.tab.frames.some((frame) => frame.sdp === "answer-to-a"), "Tab B got tab A's answer.");
    return "each offer reached the host on its tab's connection; each answer reached only its tab";
  });

  await check("A tab that closes leaves the other tab connected", async () => {
    a.tab.socket.close();
    await withDeadline(a.tab.closed, "tab A closed");
    await new Promise((wake) => setTimeout(wake, 500));
    expect(b.tab.closeCode === null, `tab B closed with ${b.tab.closeCode}`);
    b.tab.send({ type: "offer", version: 1, connectionId: b.connectionId, channel: "team", sdp: "offer-after-a" });
    await host.next(
      (frame) => frame.type === "offer" && frame.sdp === "offer-after-a",
      "tab B's offer after tab A left",
    );
    return "tab B still reaches the host";
  });

  await check("Two sockets with one session still replace each other, so each tab needs its own", async () => {
    const shared = `shared-${randomUUID()}`;
    const first = await openTab(shared, "first socket of the shared session");
    const second = await openTab(shared, "second socket of the shared session");
    const code = await withDeadline(first.tab.closed, "the first socket of the shared session closed");
    expect(code === 4000, `the first socket closed with ${code}`);
    expect(second.tab.closeCode === null, "The second socket closed too.");
    second.tab.socket.close();
    return `the first socket closed with ${code}`;
  });

  b.tab.socket.close();
  host.socket.close();
} catch (error) {
  checks.push({
    name: "Signal starts and admits a host and two tabs",
    passed: false,
    evidence: error instanceof Error ? error.message : String(error),
  });
  logger.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  child.kill("SIGTERM");
  controlPlane.close();
}

mkdirSync(OUT, { recursive: true });
const failed = checks.filter((item) => !item.passed);
const report = { service: "remote/api", checks, passed: checks.length - failed.length, failed: failed.length };
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
if (failed.length > 0) logger.error(serviceOutput.join("").slice(-4_000));
logger.info(
  `Wrote .openbot-build/signal-tab-sessions-e2e/report.json: ${report.passed} passed, ${report.failed} failed.`,
);
process.exit(failed.length === 0 ? 0 : 1);
