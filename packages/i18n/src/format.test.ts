import { afterEach, describe, expect, it, vi } from "vitest";
import { createFormat } from "./format";

describe("date format", () => {
  const Original = Intl.DateTimeFormat;
  afterEach(() => {
    Object.defineProperty(Intl, "DateTimeFormat", { value: Original, configurable: true, writable: true });
    vi.unstubAllEnvs();
  });
  /** Counts the formatters that the code under test makes from now on. */
  function countConstructions(): { count: () => number } {
    let constructed = 0;
    class Counting extends Original {
      constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
        super(locales, options);
        constructed += 1;
      }
    }
    Object.defineProperty(Intl, "DateTimeFormat", { value: Counting, configurable: true, writable: true });
    return { count: () => constructed };
  }

  const date = new Date(Date.UTC(2026, 8, 20, 21, 5, 9));
  const optionSets: Array<Intl.DateTimeFormatOptions | undefined> = [
    undefined,
    { hour: "2-digit", minute: "2-digit", timeZone: "UTC" },
    { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" },
    { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" },
  ];

  it.each(["en", "de", "ja"] as const)("writes the same text as a new formatter in %s", (locale) => {
    const format = createFormat(locale);
    for (const options of optionSets) {
      const expected = new Intl.DateTimeFormat(locale, options).format(date);
      // The second call comes from the cache.
      expect(format.date(date, options)).toBe(expected);
      expect(format.date(date, options)).toBe(expected);
    }
  });

  it("keeps the text of each locale and of each set of options apart", () => {
    const options = { dateStyle: "medium", timeZone: "UTC" } as const;
    const english = createFormat("en").date(date, options);
    const german = createFormat("de").date(date, options);
    expect(english).not.toBe(german);
    expect(createFormat("en").date(date, { dateStyle: "short", timeZone: "UTC" })).not.toBe(english);
    expect(createFormat("en").date(date, options)).toBe(english);
  });

  it("builds a formatter once for the same locale and options", () => {
    const format = createFormat("es");
    const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", timeZone: "UTC" };
    const construct = countConstructions();
    for (let index = 0; index < 50; index += 1) format.date(date.getTime() + index * 60_000, options);
    expect(construct.count()).toBe(1);
    for (let index = 0; index < 50; index += 1) format.date(date, { ...options });
    expect(construct.count()).toBe(1);
  });

  it("follows a change of the time zone of the computer", () => {
    const format = createFormat("en");
    const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
    vi.stubEnv("TZ", "America/Los_Angeles");
    const pacific = format.date(date, options);
    expect(pacific).toBe(new Original("en", options).format(date));
    vi.stubEnv("TZ", "Asia/Tokyo");
    const tokyo = format.date(date, options);
    expect(tokyo).toBe(new Original("en", options).format(date));
    expect(tokyo).not.toBe(pacific);
  });

  it("makes a new formatter when the constructor was replaced", () => {
    const format = createFormat("de");
    const options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeZone: "UTC" };
    format.date(date, options);
    const construct = countConstructions();
    format.date(date, options);
    format.date(date, options);
    expect(construct.count()).toBe(1);
  });
});
