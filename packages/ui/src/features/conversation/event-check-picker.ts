import {
  EVENT_CHECK_PICKER_MAX_ENTRIES,
  type EventCheckPickerEntry,
  type EventCheckPickerOption,
  type EventCheckPickerOptions,
  type EventCheckTemplatePicker,
  parseEventCheckPickerValue,
} from "@openbot/contracts/event-check-templates";
import type { AppTextKey } from "@openbot/i18n";

/** The groups the app has a title for, in the order it lists them. Any other group follows, by name. */
export const PICKER_GROUP_KEYS = {
  channel: "agentSettings.eventCheck.picker.group.channel",
  private_channel: "agentSettings.eventCheck.picker.group.privateChannel",
  dm: "agentSettings.eventCheck.picker.group.dm",
  group_dm: "agentSettings.eventCheck.picker.group.groupDm",
} as const satisfies Record<string, AppTextKey>;

const KNOWN_GROUPS: readonly string[] = Object.keys(PICKER_GROUP_KEYS);

export function pickerGroupKey(group: string): AppTextKey | null {
  return group === "channel" || group === "private_channel" || group === "dm" || group === "group_dm"
    ? PICKER_GROUP_KEYS[group]
    : null;
}

/** What an editor needs to show one setting as a picker: how to read its list, and why it cannot yet. */
export interface PickerBinding {
  picker: EventCheckTemplatePicker;
  load(): Promise<EventCheckPickerOptions>;
  /** A sentence that says what is missing before the list can load. Absent when it can. */
  blocked?: string | undefined;
}

export interface PickerSection {
  group: string;
  options: EventCheckPickerOption[];
}

/**
 * The entries of a saved value, or null when the value is not a list of ID and mode pairs that this
 * picker can hold. An empty value has no entries.
 */
export function readPickerEntries(value: string, picker: EventCheckTemplatePicker): EventCheckPickerEntry[] | null {
  try {
    return parseEventCheckPickerValue(value, picker);
  } catch {
    return null;
  }
}

/** Whether `id` is an ID that a value can hold. The check is the one the host makes. */
export function isPickerId(id: string, picker: EventCheckTemplatePicker): boolean {
  const mode = picker.modes[0]?.value;
  if (!mode || id.includes(",") || id.includes(":")) return false;
  return readPickerEntries(`${id}:${mode}`, picker) !== null;
}

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFKC");
}

/**
 * The options that match a search, in groups. A search looks at the label, the description and the
 * ID. The known groups come first, in a fixed order, and a group with no match is left out.
 */
export function pickerSections(options: readonly EventCheckPickerOption[], query: string): PickerSection[] {
  const needle = normalize(query.trim());
  const groups = new Map<string, EventCheckPickerOption[]>();
  for (const option of options) {
    if (
      needle !== "" &&
      !normalize(option.label).includes(needle) &&
      !normalize(option.id).includes(needle) &&
      !normalize(option.description ?? "").includes(needle)
    )
      continue;
    const found = groups.get(option.group);
    if (found) found.push(option);
    else groups.set(option.group, [option]);
  }
  const known = KNOWN_GROUPS.filter((group) => groups.has(group));
  const others = [...groups.keys()].filter((group) => !KNOWN_GROUPS.includes(group)).sort();
  return [...known, ...others].map((group) => ({ group, options: groups.get(group) ?? [] }));
}

/** The entries with `id` chosen in `mode`. A mode change keeps the place of the entry. */
export function withPickerEntry(
  entries: readonly EventCheckPickerEntry[],
  id: string,
  mode: string,
): EventCheckPickerEntry[] {
  return entries.some((entry) => entry.id === id)
    ? entries.map((entry) => (entry.id === id ? { id, mode } : entry))
    : [...entries, { id, mode }];
}

export function withoutPickerEntry(entries: readonly EventCheckPickerEntry[], id: string): EventCheckPickerEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

export function pickerLimitReached(entries: readonly EventCheckPickerEntry[]): boolean {
  return entries.length >= EVENT_CHECK_PICKER_MAX_ENTRIES;
}

/** The saved entries that the loaded list does not hold: an ID that is gone, or that the list cut off. */
export function entriesOutsideList(
  entries: readonly EventCheckPickerEntry[],
  options: readonly EventCheckPickerOption[],
): EventCheckPickerEntry[] {
  const known = new Set(options.map((option) => option.id));
  return entries.filter((entry) => !known.has(entry.id));
}
