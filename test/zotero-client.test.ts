import { describe, expect, test } from "bun:test";
import { LibraryChangedError, ZoteroApiError, ZoteroClient } from "../src/zotero/client.ts";

type Handler = (url: URL, headers: Headers) => Response;

function client(handler: Handler, libraryType: "user" | "group" = "user") {
  const calls: { url: URL; headers: Headers }[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    return handler(url, headers);
  }) as typeof fetch;
  const zotero = new ZoteroClient({
    apiUrl: "https://api.test",
    apiKey: "KEY",
    libraryType,
    libraryId: "42",
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { zotero, calls, sleeps };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
  });

const itemJson = (key: string) => ({
  key,
  data: { itemType: "book", dateAdded: "2024-01-01T00:00:00Z" },
  bibtex: `@book{${key.toLowerCase()},}`,
});

describe("ZoteroClient", () => {
  test("builds library prefixes for users and groups", () => {
    expect(client(() => json([])).zotero.libraryPrefix).toBe("/users/42");
    expect(client(() => json([]), "group").zotero.libraryPrefix).toBe("/groups/42");
  });

  test("checkVersion sends If-Modified-Since-Version and understands 304", async () => {
    const { zotero, calls } = client((_url, headers) =>
      headers.get("If-Modified-Since-Version") === "7"
        ? new Response(null, { status: 304 })
        : new Response("A\n", { headers: { "Last-Modified-Version": "9" } }),
    );
    expect(await zotero.checkVersion(7)).toEqual({ modified: false, version: 7 });
    expect(await zotero.checkVersion(5)).toEqual({ modified: true, version: 9 });
    expect(calls[0]?.headers.get("Zotero-API-Key")).toBe("KEY");
    expect(calls[0]?.headers.get("Zotero-API-Version")).toBe("3");
    expect(calls[0]?.url.pathname).toBe("/users/42/items/top");
  });

  test("listItems pages through results and maps the requested export", async () => {
    const all = Array.from({ length: 150 }, (_, i) => itemJson(`K${String(i).padStart(7, "0")}`));
    const { zotero, calls } = client((url) => {
      const start = Number(url.searchParams.get("start"));
      const limit = Number(url.searchParams.get("limit"));
      return json(all.slice(start, start + limit), {
        "Total-Results": "150",
        "Last-Modified-Version": "12",
      });
    });
    const page = await zotero.listItems("COLL0001", "bibtex");
    expect(page.version).toBe(12);
    expect(page.results).toHaveLength(150);
    expect(page.results[0]).toEqual({
      key: "K0000000",
      itemType: "book",
      dateAdded: "2024-01-01T00:00:00Z",
      deleted: false,
      entry: "@book{k0000000,}",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.pathname).toBe("/users/42/collections/COLL0001/items/top");
    expect(calls[0]?.url.searchParams.get("include")).toBe("data,bibtex");
  });

  test("detects library changes between pages", async () => {
    let version = 1;
    const { zotero } = client(() =>
      json([itemJson("AAAAAAAA")], {
        "Total-Results": "2",
        "Last-Modified-Version": String(version++),
      }),
    );
    await expect(zotero.listItems(undefined, "biblatex")).rejects.toBeInstanceOf(
      LibraryChangedError,
    );
  });

  test("retries 429/5xx honoring Retry-After, and respects Backoff", async () => {
    let n = 0;
    const { zotero, sleeps } = client(() => {
      n++;
      if (n === 1)
        return new Response("slow down", { status: 429, headers: { "Retry-After": "3" } });
      if (n === 2) return new Response("oops", { status: 503 });
      return new Response("", { headers: { "Last-Modified-Version": "4", Backoff: "5" } });
    });
    expect(await zotero.checkVersion()).toEqual({ modified: true, version: 4 });
    expect(sleeps[0]).toBe(3000);
    expect(sleeps).toHaveLength(2);
    await zotero.checkVersion();
    expect(sleeps).toHaveLength(3);
    expect(sleeps[2]).toBeGreaterThan(4000);
  });

  test("does not retry client errors and explains them", async () => {
    const { zotero, calls } = client(() => new Response("Forbidden", { status: 403 }));
    const err = await zotero.checkVersion().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZoteroApiError);
    expect((err as ZoteroApiError).status).toBe(403);
    expect((err as Error).message).toContain("read access");
    expect(calls).toHaveLength(1);
  });

  test("gives up after maxAttempts on network errors", async () => {
    const { zotero, calls } = client(() => {
      throw new TypeError("network down");
    });
    await expect(zotero.checkVersion()).rejects.toThrow("network down");
    await Bun.sleep(0);
    expect(calls.length).toBeLessThanOrEqual(5);
  });
});
