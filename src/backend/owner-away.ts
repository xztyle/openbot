import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  DEFAULT_OWNER_AWAY_SETTINGS,
  OWNER_HELD_DETAIL_LIMIT,
  OWNER_HELD_LIMIT,
  OWNER_HELD_OPTION_LIMIT,
  OWNER_HELD_OPTIONS,
  OWNER_HELD_TITLE_LIMIT,
  type OwnerAwaySettings,
  type OwnerAwayState,
  type OwnerHeldAnswer,
  type OwnerHeldItem,
  type OwnerHeldKind,
  ownerAwaySettingsFrom,
  ownerHeldItemFrom,
} from "@openbot/contracts/team-protocol/owner-away-v1";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Result } from "effect";
import { writeJsonFileAtomically } from "./atomic-json-file";

const logger = createOpenBotLogger("owner-away");

/** The owner is away when the app was not in front for this long. */
export const OWNER_AWAY_AFTER_MS = 10 * 60_000;
/** The open held requests of one agent. One more is refused, so an agent cannot fill the list. */
const AGENT_HELD_LIMIT = 20;
/** The suppressed notices that one summary counts; more add to the count only. */
const SUPPRESSED_KEYS_LIMIT = 500;
const TICK_MS = 60_000;
const SAVE_DELAY_MS = 1_000;
const FOCUS_LIMIT_MS = 7 * 24 * 60 * 60_000;
/** One alert of each kind from each agent in this time; more are refused. */
const ALERT_REPEAT_MS = 15 * 60_000;

/** The urgent kinds of alert that quiet hours and focus let through (`alert_owner`). */
export type OwnerAlertCategory = "money" | "outage" | "security";

export interface OwnerHoldInput {
  agentId: string;
  kind: OwnerHeldKind;
  title: string;
  detail?: string | undefined;
  options?: readonly string[] | undefined;
  url?: string | undefined;
  channelId?: string | undefined;
}

/** A refusal that the agent reads: the text is a sentence for it. */
export class OwnerHoldRefused extends Error {}

/** The held request is gone: answered on another device, or removed. */
export class OwnerHeldMissing extends Error {}

/** One summary notice that the host pushes to the owner's browsers. */
export interface OwnerAwayNotice {
  kind: "held-bundle" | "away-digest";
  /** The notices held back (`away-digest`), or the held requests that wait (`held-bundle`). */
  count: number;
  /** The held requests that the owner has not seen yet. */
  held: number;
  /** An agent of the held requests, for the space of the address that a tap opens. */
  agentId: string | null;
}

/** An alert of an agent that may wake the owner (`alert_owner`). */
export interface OwnerAlert {
  agentId: string;
  category: OwnerAlertCategory;
  amountUsd?: number | undefined;
  /** Through quiet hours and focus: an outage, a security event, or money at or over the limit. */
  urgent: boolean;
}

export interface OwnerAwayOptions {
  /** `<userData>/owner-away-v1.json`. */
  file: string;
  /** The server's zone, for quiet hours without a zone of their own. */
  serverTimezone: () => string;
  /** Gives the owner's answer to the agent that held the request, as a message from the owner. */
  deliver: (agentId: string, text: string, key: string) => void;
  /** Pushes one summary notice to the owner's browsers. */
  push: (notice: OwnerAwayNotice) => void;
  /** Pushes an agent's alert to the owner's browsers. */
  alert: (alert: OwnerAlert) => void;
  /** The name of an agent, for the answer it gets. */
  agentName?: (agentId: string) => string | undefined;
  now?: () => number;
  /** The clock of the summaries. Scripts make it fast. */
  tickMs?: number;
}

interface StoredState {
  version: 1;
  settings: OwnerAwaySettings;
  focusUntil: number | null;
  held: OwnerHeldItem[];
  suppressedKeys: string[];
  suppressedCount: number;
  suppressedSince: number | null;
  lastActiveAt: number | null;
  /** The local day ("YYYY-MM-DD") on which the held bundle was pushed at `heldDeliverAt`. */
  bundlePushedOn: string | null;
}

