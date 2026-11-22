/*
 * The owner's quiet hours, focus and "When you're back" list, as the web client reads them from the
 * host (`owner-away-v1`, under `fork-host-v1`). Only the owner and the admins have it.
 *
 * While the app is in front, it tells the host so (`active`): the held requests that waited are then
 * shown, once, as the bundle, and the host pushes nothing that the owner already sees. The list is
 * read again each minute while the page is visible; a held request is not urgent by definition, so a
 * minute is soon enough, and it costs one small read.
 */
import {
  decodeOwnerAwayState,
  OWNER_AWAY_ROUTES,
  type OwnerAwaySettings,
  type OwnerAwayState,
  type OwnerHeldAnswer,
} from "@openbot/contracts/team-protocol/owner-away-v1";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import type { TextValue } from "@openbot/ui/text";
import { createEffect, createSignal, onCleanup } from "solid-js";

const READ_MS = 60_000;
const ACTIVE_MS = 4 * 60_000;

export interface OwnerAwayStore {
  /** The state, or null before the first read and on a host without it. */
  state: () => OwnerAwayState | null;
  /** The host has the routes and the reader may use them. */
  supported: () => boolean;
  setFocus: (until: number | null) => Promise<void>;
  saveSettings: (settings: OwnerAwaySettings) => Promise<void>;
  answer: (answer: OwnerHeldAnswer) => Promise<void>;
  /** Asks the host again now. */
  refresh: () => void;
}

export interface OwnerAwayStoreInput {
  request: () => TeamApiRequest | undefined;
  /** The host is online, has `fork-host-v1`, and the reader is its owner or an admin. */
  enabled: () => boolean;
  /** The host the state belongs to: another host starts again. */
  hostId: () => string;
  /** Called once after the owner came back while something waited. */
  onWelcome?: (welcome: NonNullable<OwnerAwayState["welcome"]>) => void;
}

/** What waited, for the welcome: "1 held request, 3 notifications". A count of zero is left out. */
export function ownerAwayWelcomeParts(welcome: NonNullable<OwnerAwayState["welcome"]>, t: TextValue["t"]): string {
  return [
    welcome.held > 0 ? t("workspace.away.welcomeHeld", { count: welcome.held }) : "",
    welcome.suppressed > 0 ? t("workspace.away.welcomeSuppressed", { count: welcome.suppressed }) : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Whether the owner's quiet hours or focus are on now, from the last read of the state. The page then
 * keeps its own notifications and cues, as the host keeps its pushes. Null state (no read yet, or no
 * such host) is not quiet.
 */
export function ownerAwayQuietNow(state: OwnerAwayState | null, now = Date.now()): boolean {
  const quiet = state?.quiet;
  return quiet != null && quiet.until > now;
}

function inFront(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

/** The local time of the next `clock` ("HH:MM") after now, in the browser's zone. */
export function nextClockTime(clock: string, now = Date.now()): number {
  const [hours, minutes] = clock.split(":").map(Number);
  const next = new Date(now);
  next.setHours(hours ?? 8, minutes ?? 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function createOwnerAwayStore(input: OwnerAwayStoreInput): OwnerAwayStore {
  const [state, setState] = createSignal<OwnerAwayState | null>(null);
  const [unsupported, setUnsupported] = createSignal(false);
  let lastActive = 0;
  let host = "";

  async function call(path: string, body: TeamProtocolV2Json = {}): Promise<OwnerAwayState | null> {
    const request = input.request();
    if (!request || !input.enabled() || unsupported()) return null;
    const asked = input.hostId();
    try {
      const next = await request("POST", path, decodeOwnerAwayState, body);
      if (asked !== input.hostId()) return null;
      setState(next);
      if (next.welcome) input.onWelcome?.(next.welcome);
      return next;
    } catch (error) {
      // A host without the routes answers 404: it has none of this, and the client asks no more.
      if (error instanceof Error && "reference" in error && error.reference === "http/404") setUnsupported(true);
      throw error;
    }
  }
  const quiet = (path: string, body?: TeamProtocolV2Json) => void call(path, body).catch(() => undefined);

  function noteActive() {
    if (!inFront()) return;
    const now = Date.now();
    if (now - lastActive < ACTIVE_MS) return;
    lastActive = now;
    quiet(OWNER_AWAY_ROUTES.active);
  }

  createEffect(
    () => [input.enabled(), input.hostId()] as const,
    ([enabled, hostId]) => {
      if (hostId !== host) {
        host = hostId;
        lastActive = 0;
        setState(null);
        setUnsupported(false);
      }
      if (!enabled) return;
      if (inFront()) noteActive();
      else quiet(OWNER_AWAY_ROUTES.state);
    },
  );
  const onFront = () => {
    if (!input.enabled()) return;
    if (inFront()) {
      // Back in front after a while: the bundle, if something waited.
      noteActive();
      return;
    }
  };
  const timer = setInterval(() => {
    if (!input.enabled() || document.visibilityState !== "visible") return;
    if (inFront() && Date.now() - lastActive >= ACTIVE_MS) noteActive();
    else quiet(OWNER_AWAY_ROUTES.state);
  }, READ_MS);
  document.addEventListener("visibilitychange", onFront);
  window.addEventListener("focus", onFront);
  onCleanup(() => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onFront);
    window.removeEventListener("focus", onFront);
  });

  return {
    state,
    supported: () => input.enabled() && !unsupported() && state() !== null,
    setFocus: async (until) => {
      await call(OWNER_AWAY_ROUTES.focus, { until });
    },
    saveSettings: async (settings) => {
      await call(OWNER_AWAY_ROUTES.settings, {
        settings: {
          quietHours: { ...settings.quietHours },
          urgentMoneyUsd: settings.urgentMoneyUsd,
          heldDeliverAt: settings.heldDeliverAt,
        },
      });
    },
    answer: async (answer) => {
      await call(OWNER_AWAY_ROUTES.answer, {
        id: answer.id,
        ...(answer.choice === undefined ? {} : { choice: answer.choice }),
        ...(answer.text === undefined ? {} : { text: answer.text }),
        ...(answer.decision === undefined ? {} : { decision: answer.decision }),
      });
    },
    refresh: () => quiet(OWNER_AWAY_ROUTES.state),
  };
}
