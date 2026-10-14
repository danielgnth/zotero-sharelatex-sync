import { expect, test } from "bun:test";
import type { CollectionInfo } from "../src/zotero/client.ts";
import { collectionTree } from "../src/zotero/collections.ts";

const c = (key: string, parentKey: string | null, deleted = false): CollectionInfo => ({
  key,
  name: key,
  parentKey,
  deleted,
});

const collections = [
  c("ROOT0001", null),
  c("CHILD002", "ROOT0001"),
  c("CHILD001", "ROOT0001"),
  c("GRAND001", "CHILD001"),
  c("TRASHED1", "ROOT0001", true),
  c("UNDERTR1", "TRASHED1"),
  c("OTHER001", null),
];

test("returns the root and all live descendants", () => {
  expect(collectionTree(collections, "ROOT0001")).toEqual([
    "ROOT0001",
    "CHILD001",
    "CHILD002",
    "GRAND001",
  ]);
});

test("a leaf collection is just itself", () => {
  expect(collectionTree(collections, "GRAND001")).toEqual(["GRAND001"]);
});

test("unknown or trashed roots are errors", () => {
  expect(() => collectionTree(collections, "MISSING1")).toThrow("does not exist");
  expect(() => collectionTree(collections, "TRASHED1")).toThrow("does not exist");
});

test("survives cycles in corrupt data", () => {
  const cyclic = [c("AAAAAAAA", "BBBBBBBB"), c("BBBBBBBB", "AAAAAAAA")];
  expect(collectionTree(cyclic, "AAAAAAAA")).toEqual(["AAAAAAAA", "BBBBBBBB"]);
});
