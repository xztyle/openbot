// The storage hygiene host: a background process that scans the agents' projects, deletes the
// planned items of a cleanup and converts old screenshots. It runs at the lowest CPU priority and,
// on Linux, in the idle I/O class, so a scan of a large tree does not slow the agents or the app.
//
// Its runtime imports are `node:*` and the scan and cleanup modules, which add only the contract
// value guards.
// In the app it is an Electron `utilityProcess` (see `src/main/storage-hygiene-host-process.ts`);
// under a plain runtime it reads newline-delimited JSON requests on stdin.

import { execFile } from "node:child_process";
import { setPriority } from "node:os";
import { createInterface } from "node:readline";
import { applyStorageHygiene, convertEvidenceScreenshots, detectWebpTool } from "./storage-hygiene-apply";
import type { StorageHygieneHostRequest, StorageHygieneHostResponse } from "./storage-hygiene-protocol";
import { scanStorageHygiene } from "./storage-hygiene-scan";

try {
  // Before the first file system call: the thread pool threads copy the nice value of this thread.
  setPriority(19);
} catch {
  // A system that refuses keeps the default priority.
}
if (process.platform === "linux")
  execFile("ionice", ["-c", "3", "-p", String(process.pid)], () => {
    // ionice is optional.
  });

interface ParentPort {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  postMessage(value: unknown): void;
  start(): void;
}

function isParentPort(value: unknown): value is ParentPort {
  return typeof value === "object" && value !== null && "postMessage" in value && "start" in value;
}

function isRequest(value: unknown): value is StorageHygieneHostRequest {
  return typeof value === "object" && value !== null && "kind" in value && "id" in value;
}

async function handle(
  request: StorageHygieneHostRequest,
  respond: (response: StorageHygieneHostResponse) => void,
): Promise<void> {
  const { id } = request;
  try {
    if (request.kind === "scan")
      respond({
        id,
        kind: "scan",
        result: await scanStorageHygiene(request.request, (entries) => respond({ id, kind: "progress", entries })),
      });
    else if (request.kind === "apply")
      respond({ id, kind: "apply", result: await applyStorageHygiene(request.request) });
    else if (request.kind === "convert")
      respond({ id, kind: "convert", result: await convertEvidenceScreenshots(request.request) });
    else respond({ id, kind: "webp-tool", result: await detectWebpTool() });
  } catch (error) {
    respond({ id, kind: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

const parentPort: ParentPort | undefined = isParentPort(process.parentPort) ? process.parentPort : undefined;

if (parentPort) {
  parentPort.on("message", (message) => {
    if (isRequest(message.data)) void handle(message.data, (response) => parentPort.postMessage(response));
  });
  parentPort.start();
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (isRequest(parsed)) void handle(parsed, (response) => process.stdout.write(`${JSON.stringify(response)}\n`));
  });
  lines.on("close", () => process.exit(0));
}
