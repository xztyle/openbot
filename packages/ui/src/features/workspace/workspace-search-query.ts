/*
 * The modifiers of a workspace message search, as Slack reads them in the search field:
 * `in:#channel`, `in:@person`, `from:@person`, `from:me`, `before:`, `after:`, `on:` and `during:`
 * with a date, and `is:thread`. The rest of the text goes to the host as it is: words, `"a phrase"`
 * and `-word`. The module has no DOM and no state; a client resolves the names to ids.
 */

export const SEARCH_MODIFIERS = ["in", "from", "before", "after", "on", "during", "is"] as const;
export type SearchModifier = (typeof SEARCH_MODIFIERS)[number];

export interface ParsedSearch {
  /** The words, phrases and exclusions, without the modifiers. */
  text: string;
  /** The names after `in:`, with their `#` or `@`. */
  in: string[];
  /** The names after `from:`, without `@`. `me` is the reader. */
  from: string[];
  before: string | null;
  after: string | null;
  on: string | null;
  during: string | null;
  /** `is:thread`: only thread replies and the roots of threads. */
  threads: boolean;
}

/** The parts of a query: whitespace splits them, except inside double quotes. */
export function searchTokens(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of query) {
    if (char === '"') quoted = !quoted;
    if (!quoted && /\s/u.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function modifierOf(token: string): { key: SearchModifier; value: string } | null {
  const colon = token.indexOf(":");
  if (colon <= 0) return null;
  const key = SEARCH_MODIFIERS.find((name) => name === token.slice(0, colon).toLocaleLowerCase());
  if (!key) return null;
  const value = token
    .slice(colon + 1)
    .replace(/^"(.*)"$/u, "$1")
    .trim();
  return value ? { key, value } : null;
}

export function parseSearchQuery(query: string): ParsedSearch {
  const parsed: ParsedSearch = {
    text: "",
    in: [],
    from: [],
    before: null,
    after: null,
    on: null,
    during: null,
    threads: false,
  };
  const words: string[] = [];
  for (const token of searchTokens(query)) {
    const modifier = modifierOf(token);
    if (!modifier) {
      words.push(token);
      continue;
    }
    const { key, value } = modifier;
    if (key === "in") parsed.in.push(value);
    else if (key === "from") parsed.from.push(value.replace(/^@/u, ""));
    else if (key === "is") {
      if (value.toLocaleLowerCase() === "thread" || value.toLocaleLowerCase() === "threads") parsed.threads = true;
      else words.push(token);
    } else parsed[key] = value;
  }
  parsed.text = words.join(" ");
  return parsed;
}

/** Whether the query has anything to look for: words, or a modifier that narrows the messages. */
export function searchHasTerms(parsed: ParsedSearch): boolean {
  return parsed.text.replace(/["-]/gu, "").trim().length > 0;
}

/**
 * The query with one modifier set to `value`, or taken out when `value` is null. Every earlier
 * value of the modifier goes, so a filter menu replaces it. `is` takes only `thread`.
 */
export function withSearchModifier(query: string, key: SearchModifier, value: string | null): string {
  const kept = searchTokens(query).filter((token) => modifierOf(token)?.key !== key);
  if (value) kept.push(`${key}:${/\s/u.test(value) ? `"${value}"` : value}`);
  return kept.join(" ");
}

const DAY_MS = 86_400_000;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** A day, a month or a year, in local time, from `today`, `yesterday`, `2026-10-31`, `2026-10` or `2026`. */
function period(value: string, now: Date): { start: Date; end: Date } | null {
  const text = value.trim().toLocaleLowerCase();
  const today = startOfDay(now);
  if (text === "today") return { start: today, end: new Date(today.getTime() + DAY_MS) };
  if (text === "yesterday") return { start: new Date(today.getTime() - DAY_MS), end: today };
  if (text === "week") {
    // The week starts on Monday.
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
    return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) };
  }
  if (text === "month") {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return { start, end: new Date(today.getFullYear(), today.getMonth() + 1, 1) };
  }
  if (text === "year")
    return { start: new Date(today.getFullYear(), 0, 1), end: new Date(today.getFullYear() + 1, 0, 1) };
  const day = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(text);
  if (day) {
    const start = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    if (start.getMonth() !== Number(day[2]) - 1) return null;
    return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) };
  }
  const month = /^(\d{4})-(\d{1,2})$/u.exec(text);
  if (month && Number(month[2]) >= 1 && Number(month[2]) <= 12) {
    const start = new Date(Number(month[1]), Number(month[2]) - 1, 1);
    return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
  }
  const year = /^(\d{4})$/u.exec(text);
  if (year) return { start: new Date(Number(year[1]), 0, 1), end: new Date(Number(year[1]) + 1, 0, 1) };
  return null;
}

export interface SearchDateRange {
  /** An ISO time: messages at or after it. */
  after?: string;
  /** An ISO time: messages before it. */
  before?: string;
  /** The date values that are not dates, such as `before:soon`. */
  invalid: string[];
}

/**
 * The time range of the date modifiers. As in Slack, `before:` and `after:` leave out the day they
 * name; `on:` and `during:` keep only their day, month or year.
 */
export function searchDateRange(parsed: ParsedSearch, now = new Date()): SearchDateRange {
  const invalid: string[] = [];
  const bounds: { after: Date | null; before: Date | null } = { after: null, before: null };
  const later = (date: Date) => {
    if (!bounds.after || date > bounds.after) bounds.after = date;
  };
  const earlier = (date: Date) => {
    if (!bounds.before || date < bounds.before) bounds.before = date;
  };
  const read = (value: string | null, apply: (range: { start: Date; end: Date }) => void) => {
    if (!value) return;
    const range = period(value, now);
    if (range) apply(range);
    else invalid.push(value);
  };
  read(parsed.before, (range) => earlier(range.start));
  read(parsed.after, (range) => later(range.end));
  read(parsed.on, (range) => {
    later(range.start);
    earlier(range.end);
  });
  read(parsed.during, (range) => {
    later(range.start);
    earlier(range.end);
  });
  const result: SearchDateRange = { invalid };
  if (bounds.after) result.after = bounds.after.toISOString();
  if (bounds.before) result.before = bounds.before.toISOString();
  return result;
}
