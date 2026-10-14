import { describe, expect, test } from "bun:test";
import { BIB_HEADER, buildBibliography, citationKey } from "../src/bib.ts";
import type { ItemInfo } from "../src/zotero/client.ts";

function item(key: string, entry: string, overrides: Partial<ItemInfo> = {}): ItemInfo {
  return {
    key,
    itemType: "journalArticle",
    dateAdded: `2024-01-01T00:00:0${key.length % 10}Z`,
    deleted: false,
    entry,
    ...overrides,
  };
}

describe("citationKey", () => {
  test("extracts keys from common entry shapes", () => {
    expect(citationKey("\n@article{smith_title_2020,\n  title = {T}\n}")).toBe("smith_title_2020");
    expect(citationKey("@Book{ doe2019 , title={X}}")).toBe("doe2019");
    expect(citationKey("@misc(key-1,\n title={x})")).toBe("key-1");
    expect(citationKey("not an entry")).toBeUndefined();
  });
});

describe("buildBibliography", () => {
  test("sorts entries by citation key and adds the header", () => {
    const result = buildBibliography([
      item("BBBBBBBB", "@article{zeta2020,\n  title = {Z}\n}"),
      item("AAAAAAAA", "\n@book{Alpha2019,\n  title = {A}\n}\n"),
    ]);
    expect(result.entryCount).toBe(2);
    expect(result.content).toBe(
      `${BIB_HEADER}\n\n@book{Alpha2019,\n  title = {A}\n}\n\n@article{zeta2020,\n  title = {Z}\n}\n`,
    );
  });

  test("is independent of input order and duplicates", () => {
    const a = item("AAAAAAAA", "@article{a,}");
    const b = item("BBBBBBBB", "@article{b,}");
    expect(buildBibliography([a, b, a]).content).toBe(buildBibliography([b, a]).content);
  });

  test("skips notes, attachments, trashed and unparseable items", () => {
    const result = buildBibliography([
      item("NOTE0001", "", { itemType: "note" }),
      item("ATTACH01", "@misc{file,}", { itemType: "attachment" }),
      item("TRASHED1", "@article{gone,}", { deleted: true }),
      item("EMPTY001", ""),
      item("GARBAGE1", "garbage"),
      item("GOOD0001", "@article{kept,}"),
    ]);
    expect(result.entryCount).toBe(1);
    expect(result.content).toContain("@article{kept,}");
    expect(result.skipped.map((s) => s.itemKey).sort()).toEqual(["EMPTY001", "GARBAGE1"]);
  });

  test("disambiguates duplicate keys deterministically, oldest item keeps its key", () => {
    const older = item("OLDER001", "@article{smith2020,\n title={Old}}", {
      dateAdded: "2020-01-01T00:00:00Z",
    });
    const newer = item("NEWER001", "@article{Smith2020,\n title={New}}", {
      dateAdded: "2021-01-01T00:00:00Z",
    });
    const newest = item("NEWEST01", "@article{smith2020,\n title={Newest}}", {
      dateAdded: "2022-01-01T00:00:00Z",
    });
    const result = buildBibliography([newest, newer, older]);
    expect(result.renamed).toEqual([
      { itemKey: "NEWER001", from: "Smith2020", to: "Smith2020-2" },
      { itemKey: "NEWEST01", from: "smith2020", to: "smith2020-3" },
    ]);
    expect(result.content).toContain("@article{smith2020,\n title={Old}}");
    expect(result.content).toContain("@article{Smith2020-2,\n title={New}}");
    expect(result.content).toContain("@article{smith2020-3,\n title={Newest}}");
  });

  test("an empty selection still yields a valid file", () => {
    expect(buildBibliography([]).content).toBe(`${BIB_HEADER}\n`);
  });
});
