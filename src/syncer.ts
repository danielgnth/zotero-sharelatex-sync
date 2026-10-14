// One sync = (cheap version check) -> fetch items -> build .bib -> push if changed.

import { buildBibliography } from "./bib.ts";
import type { BibFormat } from "./config.ts";
import type { PublishResult } from "./git.ts";
import { log } from "./log.ts";
import { sha256 } from "./util.ts";
import { type ItemInfo, LibraryChangedError, type ZoteroClient } from "./zotero/client.ts";
import { collectionTree } from "./zotero/collections.ts";

export interface SyncerOptions {
  zotero: Pick<ZoteroClient, "checkVersion" | "listCollections" | "listItems">;
  collectionKey?: string;
  includeSubcollections: boolean;
  format: BibFormat;
  publish: (content: string) => Promise<PublishResult>;
  onSuccess?: () => void;
}

export class Syncer {
  /** Library version that the last successful sync reflects. */
  private syncedVersion: number | undefined;
  private publishedHash: string | undefined;

  constructor(private readonly opts: SyncerOptions) {}

  /** True if a stream notification about `version` may contain changes we have not synced. */
  isNewer(version: number | undefined): boolean {
    return (
      version === undefined || this.syncedVersion === undefined || version > this.syncedVersion
    );
  }

  async sync(reason: string, force = false): Promise<void> {
    if (!force && this.syncedVersion !== undefined) {
      const check = await this.opts.zotero.checkVersion(this.syncedVersion);
      if (!check.modified) {
        log.debug("Library unchanged", { reason, version: this.syncedVersion });
        this.opts.onSuccess?.();
        return;
      }
    }

    const { items, version } = await this.fetchItems();
    const bib = buildBibliography(items);
    for (const r of bib.renamed) log.warn("Duplicate citation key renamed", r);
    for (const s of bib.skipped) log.warn("Item skipped", s);

    const hash = await sha256(bib.content);
    if (hash === this.publishedHash) {
      log.info("Bibliography unchanged", { reason, version, entries: bib.entryCount });
    } else {
      const result = await this.opts.publish(bib.content);
      this.publishedHash = hash;
      if (result.changed) {
        log.info("Pushed bibliography", {
          reason,
          version,
          entries: bib.entryCount,
          commit: result.commit,
        });
      } else {
        log.info("Bibliography already up to date in project", {
          reason,
          version,
          entries: bib.entryCount,
        });
      }
    }
    this.syncedVersion = version;
    this.opts.onSuccess?.();
  }

  private async fetchItems(): Promise<{ items: ItemInfo[]; version: number }> {
    const { zotero, collectionKey, includeSubcollections, format } = this.opts;
    const versions = new Set<number>();
    let collections: (string | undefined)[] = [collectionKey];
    if (collectionKey && includeSubcollections) {
      const all = await zotero.listCollections();
      versions.add(all.version);
      collections = collectionTree(all.results, collectionKey);
    }
    const items: ItemInfo[] = [];
    for (const key of collections) {
      const page = await zotero.listItems(key, format);
      versions.add(page.version);
      items.push(...page.results);
    }
    if (versions.size > 1) throw new LibraryChangedError("Library changed during sync");
    return { items, version: [...versions][0] ?? 0 };
  }
}
