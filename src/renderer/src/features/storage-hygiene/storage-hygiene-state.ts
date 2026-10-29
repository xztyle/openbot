import {
  DEFAULT_STORAGE_HYGIENE_SETTINGS,
  type StorageHygieneSettings,
  type StorageHygieneState,
  type StorageHygieneStateInput,
} from "@openbot/contracts/ipc";
import { createSignal, onSettled, untrack } from "solid-js";
import type { StorageHygieneCalls } from "./storage-hygiene-port";

export type StorageHygienePhase = "loading" | "ready" | "error" | "unsupported";

/** While a scan or a cleanup runs on the host, the state is read again this often. */
const POLL_MS = 2_000;

/**
 * The storage hygiene state of one server for the Storage view: the scan, the plan and the last
 * cleanup, read again while the host scans or cleans. `calls` is undefined for a reader who is
 * not an owner or admin, or a host without the routes.
 */
export function createStorageHygieneState(calls: () => StorageHygieneCalls | undefined) {
  const [phase, setPhase] = createSignal<StorageHygienePhase>("loading");
  const [data, setData] = createSignal<StorageHygieneState | null>(null);
  const [settings, setSettings] = createSignal<StorageHygieneSettings>(DEFAULT_STORAGE_HYGIENE_SETTINGS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let request = 0;

  function schedule(state: StorageHygieneState | null) {
    if (timer) clearTimeout(timer);
    timer = null;
    if (disposed || !state || (!state.scan.running && !state.cleanup.running)) return;
    timer = setTimeout(() => void load({}), POLL_MS);
  }

  async function load(input: StorageHygieneStateInput): Promise<void> {
    const port = untrack(calls);
    if (!port) {
      setPhase("unsupported");
      return;
    }
    const current = ++request;
    try {
      const state = await port.getState(input);
      if (disposed || current !== request) return;
      setData(state);
      setPhase(state ? "ready" : "unsupported");
      schedule(state);
    } catch {
      if (disposed || current !== request) return;
      setPhase("error");
    }
  }

  async function loadSettings(): Promise<void> {
    const port = untrack(calls);
    if (!port) return;
    // The view still works with the default thresholds.
    const next = await port.getSettings().catch(() => null);
    if (next && !disposed) setSettings(next);
  }

  /** Starts the cleanup. A refusal, such as a scan that started meanwhile, rejects for the dialog. */
  async function cleanup(itemIds: string[]): Promise<void> {
    const port = untrack(calls);
    if (!port) return;
    const state = await port.apply({ itemIds });
    if (disposed) return;
    request += 1;
    setData(state);
    setPhase("ready");
    schedule(state);
  }

  onSettled(() => {
    void load({ refresh: true });
    void loadSettings();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  });

  return { phase, data, settings, rescan: () => load({ force: true }), cleanup };
}
