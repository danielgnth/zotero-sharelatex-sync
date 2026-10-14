import type { CollectionInfo } from "./client.ts";

/** The root collection followed by all its (non-trashed) descendants, in breadth-first order. */
export function collectionTree(collections: CollectionInfo[], rootKey: string): string[] {
  const live = collections.filter((c) => !c.deleted);
  if (!live.some((c) => c.key === rootKey)) {
    throw new Error(`Collection ${rootKey} does not exist (or is in the trash)`);
  }
  const children = new Map<string, string[]>();
  for (const c of live) {
    if (c.parentKey === null) continue;
    const list = children.get(c.parentKey) ?? [];
    list.push(c.key);
    children.set(c.parentKey, list);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  const queue = [rootKey];
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
    queue.push(...(children.get(key) ?? []).sort());
  }
  return result;
}
