// The storage hygiene work, as the service calls it: in the background host process in the app, or
// in this process for a script. The host starts on the first call and stops after a quiet minute,
// so its memory is free between scans.

import type { StorageHygieneWebpTool } from "@openbot/contracts/ipc";
import {
  applyStorageHygiene,
  convertEvidenceScreenshots,
  detectWebpTool,
  type StorageHygieneApplyOutcome,
  type StorageHygieneApplyRequest,
  type StorageHygieneConvertOutcome,
  type StorageHygieneConvertRequest,
} from "./storage-hygiene-apply";
import type {
  StorageHygieneHostProcess,
  StorageHygieneHostRequest,
  StorageHygieneHostResponse,
} from "./storage-hygiene-protocol";
import {
  type StorageHygieneScanRequest,
  type StorageHygieneScanResult,
  scanStorageHygiene,
} from "./storage-hygiene-scan";

export interface StorageHygieneWorker {
  scan(request: StorageHygieneScanRequest, onProgress?: (entries: number) => void): Promise<StorageHygieneScanResult>;
  apply(request: StorageHygieneApplyRequest): Promise<StorageHygieneApplyOutcome>;
  convert(request: StorageHygieneConvertRequest): Promise<StorageHygieneConvertOutcome>;
  webpTool(): Promise<StorageHygieneWebpTool | null>;
  dispose(): void;
}

const IDLE_STOP_MS = 60_000;

/** The work in this process, for scripts and tests. */
export function inProcessStorageHygieneWorker(): StorageHygieneWorker {
  return {
    scan: scanStorageHygiene,
    apply: applyStorageHygiene,
    convert: convertEvidenceScreenshots,
    webpTool: detectWebpTool,
    dispose: () => undefined,
  };
}

interface Pending {
  settle: (response: Exclude<StorageHygieneHostResponse, { kind: "progress" }>) => void;
  progress?: ((entries: number) => void) | undefined;
}

function unexpected(response: Exclude<StorageHygieneHostResponse, { kind: "progress" }>): Error {
  return new Error(response.kind === "error" ? response.message : "The storage scan process answered another request.");
}

/** The work in the background host process that `spawn` starts. */
export function processStorageHygieneWorker(spawn: () => StorageHygieneHostProcess): StorageHygieneWorker {
  let host: StorageHygieneHostProcess | null = null;
  let nextId = 1;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, Pending>();

  function stopWhenIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (pending.size) return;
    idleTimer = setTimeout(() => {
      if (pending.size) return;
      host?.kill();
      host = null;
    }, IDLE_STOP_MS);
    idleTimer.unref?.();
  }

  function started(): StorageHygieneHostProcess {
    if (host) return host;
    const child = spawn();
    child.onResponse((response) => {
      const entry = pending.get(response.id);
      if (!entry) return;
      if (response.kind === "progress") {
        entry.progress?.(response.entries);
        return;
      }
      pending.delete(response.id);
      entry.settle(response);
      stopWhenIdle();
    });
    child.onExit(() => {
      if (host === child) host = null;
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.settle({ id, kind: "error", message: "The storage scan process stopped." });
      }
    });
    host = child;
    return child;
  }

  function send(request: StorageHygieneHostRequest, entry: Pending): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    pending.set(request.id, entry);
    try {
      started().send(request);
    } catch (error) {
      pending.delete(request.id);
      entry.settle({ id: request.id, kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    scan: (request, onProgress) =>
      new Promise((resolve, reject) =>
        send(
          { id: nextId++, kind: "scan", request },
          {
            progress: onProgress,
            settle: (response) => (response.kind === "scan" ? resolve(response.result) : reject(unexpected(response))),
          },
        ),
      ),
    apply: (request) =>
      new Promise((resolve, reject) =>
        send(
          { id: nextId++, kind: "apply", request },
          {
            settle: (response) => (response.kind === "apply" ? resolve(response.result) : reject(unexpected(response))),
          },
        ),
      ),
    convert: (request) =>
      new Promise((resolve, reject) =>
        send(
          { id: nextId++, kind: "convert", request },
          {
            settle: (response) =>
              response.kind === "convert" ? resolve(response.result) : reject(unexpected(response)),
          },
        ),
      ),
    webpTool: () =>
      new Promise((resolve, reject) =>
        send(
          { id: nextId++, kind: "webp-tool" },
          {
            settle: (response) =>
              response.kind === "webp-tool" ? resolve(response.result) : reject(unexpected(response)),
          },
        ),
      ),
    dispose: () => {
      if (idleTimer) clearTimeout(idleTimer);
      host?.kill();
      host = null;
    },
  };
}
