/**
 * A small cache of the content blocks of message bodies. The bubble variant and the message body
 * split the same body, and every mounted row asks for its own body when its list changes, so a
 * cache of one entry only helped the last row. The oldest entry leaves first, and bodies that are
 * very long do not stay, so the cache holds a bounded amount of text.
 */
export interface ContentBlockCache<Blocks> {
  get: (body: string, streaming: boolean) => Blocks;
}

export const CONTENT_BLOCK_CACHE_ENTRIES = 32;
export const CONTENT_BLOCK_CACHE_CHARACTERS = 1_000_000;

export function createContentBlockCache<Blocks>(
  parse: (body: string, streaming: boolean) => Blocks,
  limits: { entries?: number; characters?: number } = {},
): ContentBlockCache<Blocks> {
  const entries = limits.entries ?? CONTENT_BLOCK_CACHE_ENTRIES;
  const characters = limits.characters ?? CONTENT_BLOCK_CACHE_CHARACTERS;
  // A Map keeps the order of insertion, so the first key is the least recently used one.
  const settled = new Map<string, Blocks>();
  const streamingBodies = new Map<string, Blocks>();
  let held = 0;

  const forget = (map: Map<string, Blocks>): void => {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
    held -= oldest.value.length;
  };

  return {
    get(body, streaming) {
      const map = streaming ? streamingBodies : settled;
      const hit = map.get(body);
      if (hit !== undefined) {
        map.delete(body);
        map.set(body, hit);
        return hit;
      }
      const blocks = parse(body, streaming);
      // A body that alone passes the budget would empty the cache for the next row.
      if (body.length > characters) return blocks;
      map.set(body, blocks);
      held += body.length;
      while (settled.size + streamingBodies.size > entries || held > characters) {
        // Drop from the map that holds more, so a stream of steps does not push out the final rows.
        forget(streamingBodies.size > settled.size ? streamingBodies : settled);
      }
      return blocks;
    },
  };
}
