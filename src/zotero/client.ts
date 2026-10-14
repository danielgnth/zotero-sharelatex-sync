// Minimal Zotero Web API v3 client: https://www.zotero.org/support/dev/web_api/v3/basics
// Honors the API's rate-limit headers (Backoff, Retry-After) as required by Zotero.

import type { BibFormat, LibraryType } from "../config.ts";
import { log } from "../log.ts";
import { backoffDelay, sleep as defaultSleep, type Sleep } from "../util.ts";

export interface ZoteroClientOptions {
  apiUrl: string;
  apiKey: string;
  libraryType: LibraryType;
  libraryId: string;
  fetch?: typeof fetch;
  sleep?: Sleep;
  maxAttempts?: number;
  requestTimeoutMs?: number;
}

export interface CollectionInfo {
  key: string;
  name: string;
  parentKey: string | null;
  deleted: boolean;
}

export interface ItemInfo {
  key: string;
  itemType: string;
  dateAdded: string;
  deleted: boolean;
  /** The item exported in the requested format (BibTeX/BibLaTeX entry). */
  entry: string;
}

export interface Paged<T> {
  results: T[];
  /** Library version the results correspond to. */
  version: number;
}

/** Non-retryable API error (bad key, missing permission, unknown collection, ...). */
export class ZoteroApiError extends Error {
  override name = "ZoteroApiError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The library changed while a multi-page result was being fetched; retry later. */
export class LibraryChangedError extends Error {
  override name = "LibraryChangedError";
}

const PAGE_SIZE = 100;

interface ZoteroCollectionJson {
  key: string;
  data: { name: string; parentCollection: string | false; deleted?: boolean };
}

interface ZoteroItemJson {
  key: string;
  data: { itemType: string; dateAdded?: string; deleted?: boolean | number };
  [format: string]: unknown;
}

export class ZoteroClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private backoffUntil = 0;

  constructor(private readonly opts: ZoteroClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.timeoutMs = opts.requestTimeoutMs ?? 60_000;
  }

  /** Library path prefix, e.g. "/users/123"; also used as the streaming API topic. */
  get libraryPrefix(): string {
    return `/${this.opts.libraryType === "user" ? "users" : "groups"}/${this.opts.libraryId}`;
  }

  /**
   * Cheap change check: answers 304 when the library version is still `sinceVersion`.
   * Returns the current library version.
   */
  async checkVersion(sinceVersion?: number): Promise<{ modified: boolean; version: number }> {
    const res = await this.request(
      `${this.libraryPrefix}/items/top`,
      { limit: "1", format: "keys" },
      sinceVersion,
    );
    if (res.status === 304) return { modified: false, version: sinceVersion ?? 0 };
    await res.body?.cancel();
    return { modified: true, version: readVersion(res) };
  }

  async listCollections(): Promise<Paged<CollectionInfo>> {
    return this.paged<ZoteroCollectionJson, CollectionInfo>(
      `${this.libraryPrefix}/collections`,
      {},
      (c) => ({
        key: c.key,
        name: c.data.name,
        parentKey: c.data.parentCollection || null,
        deleted: Boolean(c.data.deleted),
      }),
    );
  }

  /** Top-level items of a collection (or of the whole library), exported in `format`. */
  async listItems(collectionKey: string | undefined, format: BibFormat): Promise<Paged<ItemInfo>> {
    const path = collectionKey
      ? `${this.libraryPrefix}/collections/${collectionKey}/items/top`
      : `${this.libraryPrefix}/items/top`;
    return this.paged<ZoteroItemJson, ItemInfo>(
      path,
      { include: `data,${format}`, sort: "dateAdded", direction: "asc" },
      (item) => ({
        key: item.key,
        itemType: item.data.itemType,
        dateAdded: item.data.dateAdded ?? "",
        deleted: Boolean(item.data.deleted),
        entry: typeof item[format] === "string" ? (item[format] as string) : "",
      }),
    );
  }

  private async paged<J, T>(
    path: string,
    params: Record<string, string>,
    map: (json: J) => T,
  ): Promise<Paged<T>> {
    const results: T[] = [];
    let version: number | undefined;
    for (let start = 0; ; start += PAGE_SIZE) {
      const res = await this.request(path, {
        ...params,
        format: "json",
        limit: String(PAGE_SIZE),
        start: String(start),
      });
      const pageVersion = readVersion(res);
      if (version !== undefined && pageVersion !== version) {
        throw new LibraryChangedError(`Library changed while paging ${path}`);
      }
      version = pageVersion;
      const page = (await res.json()) as J[];
      results.push(...page.map(map));
      const total = Number(res.headers.get("Total-Results") ?? results.length);
      if (page.length === 0 || results.length >= total) break;
    }
    return { results, version: version ?? 0 };
  }

  private async request(
    path: string,
    params: Record<string, string>,
    ifModifiedSinceVersion?: number,
  ): Promise<Response> {
    const url = new URL(`${this.opts.apiUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const headers: Record<string, string> = {
      "Zotero-API-Key": this.opts.apiKey,
      "Zotero-API-Version": "3",
    };
    if (ifModifiedSinceVersion !== undefined) {
      headers["If-Modified-Since-Version"] = String(ifModifiedSinceVersion);
    }

    for (let attempt = 1; ; attempt++) {
      const wait = this.backoffUntil - Date.now();
      if (wait > 0) await this.sleep(wait);

      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (attempt >= this.maxAttempts) throw err;
        const delay = backoffDelay(attempt - 1, 1000, 60_000);
        log.warn("Zotero request failed, retrying", { path, attempt, delayMs: delay, err });
        await this.sleep(delay);
        continue;
      }

      const backoff = Number(res.headers.get("Backoff"));
      if (backoff > 0) {
        this.backoffUntil = Math.max(this.backoffUntil, Date.now() + backoff * 1000);
        log.info("Zotero asked to back off", { seconds: backoff });
      }

      if (res.ok || res.status === 304) return res;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxAttempts) {
        const body = (await res.text()).slice(0, 300).trim();
        throw new ZoteroApiError(describeStatus(res.status, path, body), res.status);
      }
      await res.body?.cancel();
      const retryAfter = Number(res.headers.get("Retry-After"));
      const delay = retryAfter > 0 ? retryAfter * 1000 : backoffDelay(attempt - 1, 1000, 60_000);
      log.warn("Zotero API unavailable, retrying", {
        path,
        status: res.status,
        attempt,
        delayMs: delay,
      });
      await this.sleep(delay);
    }
  }
}

function readVersion(res: Response): number {
  const raw = res.headers.get("Last-Modified-Version");
  const version = Number(raw);
  if (raw === null || !Number.isInteger(version)) {
    throw new Error("Zotero response lacks a valid Last-Modified-Version header");
  }
  return version;
}

function describeStatus(status: number, path: string, body: string): string {
  const hint =
    status === 403
      ? " (check that ZOTERO_API_KEY has read access to this library)"
      : status === 404
        ? " (check ZOTERO_LIBRARY_TYPE, ZOTERO_LIBRARY_ID and ZOTERO_COLLECTION_KEY)"
        : "";
  return `Zotero API ${status} for ${path}${hint}${body ? `: ${body}` : ""}`;
}