function clip(text: string, limit: number): string {
  const line = text.trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

function minutes(clock: string): number {
  const [hours, mins] = clock.split(":").map(Number);
  return (hours ?? 0) * 60 + (mins ?? 0);
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The local day and minute of the day of `at` in `zone`. */
export function localClock(at: number, zone: string): { day: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return {
    day: `${part("year")}-${part("month")}-${part("day")}`,
    minute: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

/**
 * Whether `at` falls in the quiet hours, and when they end. A window that starts after it ends runs
 * over midnight (23:00 to 08:00). The end is accurate to the minute; a change of the clock that day
 * moves it by the hour of the change.
 */
export function quietWindow(
  at: number,
  start: string,
  end: string,
  zone: string,
): { quiet: true; until: number } | { quiet: false; until: number } | null {
  const from = minutes(start);
  const to = minutes(end);
  if (from === to) return null;
  const { minute } = localClock(at, zone);
  const quiet = from < to ? minute >= from && minute < to : minute >= from || minute < to;
  if (!quiet) return { quiet: false, until: at };
  const left = (to - minute + 1_440) % 1_440;
  const seconds = new Date(at).getUTCSeconds() * 1_000 + new Date(at).getUTCMilliseconds();
  return { quiet: true, until: at + left * 60_000 - seconds };
}

function normalizedSettings(value: unknown): OwnerAwaySettings {
  return ownerAwaySettingsFrom(value, validZone);
}

/**
 * The owner's availability: quiet hours, a focus mode, and the "When you're back" list of requests
 * that agents held for the owner instead of asking now (`hold_for_owner`).
 *
 * In quiet hours or focus, the host's pushes wait (`allowPush`), except urgent alerts; when the quiet
 * time ends, one notice sums up what was held back. A held request never pushes on its own: the
 * owner sees the list when the app comes to the front (`noteActive`), or one notice at the time they
 * chose (`heldDeliverAt`). The answer goes back to the agent as a message from the owner, so the agent
 * keeps working on other things meanwhile.
 *
 * The state is one small JSON file of the host profile: settings, the held list (at most 200) and
 * the counters. It holds no text of a chat other than what the agent wrote in the held request.
 */
export class OwnerAwayService {
  readonly #options: OwnerAwayOptions;
  #state: StoredState;
  #wasQuiet = false;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #tick: ReturnType<typeof setInterval> | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #alerts = new Map<string, number>();

  constructor(options: OwnerAwayOptions) {
    this.#options = options;
    this.#state = this.#load();
    // A host that restarts after the quiet time still owes the summary of what it held back.
    this.#wasQuiet = this.quietNow() !== null || this.#state.suppressedCount > 0;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #load(): StoredState {
    const empty: StoredState = {
      version: 1,
      settings: structuredClone(DEFAULT_OWNER_AWAY_SETTINGS),
      focusUntil: null,
      held: [],
      suppressedKeys: [],
      suppressedCount: 0,
      suppressedSince: null,
      lastActiveAt: null,
      bundlePushedOn: null,
    };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#options.file, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        logger.warn("The owner away state could not be read. It starts empty.");
      return empty;
    }
    if (!isDynamicRecord(raw)) return empty;
    const record = raw;
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    return {
      version: 1,
      settings: normalizedSettings(record.settings),
      focusUntil: number(record.focusUntil),
      held: (Array.isArray(record.held) ? record.held : [])
        .map(ownerHeldItemFrom)
        .filter((item): item is OwnerHeldItem => item !== null)
        .slice(-OWNER_HELD_LIMIT),
      suppressedKeys: (Array.isArray(record.suppressedKeys) ? record.suppressedKeys : [])
        .filter((key): key is string => typeof key === "string")
        .slice(-SUPPRESSED_KEYS_LIMIT),
      suppressedCount: Math.max(0, number(record.suppressedCount) ?? 0),
      suppressedSince: number(record.suppressedSince),
      lastActiveAt: number(record.lastActiveAt),
      bundlePushedOn: typeof record.bundlePushedOn === "string" ? record.bundlePushedOn : null,
    };
  }

  #changed(): void {
    if (!this.#saveTimer) {
      this.#saveTimer = setTimeout(() => {
        this.#saveTimer = null;
        void this.#save();
      }, SAVE_DELAY_MS);
      this.#saveTimer.unref?.();
    }
    for (const listener of this.#listeners) listener();
  }

  #save(): Promise<void> {
    return Effect.runPromise(
      Effect.result(writeJsonFileAtomically(this.#options.file, this.#state, { createDirectory: true })).pipe(
        Effect.tap((written) =>
          Effect.sync(() => {
            if (Result.isFailure(written)) logger.warn("The owner away state could not be saved.");
          }),
        ),
        Effect.asVoid,
      ),
    );
  }

  /** Calls `listener` after each change of the state. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts the clock of the summaries: the end of quiet hours, and `heldDeliverAt`. */
  start(): void {
    if (this.#tick) return;
    this.#tick = setInterval(() => this.tick(), this.#options.tickMs ?? TICK_MS);
    this.#tick.unref?.();
  }

  /** Stops the clock and writes a change that waits. */
  async stop(): Promise<void> {
    if (this.#tick) clearInterval(this.#tick);
    this.#tick = null;
    if (!this.#saveTimer) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    await this.#save();
  }

  zone(): string {
    const zone = this.#state.settings.quietHours.timeZone;
    return zone ?? this.#options.serverTimezone();
  }

  /** Quiet hours or focus now, and when it ends; null when the owner can be reached. */
  quietNow(now = this.#now()): OwnerAwayState["quiet"] {
    const focus = this.#state.focusUntil;
    if (focus !== null && focus > now) return { kind: "focus", until: focus };
    const hours = this.#state.settings.quietHours;
    if (!hours.enabled) return null;
    const window = quietWindow(now, hours.start, hours.end, this.zone());
    return window?.quiet ? { kind: "quiet-hours", until: window.until } : null;
  }

  /** Whether the owner used the app within `OWNER_AWAY_AFTER_MS`. */
  activeNow(now = this.#now()): boolean {
    const last = this.#state.lastActiveAt;
    return last !== null && now - last < OWNER_AWAY_AFTER_MS;
  }

  state(welcome?: OwnerAwayState["welcome"]): OwnerAwayState {
    const now = this.#now();
    const focus = this.#state.focusUntil;
    return {
      settings: structuredClone(this.#state.settings),
      systemTimezone: this.#options.serverTimezone(),
      focusUntil: focus !== null && focus > now ? focus : null,
      quiet: this.quietNow(now),
      held: this.#state.held.map((item) => structuredClone(item)),
      suppressed: { count: this.#state.suppressedCount, since: this.#state.suppressedSince },
      ...(welcome ? { welcome } : {}),
    };
  }

  setSettings(settings: OwnerAwaySettings): OwnerAwayState {
    const zone = settings.quietHours.timeZone;
    if (zone !== null && !validZone(zone)) throw new OwnerHoldRefused(sourceText("error.team.ownerAwayZone"));
    this.#state.settings = normalizedSettings(settings);
    this.#changed();
    this.tick();
    return this.state();
  }

  /** Focus mode until `until`, or off with null. A focus in the past is off; one beyond a week is cut. */
  setFocus(until: number | null): OwnerAwayState {
    const now = this.#now();
    this.#state.focusUntil = until === null || until <= now ? null : Math.min(until, now + FOCUS_LIMIT_MS);
    this.#changed();
    this.tick();
    return this.state();
  }

  /**
   * The owner's app is in front. After a time away, the held requests that wait are the bundle: they
   * count as seen, and the answer says what waited, once.
   */
  noteActive(): OwnerAwayState {
    const now = this.#now();
    const away = !this.activeNow(now);
    this.#state.lastActiveAt = now;
    const unseen = this.#state.held.filter((item) => !item.seen).length;
    const suppressed = this.#state.suppressedCount;
    let welcome: OwnerAwayState["welcome"];
    if (away && (unseen > 0 || suppressed > 0)) welcome = { held: unseen, suppressed };
    if (unseen > 0) for (const item of this.#state.held) item.seen = true;
    // The owner looks now, so a summary at the end of the quiet time would repeat what they see.
    this.#clearSuppressed();
    this.#changed();
    return this.state(welcome);
  }

  #clearSuppressed(): void {
    this.#state.suppressedKeys = [];
    this.#state.suppressedCount = 0;
    this.#state.suppressedSince = null;
  }

  /**
   * Whether a push may go now. In quiet hours and focus it waits, unless it is urgent; each notice
   * that waits counts once (`key`) for the summary at the end.
   */
  allowPush(key: string, urgent: boolean): boolean {
    if (urgent || this.quietNow() === null) return true;
    if (!this.#state.suppressedKeys.includes(key)) {
      this.#state.suppressedKeys.push(key);
      if (this.#state.suppressedKeys.length > SUPPRESSED_KEYS_LIMIT) this.#state.suppressedKeys.shift();
      this.#state.suppressedCount += 1;
      this.#state.suppressedSince ??= this.#now();
      this.#changed();
    }
    return false;
  }

  /** Whether an alert of this kind and amount is urgent: an outage, a security event, or money over the limit. */
  urgentAlert(category: OwnerAlertCategory, amountUsd?: number): boolean {
    if (category !== "money") return true;
    return amountUsd !== undefined && Math.abs(amountUsd) >= this.#state.settings.urgentMoneyUsd;
  }

  /**
   * Pushes an agent's alert now. It goes through quiet hours and focus only when it is urgent; one
   * alert of each kind per agent per 15 minutes, so a loop cannot wake the owner again and again.
   */
  alert(input: Omit<OwnerAlert, "urgent">): { sent: boolean; urgent: boolean } {
    const urgent = this.urgentAlert(input.category, input.amountUsd);
    const key = `${input.agentId}\n${input.category}`;
    const now = this.#now();
    if (now - (this.#alerts.get(key) ?? Number.NEGATIVE_INFINITY) < ALERT_REPEAT_MS) return { sent: false, urgent };
    this.#alerts.set(key, now);
    if (this.#alerts.size > 500) this.#alerts.clear();
    this.#options.alert({ ...input, urgent });
    return { sent: true, urgent };
  }

  /** One line for an agent's turn while the owner is quiet, or null when they can be reached. */
  turnNote(): string | null {
    const quiet = this.quietNow();
    if (!quiet) return null;
    const zone = this.zone();
    const until = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      weekday: quiet.until - this.#now() > 20 * 60 * 60_000 ? "short" : undefined,
    }).format(new Date(quiet.until));
    const what = quiet.kind === "focus" ? "in focus mode" : "in quiet hours";
    return `Owner status: ${what} until ${until} (${zone}). Do not ping them: batch what can wait with openbot.hold_for_owner and keep working; only a real emergency (money over $${this.#state.settings.urgentMoneyUsd}, an outage, security) goes through openbot.alert_owner.`;
  }

  /** Adds a request to the "When you're back" list. */
  hold(input: OwnerHoldInput): OwnerHeldItem {
    const own = this.#state.held.filter((item) => item.agentId === input.agentId);
    if (own.length >= AGENT_HELD_LIMIT)
      throw new OwnerHoldRefused(
        `You already hold ${AGENT_HELD_LIMIT} requests for the owner. Wait for their answers, or fold this one into the next update.`,
      );
    const title = clip(input.title, OWNER_HELD_TITLE_LIMIT);
    // The same request again, as a retried tool call, is the one already held.
    const same = own.find((item) => item.kind === input.kind && item.title === title);
    if (same) return structuredClone(same);
    const item: OwnerHeldItem = {
      id: `held-${randomUUID()}`,
      agentId: input.agentId,
      kind: input.kind,
      title,
      ...(input.detail?.trim() ? { detail: clip(input.detail, OWNER_HELD_DETAIL_LIMIT) } : {}),
      ...(input.kind === "question" && input.options?.length
        ? {
            options: input.options
              .map((option) => clip(option, OWNER_HELD_OPTION_LIMIT))
              .filter(Boolean)
              .slice(0, OWNER_HELD_OPTIONS),
          }
        : {}),
      ...(input.url && /^https?:\/\//iu.test(input.url) && input.url.length <= 2_048 ? { url: input.url } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      createdAt: this.#now(),
      // The owner looks at the app now: the item is in front of them, not in a bundle for later.
      seen: false,
    };
    this.#state.held.push(item);
    if (this.#state.held.length > OWNER_HELD_LIMIT) this.#state.held.shift();
    this.#changed();
    return structuredClone(item);
  }

  /** The owner answered a held request: the agent gets the answer, and the item leaves the list. */
  answer(answer: OwnerHeldAnswer): OwnerAwayState {
    const index = this.#state.held.findIndex((item) => item.id === answer.id);
    const item = this.#state.held[index];
    if (!item) throw new OwnerHeldMissing(sourceText("error.team.ownerHeldAnswered"));
    const text = this.#answerText(item, answer);
    this.#state.held.splice(index, 1);
    this.#changed();
    if (text) this.#options.deliver(item.agentId, text, item.id);
    return this.state();
  }

  /** The message that the agent gets, or null for an FYI the owner only read. */
  #answerText(item: OwnerHeldItem, answer: OwnerHeldAnswer): string | null {
    const note = answer.text?.trim() ? clip(answer.text, OWNER_HELD_DETAIL_LIMIT) : "";
    const about = `“${item.title}”`;
    if (answer.decision === "dismiss")
      return item.kind === "fyi" && !note
        ? null
        : `About ${about}, which you held for me: ${note || "dismissed, no answer needed."}`;
    if (item.kind === "approval") {
      const verdict = answer.decision === "decline" ? "Declined" : "Approved";
      return `${verdict}: ${about}, which you held for my approval.${note ? ` ${note}` : ""}`;
    }
    if (item.kind === "takeover") {
      return answer.decision === "decline"
        ? `I could not do ${about}, the step you held for me.${note ? ` ${note}` : ""} Find another way or ask again later.`
        : `Done: ${about}, the step you held for me.${note ? ` ${note}` : ""} Continue.`;
    }
    if (item.kind === "fyi") return note ? `About ${about}: ${note}` : null;
    const reply = [answer.choice?.trim(), note].filter(Boolean).join(" — ");
    if (!reply) throw new OwnerHoldRefused(sourceText("error.team.ownerHeldNeedsAnswer"));
    return `Answer to ${about}, which you held for me: ${reply}`;
  }

  /** Removes the held requests of an agent that is gone. */
  forgetAgent(agentId: string): void {
    const before = this.#state.held.length;
    this.#state.held = this.#state.held.filter((item) => item.agentId !== agentId);
    if (this.#state.held.length !== before) this.#changed();
  }

  /**
   * The clock: at the end of quiet hours or focus, one notice sums up what was held back; at
   * `heldDeliverAt`, one notice names the held requests that the owner has not seen.
   */
  tick(): void {
    const now = this.#now();
    const quiet = this.quietNow(now) !== null;
    if (this.#wasQuiet && !quiet && this.#state.suppressedCount > 0) {
      const count = this.#state.suppressedCount;
      this.#clearSuppressed();
      this.#changed();
      const unseen = this.#state.held.filter((item) => !item.seen);
      if (!this.activeNow(now))
        this.#options.push({ kind: "away-digest", count, held: unseen.length, agentId: unseen[0]?.agentId ?? null });
    }
    this.#wasQuiet = quiet;
    const deliverAt = this.#state.settings.heldDeliverAt;
    if (!deliverAt) return;
    const local = localClock(now, this.zone());
    if (local.minute < minutes(deliverAt) || this.#state.bundlePushedOn === local.day) return;
    const unseen = this.#state.held.filter((item) => !item.seen);
    this.#state.bundlePushedOn = local.day;
    this.#changed();
    if (unseen.length === 0 || this.activeNow(now)) return;
    this.#options.push({
      kind: "held-bundle",
      count: unseen.length,
      held: unseen.length,
      agentId: unseen[0]?.agentId ?? null,
    });
  }
}
