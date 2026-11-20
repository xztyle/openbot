import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { currentText } from "@openbot/ui/text";

/**
 * The lock that says which tab speaks for a host's state to the other tabs of the account. Each tab
 * has its own remote session, so any number of tabs can open the same host at once; the lock only
 * keeps one status connection for each host across the tabs. With `wait`, the request queues until
 * the lock is free or the signal aborts. Without it, the answer is null when another tab holds it.
 */
export async function acquireWebHostLock(
  accountId: string,
  hostId: string,
  options: { wait?: AbortSignal } = {},
): Promise<(() => void) | null> {
  if (!navigator.locks) throw new Error(currentText().t("webClient.error.noLocks"));
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lockOptions: LockOptions = options.wait ? { signal: options.wait } : { ifAvailable: true };
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(`openbot.web.host:${accountId}:${hostId}`, lockOptions, async (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        resolve(release);
        await held;
      })
      .catch(reject);
  });
}

/** The connection state that a tab reports for a host it holds. "unknown" before the first result. */
export type WebHostState = "unknown" | "connecting" | "online" | "offline" | "error" | "incompatible";

/**
 * The messages between the tabs of one account: the tab that holds a host's lock reports its state,
 * and a new tab asks for the states it has missed.
 */
export type WebHostTabMessage = { type: "state"; hostId: string; state: WebHostState } | { type: "query" };

const HOST_STATES = [
  "unknown",
  "connecting",
  "online",
  "offline",
  "error",
  "incompatible",
] as const satisfies readonly WebHostState[];

function isWebHostState(value: unknown): value is WebHostState {
  return HOST_STATES.some((state) => state === value);
}

export function decodeWebHostTabMessage(value: unknown): WebHostTabMessage | null {
  if (!isDynamicRecord(value)) return null;
  if (value.type === "query") return { type: "query" };
  if (!isString(value.hostId)) return null;
  if (value.type === "state" && isWebHostState(value.state))
    return { type: "state", hostId: value.hostId, state: value.state };
  return null;
}

/** Null where the browser has no BroadcastChannel. Then no tab keeps status connections. */
export function openWebHostChannel(accountId: string): BroadcastChannel | null {
  return typeof BroadcastChannel === "function" ? new BroadcastChannel(`openbot.web.hosts:${accountId}`) : null;
}

const TAB_INSTANCE_KEY = "openbot.web.tab-instance";
let tabInstance: Promise<string> | null = null;

/**
 * The ID of this tab, which the account service keeps one remote session for, so each tab has its
 * own peer on a host. A reload keeps it in `sessionStorage` and reuses its session. A tab that the
 * browser duplicated copies that storage; the lock of the ID tells it apart, and it takes a new ID.
 */
export function webTabInstanceId(): Promise<string> {
  tabInstance ??= claimTabInstance();
  return tabInstance;
}

function storedTabInstance(): string | null {
  try {
    return sessionStorage.getItem(TAB_INSTANCE_KEY);
  } catch {
    return null;
  }
}

function holdTabInstance(id: string): Promise<boolean> {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    void navigator.locks
      .request(`openbot.web.tab:${id}`, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Held for the life of the page.
        return lock ? new Promise<void>(() => {}) : undefined;
      })
      .catch(() => resolve(true));
  });
}

async function claimTabInstance(): Promise<string> {
  const stored = storedTabInstance();
  const id = stored && (await holdTabInstance(stored)) ? stored : crypto.randomUUID();
  if (id !== stored) await holdTabInstance(id);
  try {
    sessionStorage.setItem(TAB_INSTANCE_KEY, id);
  } catch {
    // Without storage a reload starts a new session; the account service ends the oldest ones.
  }
  return id;
}
