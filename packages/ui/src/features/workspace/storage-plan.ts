// The cleanup plan of the Storage view, grouped for its checkboxes: one group per rule, and in it
// one row per project or agent. DOM-free.

import {
  STORAGE_HYGIENE_RULES,
  type StorageHygieneArea,
  type StorageHygieneItem,
  type StorageHygieneRule,
} from "@openbot/contracts/ipc";

export interface StoragePlanArea {
  area: StorageHygieneArea | undefined;
  areaId: string;
  items: StorageHygieneItem[];
  bytes: number;
}

export interface StoragePlanRule {
  rule: StorageHygieneRule;
  areas: StoragePlanArea[];
  items: StorageHygieneItem[];
  bytes: number;
}

/** The plan by rule, in rule order, and by area, largest first. Sizes count nested items once. */
export function groupStoragePlan(
  items: readonly StorageHygieneItem[],
  areas: readonly StorageHygieneArea[],
): StoragePlanRule[] {
  const areaById = new Map(areas.map((area) => [area.id, area]));
  const byRule = new Map<StorageHygieneRule, Map<string, StorageHygieneItem[]>>();
  for (const item of items) {
    const rule = byRule.get(item.rule) ?? new Map<string, StorageHygieneItem[]>();
    byRule.set(item.rule, rule);
    const list = rule.get(item.areaId) ?? [];
    rule.set(item.areaId, list);
    list.push(item);
  }
  const sum = (list: readonly StorageHygieneItem[]) => list.reduce((total, item) => total + item.bytes, 0);
  return STORAGE_HYGIENE_RULES.flatMap((rule): StoragePlanRule[] => {
    const grouped = byRule.get(rule);
    if (!grouped) return [];
    const planAreas = [...grouped].map(
      ([areaId, list]): StoragePlanArea => ({ areaId, area: areaById.get(areaId), items: list, bytes: sum(list) }),
    );
    planAreas.sort((left, right) => right.bytes - left.bytes);
    const all = planAreas.flatMap((area) => area.items);
    return [{ rule, areas: planAreas, items: all, bytes: sum(all) }];
  });
}

/** Whether all, some or none of `items` are in `selected`. */
export function selectionState(
  items: readonly StorageHygieneItem[],
  selected: ReadonlySet<string>,
): "all" | "some" | "none" {
  let count = 0;
  for (const item of items) if (selected.has(item.id)) count += 1;
  if (count === 0) return "none";
  return count === items.length ? "all" : "some";
}

/** `selected` with `items` added or removed. */
export function toggleSelection(
  selected: ReadonlySet<string>,
  items: readonly StorageHygieneItem[],
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const item of items) {
    if (on) next.add(item.id);
    else next.delete(item.id);
  }
  return next;
}
