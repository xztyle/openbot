// Optional owner-away wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent: the owner's quiet hours, a
// focus mode, and the "When you're back" list of requests that agents held for the owner.
//
// - `POST /v1/owner/away` `{}` answers the state: `{ settings, systemTimezone (128), focusUntil
//   (epoch ms or null), quiet ({ kind: "quiet-hours" | "focus", until (epoch ms) } or null), held,
//   suppressed: { count, since (epoch ms or null) }, welcome? }`.
//   `settings` is `{ quietHours: { enabled, start ("HH:MM"), end ("HH:MM"), timeZone (128) or null },
//   urgentMoneyUsd (0 to 1000000), heldDeliverAt ("HH:MM" or null) }`. `held` holds at most 200 items,
//   each `{ id (128), agentId (128), kind: "question" | "approval" | "takeover" | "fyi", title (200),
//   detail? (2000), options? (at most 4, 80 each), url? (2048, http or https), channelId? (128),
//   createdAt (epoch ms), seen (boolean) }`. `welcome` is `{ held, suppressed }` (counts) once, in the
//   answer to the first `active` call after the owner was away while something waited.
// - `/v1/owner/away/settings` `{ settings }`, `/v1/owner/away/focus` `{ until (epoch ms or null) }`,
//   `/v1/owner/away/active` `{}` (the app of the owner is in front: the held bundle is shown and the
//   held count drops to zero), and `/v1/owner/away/answer` `{ id, choice? (80), text? (2000),
//   decision?: "approve" | "decline" | "done" | "dismiss" }` answer the state too.
//
// Only the owner and the admins may use the routes; any other member gets 403. A fork host built
// before these routes answers 404, so a client fails closed there and shows nothing of it. Widening
// any of it needs a new route.
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "../runtime-values";
import {
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import type { TeamProtocolV2Json } from "./v2";

export const OWNER_AWAY_CAPABILITY = FORK_HOST_CAPABILITY;

export const OWNER_AWAY_ROUTES = {
  state: "/v1/owner/away",
  settings: "/v1/owner/away/settings",
  focus: "/v1/owner/away/focus",
  active: "/v1/owner/away/active",
  answer: "/v1/owner/away/answer",
} as const;

export const OWNER_HELD_KINDS = ["question", "approval", "takeover", "fyi"] as const;
export type OwnerHeldKind = (typeof OWNER_HELD_KINDS)[number];
export const OWNER_HELD_DECISIONS = ["approve", "decline", "done", "dismiss"] as const;
export type OwnerHeldDecision = (typeof OWNER_HELD_DECISIONS)[number];

export const OWNER_HELD_LIMIT = 200;
export const OWNER_HELD_TITLE_LIMIT = 200;
export const OWNER_HELD_DETAIL_LIMIT = 2_000;
export const OWNER_HELD_OPTION_LIMIT = 80;
export const OWNER_HELD_OPTIONS = 4;
export const OWNER_AWAY_MONEY_LIMIT = 1_000_000;

export interface OwnerQuietHours {
  enabled: boolean;
  /** "HH:MM", 24 hours, in `timeZone`. */
  start: string;
  end: string;
  /** An IANA zone, or null for the server's zone. */
  timeZone: string | null;
}

export interface OwnerAwaySettings {
  quietHours: OwnerQuietHours;
  /** A money alert of at least this many US dollars still pushes in quiet hours and focus. */
  urgentMoneyUsd: number;
  /** "HH:MM" in the quiet hours zone: the held requests that wait are pushed as one notice then; null, only when back. */
  heldDeliverAt: string | null;
}

export const DEFAULT_OWNER_AWAY_SETTINGS: OwnerAwaySettings = {
  quietHours: { enabled: true, start: "23:00", end: "08:00", timeZone: null },
  urgentMoneyUsd: 100,
  heldDeliverAt: null,
};

export interface OwnerHeldItem {
  id: string;
  agentId: string;
  kind: OwnerHeldKind;
  title: string;
  detail?: string;
  options?: string[];
  url?: string;
  channelId?: string;
  createdAt: number;
  /** The owner saw it in the bundle, in the app. */
  seen: boolean;
}

export interface OwnerAwayState {
  settings: OwnerAwaySettings;
  systemTimezone: string;
  focusUntil: number | null;
  quiet: { kind: "quiet-hours" | "focus"; until: number } | null;
  held: OwnerHeldItem[];
  /** The pushes that quiet hours or focus held back since `since`; one notice sums them up at the end. */
  suppressed: { count: number; since: number | null };
  /** Once, after the owner came back: what waited. */
  welcome?: { held: number; suppressed: number };
}

export interface OwnerHeldAnswer {
  id: string;
  choice?: string;
  text?: string;
  decision?: OwnerHeldDecision;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/u;

/** Whether `value` is a time of day as "HH:MM". */
export function isClockTime(value: unknown): value is string {
  return isString(value) && CLOCK.test(value);
}

type Decoder = (value: unknown) => TeamProtocolV2Json;

const clock: Decoder = (value) => {
  if (!isClockTime(value)) throw new Error("Invalid owner away time.");
  return value;
};
const money: Decoder = (value) => {
  const amount = count(value);
  if (typeof amount !== "number" || amount > OWNER_AWAY_MONEY_LIMIT) throw new Error("Invalid owner away amount.");
  return amount;
};
const httpUrl: Decoder = (value) => {
  const text = string(2_048)(value);
  if (typeof text !== "string" || !/^https?:\/\//iu.test(text)) throw new Error("Invalid owner away address.");
  return text;
};

const settings = fields({
  quietHours: fields({ enabled: boolean, start: clock, end: clock, timeZone: nullable(string(128)) }),
  urgentMoneyUsd: money,
  heldDeliverAt: nullable(clock),
});

const heldItem = fields(
  {
    id: identifier,
    agentId: identifier,
    kind: oneOf(...OWNER_HELD_KINDS),
    title: string(OWNER_HELD_TITLE_LIMIT),
    createdAt: count,
    seen: boolean,
  },
  {
    detail: string(OWNER_HELD_DETAIL_LIMIT),
    options: list(string(OWNER_HELD_OPTION_LIMIT), OWNER_HELD_OPTIONS),
    url: httpUrl,
    channelId: identifier,
  },
);

const state = fields(
  {
    settings,
    systemTimezone: string(128),
    focusUntil: nullable(count),
    quiet: nullable(fields({ kind: oneOf("quiet-hours", "focus"), until: count })),
    held: list(heldItem, OWNER_HELD_LIMIT),
    suppressed: fields({ count, since: nullable(count) }),
  },
  { welcome: fields({ held: count, suppressed: count }) },
);

export const OWNER_AWAY_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [OWNER_AWAY_ROUTES.state, adminRoute(empty, state)],
  [OWNER_AWAY_ROUTES.settings, adminRoute(fields({ settings }), state)],
  [OWNER_AWAY_ROUTES.focus, adminRoute(fields({ until: nullable(count) }), state)],
  [OWNER_AWAY_ROUTES.active, adminRoute(empty, state)],
  [
    OWNER_AWAY_ROUTES.answer,
    adminRoute(
      fields(
        { id: identifier },
        {
          choice: string(OWNER_HELD_OPTION_LIMIT),
          text: string(OWNER_HELD_DETAIL_LIMIT),
          decision: oneOf(...OWNER_HELD_DECISIONS),
        },
      ),
      state,
    ),
  ],
]);

function clockOr(value: unknown, fallback: string): string {
  return isClockTime(value) ? value : fallback;
}

function finite(value: unknown): number | null {
  return isNumber(value) && Number.isFinite(value) ? value : null;
}

/**
 * Settings from a stored or decoded value: each field that is missing or out of bounds takes its
 * default, so an old or damaged file still gives settings. `validZone` checks a time zone.
 */
export function ownerAwaySettingsFrom(value: unknown, validZone: (zone: string) => boolean): OwnerAwaySettings {
  const fallback = DEFAULT_OWNER_AWAY_SETTINGS;
  const record = isDynamicRecord(value) ? value : {};
  const hours = isDynamicRecord(record.quietHours) ? record.quietHours : {};
  const money = finite(record.urgentMoneyUsd);
  const zone = hours.timeZone;
  return {
    quietHours: {
      enabled: isBoolean(hours.enabled) ? hours.enabled : fallback.quietHours.enabled,
      start: clockOr(hours.start, fallback.quietHours.start),
      end: clockOr(hours.end, fallback.quietHours.end),
      timeZone: isString(zone) && zone.length <= 128 && validZone(zone) ? zone : null,
    },
    urgentMoneyUsd:
      money !== null && money >= 0 && money <= OWNER_AWAY_MONEY_LIMIT ? Math.round(money) : fallback.urgentMoneyUsd,
    heldDeliverAt: isClockTime(record.heldDeliverAt) ? record.heldDeliverAt : null,
  };
}

function clipText(text: string, limit: number): string {
  const line = text.trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/** A held item from a stored or decoded value, with its texts cut to their limits; null when it is not one. */
export function ownerHeldItemFrom(value: unknown): OwnerHeldItem | null {
  if (!isDynamicRecord(value)) return null;
  const { id, agentId, kind, title, detail, options, url, channelId, createdAt } = value;
  if (!isString(id) || !isString(agentId) || !isString(title) || !isOneOf(OWNER_HELD_KINDS, kind)) return null;
  const created = finite(createdAt);
  if (created === null) return null;
  const choices = Array.isArray(options)
    ? options
        .filter(isString)
        .slice(0, OWNER_HELD_OPTIONS)
        .map((option) => clipText(option, OWNER_HELD_OPTION_LIMIT))
    : [];
  return {
    id,
    agentId,
    kind,
    title: clipText(title, OWNER_HELD_TITLE_LIMIT),
    ...(isString(detail) && detail.trim() ? { detail: clipText(detail, OWNER_HELD_DETAIL_LIMIT) } : {}),
    ...(choices.length ? { options: choices } : {}),
    ...(isString(url) && url.length <= 2_048 && /^https?:\/\//iu.test(url) ? { url } : {}),
    ...(isString(channelId) && channelId ? { channelId } : {}),
    createdAt: created,
    seen: value.seen === true,
  };
}

/** The state in its wire shape, as a client reads it. Throws on a malformed one. */
export function decodeOwnerAwayState(value: unknown): OwnerAwayState {
  const decoded = state(value);
  if (!isDynamicRecord(decoded)) throw new Error("Invalid owner away state.");
  const quiet = isDynamicRecord(decoded.quiet) ? decoded.quiet : null;
  const suppressed = isDynamicRecord(decoded.suppressed) ? decoded.suppressed : {};
  const welcome = isDynamicRecord(decoded.welcome) ? decoded.welcome : null;
  return {
    settings: ownerAwaySettingsFrom(decoded.settings, () => true),
    systemTimezone: isString(decoded.systemTimezone) ? decoded.systemTimezone : "UTC",
    focusUntil: finite(decoded.focusUntil),
    quiet:
      quiet && (quiet.kind === "quiet-hours" || quiet.kind === "focus")
        ? { kind: quiet.kind, until: finite(quiet.until) ?? 0 }
        : null,
    held: (Array.isArray(decoded.held) ? decoded.held : [])
      .map(ownerHeldItemFrom)
      .filter((item): item is OwnerHeldItem => item !== null),
    suppressed: { count: finite(suppressed.count) ?? 0, since: finite(suppressed.since) },
    ...(welcome ? { welcome: { held: finite(welcome.held) ?? 0, suppressed: finite(welcome.suppressed) ?? 0 } } : {}),
  };
}

/** The settings of a request body. Throws on malformed settings. */
export function decodeOwnerAwaySettings(value: unknown, validZone: (zone: string) => boolean): OwnerAwaySettings {
  settings(value);
  return ownerAwaySettingsFrom(value, validZone);
}

/** The answer of a request body, or null when it is malformed. */
export function decodeOwnerHeldAnswer(value: unknown): OwnerHeldAnswer | null {
  if (!isDynamicRecord(value) || !isString(value.id) || !value.id) return null;
  const { id, choice, text, decision } = value;
  if (choice !== undefined && !(isString(choice) && choice.length <= OWNER_HELD_OPTION_LIMIT)) return null;
  if (text !== undefined && !(isString(text) && text.length <= OWNER_HELD_DETAIL_LIMIT)) return null;
  if (decision !== undefined && !isOneOf(OWNER_HELD_DECISIONS, decision)) return null;
  return {
    id,
    ...(isString(choice) ? { choice } : {}),
    ...(isString(text) ? { text } : {}),
    ...(decision === undefined ? {} : { decision }),
  };
}
