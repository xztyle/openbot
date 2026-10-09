import { type EventFilter, isEventFilter, isEventFilterPointer } from "@openbot/contracts/ipc-events";

/** A scalar reads as JSON when it can be one (`true`, `12`, `null`, `"text"`), and as plain text otherwise. */
function parseValue(text: string): EventFilter["value"] {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean")
      return parsed;
  } catch {
    /* Not JSON: a plain string. */
  }
  return text;
}

function valueText(value: EventFilter["value"]): string {
  // A string that would read back as another type keeps its quotes.
  return typeof value === "string" && parseValue(value) === value ? value : JSON.stringify(value);
}

/** One filter on each line: a JSON Pointer, an equals sign and the value. */
export function itemFiltersToText(filters: readonly EventFilter[]): string {
  return filters.map((filter) => `${filter.pointer}=${valueText(filter.value)}`).join("\n");
}

/** The filters in the text, or null when a line is not `pointer=value` with a valid pointer. */
export function itemFiltersFromText(text: string): EventFilter[] | null {
  const filters: EventFilter[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf("=");
    if (at < 0) return null;
    const pointer = line.slice(0, at).trim();
    const filter = { pointer, value: parseValue(line.slice(at + 1).trim()) };
    if (!isEventFilterPointer(pointer) || !isEventFilter(filter)) return null;
    filters.push(filter);
  }
  return filters;
}
