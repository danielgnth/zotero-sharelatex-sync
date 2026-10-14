import { expect, test } from "bun:test";
import type { PublishResult } from "../src/git.ts";
import { Syncer, type SyncerOptions } from "../src/syncer.ts";
import type { ItemInfo } from "../src/zotero/client.ts";
import { LibraryChangedError } from "../src/zotero/client.ts";

const item = (key: string, cite: string): ItemInfo => ({
  key,
  itemType: "book",
  dateAdded: "2024-01-01T00:00:00Z",
  deleted: false,
  entry: `@book{${cite},}`,
});

function fakeZotero(state: { version: number; items: Record<string, ItemInfo[]> }) {
  const calls: string[] = [];
  const zotero: SyncerOptions["zotero"] = {
    checkVersion: async (since) => {
      calls.push(`check:${since}`);
      return { modified: since !== state.version, version: state.version };
    },
    listCollections: async () => {
      calls.push("collections");
      return {
        version: state.version,
        results: [
          { key: "ROOT0001", name: "root", parentKey: null, deleted: false },
          { key: "SUB00001", name: "sub", parentKey: "ROOT0001", deleted: false },
        ],
      };
    },
    listItems: async (key) => {
      calls.push(`items:${key ?? "library"}`);
      return { version: state.version, results: state.items[key ?? "library"] ?? [] };
    },
  };
  return { zotero, calls };
}

function recorder() {
  const published: string[] = [];
  const publish = async (content: string): Promise<PublishResult> => {
    published.push(content);
    return { changed: true, commit: "abc" };
  };
  return { published, publish };
}

test("syncs a collection with subcollections, deduplicating shared items", async () => {
  const state = {
    version: 5,
    items: {
      ROOT0001: [item("AAAAAAAA", "a")],
      SUB00001: [item("AAAAAAAA", "a"), item("BBBBBBBB", "b")],
    },
  };
  const { zotero, calls } = fakeZotero(state);
  const { published, publish } = recorder();
  let successes = 0;
  const syncer = new Syncer({
    zotero,
    collectionKey: "ROOT0001",
    includeSubcollections: true,
    format: "bibtex",
    publish,
    onSuccess: () => successes++,
  });

  await syncer.sync("startup");
  expect(calls).toEqual(["collections", "items:ROOT0001", "items:SUB00001"]);
  expect(published).toHaveLength(1);
  expect(published[0]?.match(/@book/g)).toHaveLength(2);
  expect(successes).toBe(1);

  // Unchanged library: only the cheap version check.
  calls.length = 0;
  await syncer.sync("safety check");
  expect(calls).toEqual(["check:5"]);
  expect(published).toHaveLength(1);
  expect(successes).toBe(2);
  expect(syncer.isNewer(5)).toBe(false);
  expect(syncer.isNewer(6)).toBe(true);
});

test("does not publish when the library changed but the bibliography did not", async () => {
  const state = { version: 1, items: { library: [item("AAAAAAAA", "a")] } };
  const { zotero } = fakeZotero(state);
  const { published, publish } = recorder();
  const syncer = new Syncer({ zotero, includeSubcollections: true, format: "bibtex", publish });
  await syncer.sync("startup");
  state.version = 2; // e.g. a note was edited
  await syncer.sync("library updated");
  expect(published).toHaveLength(1);
  state.version = 3;
  state.items.library.push(item("BBBBBBBB", "b"));
  await syncer.sync("library updated");
  expect(published).toHaveLength(2);
});

test("without subcollections only the root collection is fetched", async () => {
  const { zotero, calls } = fakeZotero({ version: 1, items: {} });
  const { publish } = recorder();
  const syncer = new Syncer({
    zotero,
    collectionKey: "ROOT0001",
    includeSubcollections: false,
    format: "biblatex",
    publish,
  });
  await syncer.sync("startup");
  expect(calls).toEqual(["items:ROOT0001"]);
});

test("rejects inconsistent snapshots and does not record the version", async () => {
  const state = { version: 1, items: {} };
  const { zotero } = fakeZotero(state);
  const listItems = zotero.listItems;
  zotero.listItems = async (key, format) => ({ ...(await listItems(key, format)), version: 99 });
  const { published, publish } = recorder();
  const syncer = new Syncer({
    zotero,
    collectionKey: "ROOT0001",
    includeSubcollections: true,
    format: "bibtex",
    publish,
  });
  await expect(syncer.sync("startup")).rejects.toBeInstanceOf(LibraryChangedError);
  expect(published).toHaveLength(0);
  expect(syncer.isNewer(1)).toBe(true);
});
