import { z } from "zod/mini";
export type SidebarCollapsedByServer = Record<string, string[]>;

const SIDEBAR_COLLAPSED_STORAGE_KEY = "openbot:sidebar-collapsed:v1";

type SidebarCollapsedStorage = Pick<Storage, "getItem" | "setItem">;

const collapsedSchema = z.record(
  z.string().check(z.trim(), z.minLength(1)),
  z.catch(z.array(z.catch(z.nullable(z.string().check(z.trim(), z.minLength(1))), null)), []),
);

export function readSidebarCollapsed(storage: SidebarCollapsedStorage = window.localStorage): SidebarCollapsedByServer {
  try {
    const parsed = collapsedSchema.safeParse(JSON.parse(storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) ?? "{}"));
    if (!parsed.success) return {};
    return Object.fromEntries(
      Object.entries(parsed.data).flatMap(([serverId, values]) => {
        const sectionIds = [...new Set(values.flatMap((value) => (value ? [value] : [])))];
        return sectionIds.length > 0 ? [[serverId, sectionIds]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function writeSidebarCollapsed(
  collapsedByServer: SidebarCollapsedByServer,
  storage: SidebarCollapsedStorage = window.localStorage,
): void {
  try {
    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsedByServer));
  } catch {
    // A private display preference must not block shared sidebar navigation.
  }
}
