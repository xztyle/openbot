import { z } from "zod/mini";

type ServerOrderStorage = Pick<Storage, "getItem">;

const serverOrderSchema = z.array(z.string().check(z.trim(), z.minLength(1)));

function serverOrderKey(accountId: string): string {
  return `openbot.web.server-order:${accountId}`;
}

/**
 * The host order that an earlier version of this browser saved for one account, from its server rail.
 * The first host in it is the one that the client connects to when no host was open before.
 */
export function readWebServerOrder(accountId: string, storage: ServerOrderStorage = window.localStorage): string[] {
  try {
    const parsed = serverOrderSchema.safeParse(JSON.parse(storage.getItem(serverOrderKey(accountId)) ?? "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Saved hosts come first. A host without a saved position keeps its directory order at the end. */
export function orderWebHosts<T extends { hostId: string }>(hosts: readonly T[], order: readonly string[]): T[] {
  const position = new Map(order.map((id, index) => [id, index]));
  return hosts
    .map((host, index) => ({ host, rank: position.get(host.hostId) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ host }) => host);
}
