// How the app starts the storage hygiene host. It is an Electron `utilityProcess` for the same
// reason as the database host (see `agent-database-host-process.ts`): the app ships the
// `runAsNode: false` fuse. The host lowers its own CPU and I/O priority when it starts.

import { join } from "node:path";
import { utilityProcess } from "electron";
import type { StorageHygieneHostProcess, StorageHygieneHostResponse } from "../backend/storage-hygiene-protocol";

export function spawnStorageHygieneHost(): StorageHygieneHostProcess {
  const child = utilityProcess.fork(join(__dirname, "storage-hygiene-host.js"), [], {
    serviceName: "OpenBot storage scan",
    stdio: "ignore",
  });
  return {
    send: (request) => child.postMessage(request),
    onResponse: (listener) => {
      child.on("message", (message: StorageHygieneHostResponse) => listener(message));
    },
    onExit: (listener) => {
      child.once("exit", () => listener());
    },
    kill: () => {
      child.kill();
    },
  };
}
