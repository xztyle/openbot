/**
 * Where the reader left a conversation or a thread that they scrolled up in, while the app runs.
 * Slack keeps that place when the reader comes back to it. A reload opens at the first unread
 * message or at the end, as Slack does, so the places live in memory only.
 */
export interface ScrollPlace {
  /** The row at the top of the view, for a list whose rows load and unload; absent for a plain list. */
  key?: string;
  /** For a row: its distance from the top of the view. Without a row: the scroll position. */
  offset: number;
}

/** The most places kept; the oldest goes first. */
const PLACE_LIMIT = 200;
const places = new Map<string, ScrollPlace>();

export function savedScrollPlace(id: string): ScrollPlace | undefined {
  return places.get(id);
}

/** Keeps the place, or forgets it when the reader is at the end (`null`). */
export function saveScrollPlace(id: string, place: ScrollPlace | null): void {
  places.delete(id);
  if (!place) return;
  places.set(id, place);
  if (places.size > PLACE_LIMIT) {
    const oldest = places.keys().next().value;
    if (oldest !== undefined) places.delete(oldest);
  }
}
