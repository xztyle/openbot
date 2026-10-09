import { describe, expect, it } from "vitest";
import { itemFiltersFromText, itemFiltersToText } from "./event-check-item-filters";

describe("event check item filters", () => {
  it("reads one pointer and value on each line, with the value as JSON when it can be", () => {
    expect(itemFiltersFromText('/kind=bug\n/open=true\n\n/count=3\n/note=null\n/id="12"')).toEqual([
      { pointer: "/kind", value: "bug" },
      { pointer: "/open", value: true },
      { pointer: "/count", value: 3 },
      { pointer: "/note", value: null },
      { pointer: "/id", value: "12" },
    ]);
  });

  it("refuses a line without a value separator or with a pointer that is not valid", () => {
    expect(itemFiltersFromText("kind=bug")).toBeNull();
    expect(itemFiltersFromText("/kind")).toBeNull();
    expect(itemFiltersFromText("/bad~2=x")).toBeNull();
  });

  it("writes text that reads back to the same filters, also for a string that looks like another type", () => {
    const filters = [
      { pointer: "/kind", value: "bug" },
      { pointer: "/id", value: "12" },
      { pointer: "/flag", value: "true" },
      { pointer: "/count", value: 12 },
      { pointer: "", value: false },
    ];
    expect(itemFiltersFromText(itemFiltersToText(filters))).toEqual(filters);
  });
});
