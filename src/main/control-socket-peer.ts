/**
 * Who is on the other end of a control socket connection. Agents run as the service user, the same
 * user as main, so the file mode of the socket does not keep them out. The kernel knows the process
 * that connected (`SO_PEERCRED`), and its ancestry tells an agent from an operator:
 *
 * - Every agent process descends from main. A process that a double fork orphans goes to PID 1 of
 *   the container (tini) or, on a computer with systemd, stays in the cgroup of the service.
 * - `docker exec` puts a process into the container from outside its PID namespace, so the top of its
 *   chain has parent 0 and is not PID 1. On a computer with systemd, an operator's shell is in a cgroup
 *   of its own (a user session), not in the service's.
 *
 * Node cannot read `SO_PEERCRED`, so a small Perl program does it on a copy of the connection's file
 * descriptor (Perl is part of every Debian and Ubuntu install). It also takes a pidfd of the peer
 * (`SO_PEERPIDFD`), reads the chain, and then checks that the pidfd is still alive, so the chain it
 * read cannot belong to another process that took the PID of a peer that exited.
 *
 * Anything that goes wrong makes the caller an agent: the sensitive routes then refuse.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Socket } from "node:net";

export type ControlCaller = "operator" | "agent";

/** What the helper read about the peer of one connection. */
export interface ControlPeerReport {
  pid: number;
  uid: number;
  /** The peer first, then each parent, as `[pid, parent pid]`. It ends at parent 0 when it is whole. */
  chain: readonly (readonly [number, number])[];
  /** The lines of `/proc/<pid>/cgroup` of the peer. */
  cgroup: string;
  /** Whether the peer was still the same process after the chain was read; unknown on old kernels. */
  alive: "yes" | "no" | "unknown";
}

export interface ControlSelf {
  pid: number;
  uid: number;
  cgroup: string;
}

// fd 3 is the connection. 77 is SO_PEERPIDFD (Linux 6.5); 424 is pidfd_send_signal on every
// architecture. A signal 0 only checks that the process is there.
const PEER_SCRIPT = String.raw`
use strict; use Socket qw(SOL_SOCKET SO_PEERCRED);
open(my $s, "+<&=", 3) or exit 2;
my $c = getsockopt($s, SOL_SOCKET, SO_PEERCRED) or exit 3;
my ($pid, $uid) = unpack("iI", $c);
my $pf = getsockopt($s, SOL_SOCKET, 77);
my $pidfd = defined $pf ? unpack("i", $pf) : -1;
print "peer $pid $uid\n";
my $p = $pid; my $n = 0;
while ($p > 0 && $n++ < 256) {
  open(my $f, "<", "/proc/$p/stat") or last;
  my $st = do { local $/; <$f> }; close $f;
  $st =~ /^\d+ \(.*\) \S (\d+) /s or last;
  print "chain $p $1\n"; $p = $1;
}
if (open(my $g, "<", "/proc/$pid/cgroup")) { while (my $l = <$g>) { chomp $l; print "cgroup $l\n"; } }
print "alive ", ($pidfd < 0 ? "unknown" : (syscall(424, $pidfd, 0, 0, 0) == 0 ? "yes" : "no")), "\n";
`;

const HELPER_TIMEOUT_MS = 5_000;
const MAX_REPORT_BYTES = 64 * 1024;

export function parseControlPeerReport(text: string): ControlPeerReport | null {
  let pid = -1;
  let uid = -1;
  let alive: ControlPeerReport["alive"] | null = null;
  const chain: [number, number][] = [];
  const cgroup: string[] = [];
  for (const line of text.split("\n")) {
    const [kind, ...rest] = line.split(" ");
    if (kind === "peer") {
      pid = Number(rest[0]);
      uid = Number(rest[1]);
    } else if (kind === "chain") {
      chain.push([Number(rest[0]), Number(rest[1])]);
    } else if (kind === "cgroup") {
      cgroup.push(rest.join(" "));
    } else if (kind === "alive" && (rest[0] === "yes" || rest[0] === "no" || rest[0] === "unknown")) {
      alive = rest[0];
    }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(uid) || uid < 0 || alive === null) return null;
  if (chain.some(([a, b]) => !Number.isSafeInteger(a) || !Number.isSafeInteger(b))) return null;
  return { pid, uid, chain, cgroup: cgroup.join("\n"), alive };
}

/** The rule above, on a report. Pure, so the tests can give it any process tree. */
export function classifyControlPeer(report: ControlPeerReport, self: ControlSelf): ControlCaller {
  if (report.alive === "no") return "agent";
  if (report.uid !== self.uid && report.uid !== 0) return "agent";
  const { chain } = report;
  const first = chain[0];
  const top = chain.at(-1);
  // A chain that stops early (a parent exited while it was read) proves nothing.
  if (!first || !top || first[0] !== report.pid || top[1] !== 0) return "agent";
  for (let index = 1; index < chain.length; index += 1) {
    if (chain[index]?.[0] !== chain[index - 1]?.[1]) return "agent";
  }
  if (chain.some(([pid]) => pid === self.pid)) return "agent";
  // Entered from outside the PID namespace: `docker exec`, or root on the computer.
  if (top[0] !== 1) return "operator";
  // Under PID 1 of this namespace. An orphan of an agent stays in the service's cgroup.
  return report.cgroup !== "" && report.cgroup !== self.cgroup ? "operator" : "agent";
}

export interface ControlPeersOptions {
  onError?: (message: string, error: unknown) => void;
  /** Tests only. */
  self?: ControlSelf;
  inspect?: (socket: Socket) => Promise<ControlPeerReport | null>;
}

/** Classifies each connection once; HTTP keep-alive sends more requests on the same peer. */
export class ControlSocketPeers {
  readonly #options: ControlPeersOptions;
  readonly #callers = new WeakMap<Socket, Promise<ControlCaller>>();
  #self: ControlSelf | null = null;

  constructor(options: ControlPeersOptions = {}) {
    this.#options = options;
  }

  caller(socket: Socket): Promise<ControlCaller> {
    const known = this.#callers.get(socket);
    if (known) return known;
    const caller = (this.#options.inspect ?? inspectControlPeer)(socket)
      .then((report) => (report ? classifyControlPeer(report, this.#ownProcess()) : "agent"))
      .catch((error: unknown) => {
        this.#options.onError?.("The control socket could not tell who connected.", error);
        return "agent" as const;
      });
    this.#callers.set(socket, caller);
    return caller;
  }

  #ownProcess(): ControlSelf {
    this.#self ??= this.#options.self ?? {
      pid: process.pid,
      uid: process.getuid?.() ?? -1,
      cgroup: readCgroup(),
    };
    return this.#self;
  }
}

function readCgroup(): string {
  try {
    return readFileSync("/proc/self/cgroup", "utf8").trimEnd();
  } catch {
    return "";
  }
}

/** Runs the helper on a copy of the connection; null when it cannot say. */
function inspectControlPeer(socket: Socket): Promise<ControlPeerReport | null> {
  return new Promise((resolve) => {
    const child = spawn("perl", ["-e", PEER_SCRIPT], {
      stdio: ["ignore", "pipe", "ignore", socket],
      env: { PATH: "/usr/bin:/bin" },
      timeout: HELPER_TIMEOUT_MS,
    });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (output.length < MAX_REPORT_BYTES) output += chunk;
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code === 0 ? parseControlPeerReport(output) : null));
  });
}
