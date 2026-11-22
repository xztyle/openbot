import { z } from "zod/mini";

export type SidebarPeopleOrderByServer = Record<string, string[]>;

const SIDEBAR_PEOPLE_ORDER_STORAGE_KEY = "openbot:sidebar-people-order:v1";

type SidebarPeopleOrderStorage = Pick<Storage, "getItem" | "setItem">;

const peopleOrderSchema = z.record(
  z.string().check(z.trim(), z.minLength(1)),
  z.catch(z.array(z.catch(z.nullable(z.string().check(z.trim(), z.minLength(1))), null)), []),
);

export function normalizeSidebarPeopleOrder(value: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawId of value) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function readSidebarPeopleOrder(
  storage: SidebarPeopleOrderStorage = window.localStorage,
): SidebarPeopleOrderByServer {
  try {
    const parsed = peopleOrderSchema.safeParse(JSON.parse(storage.getItem(SIDEBAR_PEOPLE_ORDER_STORAGE_KEY) ?? "{}"));
    if (!parsed.success) return {};
    return Object.fromEntries(
      Object.entries(parsed.data).flatMap(([serverId, values]) => {
        const order = normalizeSidebarPeopleOrder(values.flatMap((value) => (value ? [value] : [])));
        return order.length > 0 ? [[serverId, order]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function writeSidebarPeopleOrder(
  orderByServer: SidebarPeopleOrderByServer,
  storage: SidebarPeopleOrderStorage = window.localStorage,
): void {
  try {
    storage.setItem(SIDEBAR_PEOPLE_ORDER_STORAGE_KEY, JSON.stringify(orderByServer));
  } catch {
    // A private ordering preference must not block sidebar navigation.
  }
}
