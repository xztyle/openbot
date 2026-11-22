import { type DynamicRecord, isDynamicRecord, isNumber } from "@openbot/contracts/runtime-values";
import { createEffect, onCleanup, untrack } from "solid-js";
import { emptyWebLocation, parseWebLocation, sameWebPlace, type WebLocation } from "./web-location";

/** The entry index of the site router (`@tanstack/history`). A pop of one step must read as Back or Forward. */
const ROUTER_INDEX_KEY = "__TSR_index";

function stateRecord(state: unknown): DynamicRecord {
  return isDynamicRecord(state) ? state : {};
}

/** The place that the address bar names now. A part that it leaves out is null. */
function addressLocation(): WebLocation {
  return parseWebLocation(window.location.pathname, window.location.search) ?? emptyWebLocation();
}

function currentAddress(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** Whether a place that an address names is shown: the parts it leaves out may be anything. */
export function reachesWebLocation(shown: WebLocation, wanted: WebLocation): boolean {
  return sameWebPlace(shown, {
    hostId: wanted.hostId ?? shown.hostId,
    space: wanted.space ?? shown.space,
    target: wanted.target ?? shown.target,
    messageId: null,
    page: wanted.page,
  });
}

/**
 * The address bar and Back and Forward of the web client, as in Slack. The address names the place
 * on screen (`web-location.ts`). A place that the user opens gets its own history entry, so Back
 * opens the place before it; a place that opens by itself (a connect, a restore, a deleted agent)
 * only changes the address of the entry on screen. A reload, a new tab or a shared link opens the
 * place of its address once the client can show it.
 *
 * On a phone the panes own Back (`web-pane-history.ts`): the address only follows the place there.
 */
export function createWebLocationHistory(options: {
  /** The place on screen, or null while the client cannot say yet: no server, a load, a form. */
  current: () => WebLocation | null;
  /** The address of a place. */
  href: (location: WebLocation) => string;
  /**
   * Opens a place of the address bar: at the start, or after Back or Forward. A place on another
   * server connects to it and answers true; the place opens when that server shows. False when it
   * cannot open here: the client then shows what it can, and the address follows.
   */
  open: (location: WebLocation) => boolean;
  /** A place of another server that did not open after the switch to it. */
  unavailable: (location: WebLocation) => void;
  /** False on a phone: the panes own Back there, and a place gets no entry of its own. */
  ownEntries: () => boolean;
  /** The place to open at the start, when the address of the page names one. */
  initial: WebLocation | null;
  /**
   * False when the page is not the web client's own (`/app`), such as a story or the site's preview:
   * the address and the history are then left alone.
   */
  enabled: boolean;
}) {
  /** The place of the address that waits until the client can show it. */
  let pending: WebLocation | null = options.initial;
  /** The switch to the server of a pending place: the server it left, so a failed switch ends the wait. */
  let switching: { to: string; from: string | null } | null = null;
  /** The next place that matches gets a new entry. */
  let pushMatch: ((location: WebLocation) => boolean) | null = null;
  /** While a place of the address opens, the places on the way only change the address. */
  let quiet = false;
  /** The place that the address shows now. */
  let shown: WebLocation | null = null;

  function write(location: WebLocation, push: boolean): void {
    shown = location;
    if (!options.enabled) return;
    const href = options.href(location);
    if (!push && href === currentAddress()) return;
    const state = stateRecord(window.history.state);
    if (push) {
      const key = crypto.randomUUID();
      const index = state[ROUTER_INDEX_KEY];
      window.history.pushState(
        { [ROUTER_INDEX_KEY]: (isNumber(index) ? index : 0) + 1, key, __TSR_key: key },
        "",
        href,
      );
      return;
    }
    window.history.replaceState(state, "", href);
  }

  /**
   * The next place that `match` accepts gets a new entry. Without `wait`, a move that changes nothing
   * in this task adds no entry later.
   */
  function arm(match: (location: WebLocation) => boolean, wait: boolean): void {
    pushMatch = match;
    if (wait) return;
    setTimeout(() => {
      if (pushMatch === match) pushMatch = null;
    }, 0);
  }

  /**
   * Opens the waiting place. A place of the address (`user` false) changes only the address of the
   * entry on screen, also with the steps on its way; a link that the user follows gets an entry.
   */
  function openPending(now: WebLocation, user = false): void {
    const target = pending;
    if (!target) return;
    pushMatch = null;
    if (target.hostId && target.hostId !== now.hostId) {
      // The switch is still on its way while the client shows the server it left.
      if (switching?.to === target.hostId && now.hostId === switching.from) return;
      if (switching?.to === target.hostId) {
        // The client shows another server than the one of the address.
        pending = null;
        switching = null;
        options.unavailable(target);
        write(now, false);
        return;
      }
      switching = { to: target.hostId, from: now.hostId };
      if (user) arm((location) => location.hostId === target.hostId, true);
      if (options.open(target)) return;
      pending = null;
      switching = null;
      write(now, false);
      return;
    }
    pending = null;
    switching = null;
    if (user) arm((location) => !sameWebPlace(location, now), false);
    else {
      quiet = true;
      setTimeout(() => {
        quiet = false;
      }, 0);
    }
    options.open(target);
    // A place that opened as it was, or a fallback to the place on screen, changes nothing that the
    // address follows: the address then takes the place on screen.
    setTimeout(() => {
      if (pending) return;
      const opened = untrack(options.current);
      if (opened && options.href(opened) !== currentAddress()) write(opened, false);
    }, 0);
  }

  function sync(): void {
    const location = options.current();
    if (!location) return;
    if (pending) {
      openPending(location);
      // The address keeps the place it names; the place that opens writes it.
      return;
    }
    const previous = shown;
    const userMove = pushMatch?.(location) === true;
    if (userMove) pushMatch = null;
    // A conversation of another space that the user opens shows its space a step before it shows
    // itself. The entry keeps the place before, so Back returns to the space the user came from;
    // the conversation gets its own entry when it shows.
    if (
      !userMove &&
      pushMatch !== null &&
      !quiet &&
      previous !== null &&
      previous.hostId === location.hostId &&
      previous.space !== location.space &&
      untrack(options.ownEntries)
    )
      return;
    if (previous && sameWebPlace(previous, location) && previous.messageId === location.messageId) {
      if (options.href(location) !== currentAddress()) write(location, false);
      return;
    }
    // A page that opens or closes is a step of its own, as a place is.
    const pageMove = previous !== null && previous.page?.kind !== location.page?.kind;
    write(location, !quiet && (userMove || pageMove) && untrack(options.ownEntries));
  }

  createEffect(
    () => {
      const location = options.current();
      return location ? options.href(location) : null;
    },
    () => untrack(sync),
  );

  const onPopState = () => {
    pushMatch = null;
    switching = null;
    // On a phone the step was between the panes; the entry can hold the address of an older place.
    if (!untrack(options.ownEntries)) {
      const now = untrack(options.current);
      if (now) write(now, false);
      return;
    }
    const wanted = addressLocation();
    const now = untrack(options.current);
    if (now && reachesWebLocation(now, wanted)) {
      pending = null;
      shown = now;
      return;
    }
    pending = wanted;
    shown = null;
    if (now) openPending(now);
  };
  if (options.enabled) {
    window.addEventListener("popstate", onPopState);
    onCleanup(() => window.removeEventListener("popstate", onPopState));
  }

  /** Gives the place that the user opens now its own entry: the next place that `match` accepts. */
  function userOpens(match: (location: WebLocation) => boolean, wait = false): void {
    // A place of the address that opens calls the same actions as the user.
    if (quiet) return;
    pending = null;
    switching = null;
    const now = untrack(options.current);
    if (now && match(now)) {
      pushMatch = null;
      return;
    }
    arm(match, wait);
  }

  return {
    userOpens,
    /** Gives the next place that differs from the one on screen its own entry. */
    userMoves(wait = false): void {
      const now = untrack(options.current);
      userOpens((location) => !now || !sameWebPlace(location, now), wait);
    },
    /** Opens a place that a link in the client names, as a step that Back undoes. */
    go(location: WebLocation): void {
      if (quiet) return;
      const now = untrack(options.current);
      if (!now) return;
      pending = location;
      switching = null;
      openPending(now, true);
    },
  };
}
