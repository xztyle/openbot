import type { EventCheckPickerOption, EventCheckTemplatePicker } from "@openbot/contracts/event-check-templates";
import { describe, expect, it } from "vitest";
import {
  entriesOutsideList,
  isPickerId,
  pickerGroupKey,
  pickerLimitReached,
  pickerSections,
  readPickerEntries,
  withoutPickerEntry,
  withPickerEntry,
} from "./event-check-picker";

const picker: EventCheckTemplatePicker = {
  optionsFrom: "program",
  modes: [
    { value: "all", label: "All messages" },
    { value: "mentions", label: "Only mentions" },
  ],
};
const options: EventCheckPickerOption[] = [
  { id: "D1AAA", label: "@pat", group: "dm" },
  { id: "C1AAA", label: "#general", group: "channel", description: "Company news" },
  { id: "X1AAA", label: "#odd", group: "workspace_thing" },
  { id: "G1AAA", label: "#secret", group: "private_channel" },
  { id: "C2AAA", label: "#ops", group: "channel" },
];

describe("picker logic", () => {
  it("groups options in a fixed order, with unknown groups last, and drops a group with no match", () => {
    expect(pickerSections(options, "").map((section) => section.group)).toEqual([
      "channel",
      "private_channel",
      "dm",
      "workspace_thing",
    ]);
    expect(pickerSections(options, "company").map((section) => section.options.map((option) => option.id))).toEqual([
      ["C1AAA"],
    ]);
    // A search reads the ID too, and ignores case.
    expect(pickerSections(options, "d1aaa").flatMap((section) => section.options.map((option) => option.id))).toEqual([
      "D1AAA",
    ]);
    expect(pickerSections(options, "zzz")).toEqual([]);
  });

  it("names the known groups and leaves an unknown one to a fallback", () => {
    expect(pickerGroupKey("dm")).toBe("agentSettings.eventCheck.picker.group.dm");
    expect(pickerGroupKey("workspace_thing")).toBeNull();
  });

  it("reads a saved value, and says null for one that is not a list of pairs", () => {
    expect(readPickerEntries("", picker)).toEqual([]);
    expect(readPickerEntries("C1AAA:all,D1AAA:mentions", picker)).toEqual([
      { id: "C1AAA", mode: "all" },
      { id: "D1AAA", mode: "mentions" },
    ]);
    expect(readPickerEntries("C1AAA, D1AAA", picker)).toBeNull();
    expect(readPickerEntries("C1AAA:later", picker)).toBeNull();
  });

  it("checks an ID by hand the way the host does", () => {
    expect(isPickerId("C012ABCDE", picker)).toBe(true);
    for (const id of ["", "has space", "a,b", "a:b", "x".repeat(65)]) expect(isPickerId(id, picker)).toBe(false);
  });

  it("changes a mode in place, removes an entry, and finds what the list does not hold", () => {
    const entries = [
      { id: "C1AAA", mode: "all" },
      { id: "OLD11", mode: "mentions" },
    ];
    expect(withPickerEntry(entries, "C1AAA", "mentions")).toEqual([
      { id: "C1AAA", mode: "mentions" },
      { id: "OLD11", mode: "mentions" },
    ]);
    expect(withPickerEntry(entries, "D1AAA", "all").map((entry) => entry.id)).toEqual(["C1AAA", "OLD11", "D1AAA"]);
    expect(withoutPickerEntry(entries, "C1AAA")).toEqual([{ id: "OLD11", mode: "mentions" }]);
    expect(entriesOutsideList(entries, options)).toEqual([{ id: "OLD11", mode: "mentions" }]);
    expect(pickerLimitReached(entries)).toBe(false);
    expect(pickerLimitReached(Array.from({ length: 50 }, (_, index) => ({ id: `C${index}`, mode: "all" })))).toBe(true);
  });
});
