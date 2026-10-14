// Wires everything together for the long-running daemon and the one-shot `once` command.

import type { Config } from "./config.ts";
import { type GitTarget, PushRejectedError, publishBibliography } from "./git.ts";
import { Health, writeHealthFile } from "./health.ts";
import { errorMessage, log } from "./log.ts";
import { SyncScheduler } from "./scheduler.ts";
import { Syncer } from "./syncer.ts";
import { ZoteroClient } from "./zotero/client.ts";
import { ZoteroStream } from "./zotero/stream.ts";

const PUSH_ATTEMPTS = 3;
const WATCHDOG_INTERVAL_MS = 15_000;
const SHUTDOWN_GRACE_MS = 20_000;

function createSyncer(
  config: Config,
  onSuccess?: () => void,
): { syncer: Syncer; zotero: ZoteroClient } {
  const zotero = new ZoteroClient({
    apiUrl: config.zotero.apiUrl,
    apiKey: config.zotero.apiKey,
    libraryType: config.zotero.libraryType,
    libraryId: config.zotero.libraryId,
  });
  const target: GitTarget = {
    url: config.sharelatex.gitUrl,
    username: config.sharelatex.gitUsername,
    token: config.sharelatex.gitToken,
    branch: config.sharelatex.branch,
    bibPath: config.sharelatex.bibPath,
    commitMessage: config.sharelatex.commitMessage,
    authorName: config.sharelatex.authorName,
    authorEmail: config.sharelatex.authorEmail,
    allowedProtocols: config.sharelatex.allowedProtocols,
  };
  const publish = async (content: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await publishBibliography(target, content, config.sync.workDir);
      } catch (err) {
        if (!(err instanceof PushRejectedError) || attempt >= PUSH_ATTEMPTS) throw err;
        log.warn("Push rejected, retrying with a fresh clone", { attempt });
      }
    }
  };
  const syncer = new Syncer({
    zotero,
    collectionKey: config.zotero.collectionKey,
    includeSubcollections: config.zotero.includeSubcollections,
    format: config.zotero.format,
    publish,
    onSuccess,
  });
  return { syncer, zotero };
}

function describeSource(config: Config, zotero: ZoteroClient): Record<string, unknown> {
  return {
    library: zotero.libraryPrefix,
    collection: config.zotero.collectionKey ?? "(whole library)",
    includeSubcollections: config.zotero.includeSubcollections,
    format: config.zotero.format,
    target: `${new URL(config.sharelatex.gitUrl).host} ${config.sharelatex.branch}:${config.sharelatex.bibPath}`,
  };
}

export async function runOnce(config: Config): Promise<void> {
  const { syncer, zotero } = createSyncer(config);
  log.info("Running a single sync", describeSource(config, zotero));
  await syncer.sync("once", true);
}

export async function runDaemon(config: Config): Promise<void> {
  const health = new Health({
    streamMaxDownMs: config.sync.streamMaxDownMs,
    staleAfterMs: config.sync.staleAfterMs,
  });
  // Written on every state change (and periodically by the watchdog) for the healthcheck command.
  const publishHealth = () =>
    writeHealthFile(config.sync.healthFile, health.report()).catch((err) =>
      log.warn("Could not write health file", { err: errorMessage(err) }),
    );
  const { syncer, zotero } = createSyncer(config, () => {
    health.markSyncSuccess();
    void publishHealth();
  });
  const scheduler = new SyncScheduler({
    debounceMs: config.sync.debounceMs,
    maxDebounceMs: config.sync.maxDebounceMs,
    retryBaseMs: config.sync.retryBaseMs,
    retryMaxMs: config.sync.retryMaxMs,
    run: (reason) => syncer.sync(reason),
  });
  const stream = new ZoteroStream({
    url: config.zotero.streamUrl,
    apiKey: config.zotero.apiKey,
    topic: zotero.libraryPrefix,
    onSubscribed: () => {
      health.markStreamUp();
      void publishHealth();
      // Events may have been missed while disconnected: catch up right away.
      scheduler.request("stream connected", true);
    },
    onDisconnected: () => {
      health.markStreamDown();
      void publishHealth();
    },
    onTopicUpdated: (version) => {
      if (syncer.isNewer(version)) scheduler.request(`library updated (v${version ?? "?"})`);
    },
  });

  log.info("Starting zotero-sharelatex-sync daemon", describeSource(config, zotero));
  scheduler.request("startup", true);
  stream.start();
  const safety = setInterval(
    () => scheduler.request("safety check", true),
    config.sync.safetyIntervalMs,
  );

  let shuttingDown = false;
  const shutdown = async (code: number, why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutting down", { why });
    clearInterval(safety);
    clearInterval(watchdog);
    stream.stop();
    const timeout = Bun.sleep(SHUTDOWN_GRACE_MS).then(() => log.warn("Shutdown grace expired"));
    await Promise.race([scheduler.stop(), timeout]);
    process.exit(code);
  };

  const watchdog = setInterval(async () => {
    const report = health.report();
    await publishHealth();
    if (!report.healthy) {
      log.error("Unhealthy, exiting so the container gets restarted", { reasons: report.reasons });
      await shutdown(1, "watchdog");
    }
  }, WATCHDOG_INTERVAL_MS);
  await publishHealth();

  process.on("SIGTERM", () => void shutdown(0, "SIGTERM"));
  process.on("SIGINT", () => void shutdown(0, "SIGINT"));
}
