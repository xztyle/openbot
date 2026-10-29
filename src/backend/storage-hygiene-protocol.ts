// The messages between the main process and the storage hygiene host process. Types only, so the
// host keeps its runtime imports to `node:*` and the scan and cleanup modules.

import type { StorageHygieneWebpTool } from "@openbot/contracts/ipc";
import type {
  StorageHygieneApplyOutcome,
  StorageHygieneApplyRequest,
  StorageHygieneConvertOutcome,
  StorageHygieneConvertRequest,
} from "./storage-hygiene-apply";
import type { StorageHygieneScanRequest, StorageHygieneScanResult } from "./storage-hygiene-scan";

export type StorageHygieneHostRequest =
  | { id: number; kind: "scan"; request: StorageHygieneScanRequest }
  | { id: number; kind: "apply"; request: StorageHygieneApplyRequest }
  | { id: number; kind: "convert"; request: StorageHygieneConvertRequest }
  | { id: number; kind: "webp-tool" };

export type StorageHygieneHostResponse =
  | { id: number; kind: "progress"; entries: number }
  | { id: number; kind: "scan"; result: StorageHygieneScanResult }
  | { id: number; kind: "apply"; result: StorageHygieneApplyOutcome }
  | { id: number; kind: "convert"; result: StorageHygieneConvertOutcome }
  | { id: number; kind: "webp-tool"; result: StorageHygieneWebpTool | null }
  | { id: number; kind: "error"; message: string };

/** The host process as the worker sees it: an Electron `utilityProcess` in the app. */
export interface StorageHygieneHostProcess {
  send(request: StorageHygieneHostRequest): void;
  onResponse(listener: (response: StorageHygieneHostResponse) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}
