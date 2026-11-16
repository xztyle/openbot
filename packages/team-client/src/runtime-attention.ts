/**
 * Folds the pending requests of a runtime snapshot into the list a client shows.
 *
 * The host cuts a snapshot's attention lists when it holds more requests than the snapshot limit
 * or the snapshot is too large, and then sends `attentionComplete: false`. A complete snapshot lists
 * every pending request, so it replaces the list. A partial one leaves out requests that are still
 * pending, so the client keeps them. It is still the current state for each agent it names, as in
 * the desktop renderer's `reconcileAttentionApprovals`: some host paths clear a request with no
 * event, and an old request kept for such an agent would hide its new one.
 *
 * A request that the client already holds keeps its held copy. The snapshot shortens long commands,
 * questions and paths, and its copy is a new object, so taking it would cut the text on screen and
 * reset the card that shows it.
 */
export function reconcilePendingRequests<Item extends { requestId: string | number; agentId: string }>(
  current: readonly Item[],
  snapshotItems: readonly Item[],
  attentionComplete: boolean,
): Item[] {
  const held = (item: Item) =>
    current.find(
      (candidate) => candidate.agentId === item.agentId && String(candidate.requestId) === String(item.requestId),
    ) ?? item;
  const fromSnapshot = snapshotItems.map(held);
  if (attentionComplete) return fromSnapshot;
  const namedAgents = new Set(snapshotItems.map((item) => item.agentId));
  return [...current.filter((item) => !namedAgents.has(item.agentId)), ...fromSnapshot];
}
