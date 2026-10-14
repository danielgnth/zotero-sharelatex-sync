// Liveness tracking. The daemon writes its verdict to HEALTH_FILE every few seconds; the
// `healthcheck` command (Docker HEALTHCHECK / Kubernetes livenessProbe) only reads that file.
// A stale file means the event loop is stuck; an unhealthy verdict makes the daemon exit so the
// container runtime restarts it (Docker alone never restarts merely "unhealthy" containers).

import { readFile, rename, writeFile } from "node:fs/promises";

export interface HealthOptions {
  streamMaxDownMs: number;
  staleAfterMs: number;
  now?: () => number;
}

export interface HealthReport {
  healthy: boolean;
  reasons: string[];
  updatedAt: number;
  lastSuccessAt: number | null;
  streamConnected: boolean;
}

export class Health {
  private readonly now: () => number;
  private readonly startedAt: number;
  private streamDownSince: number | undefined;
  private lastSuccessAt: number | undefined;

  constructor(private readonly opts: HealthOptions) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.streamDownSince = this.startedAt;
  }

  markStreamUp(): void {
    this.streamDownSince = undefined;
  }

  markStreamDown(): void {
    this.streamDownSince ??= this.now();
  }

  markSyncSuccess(): void {
    this.lastSuccessAt = this.now();
  }

  report(): HealthReport {
    const now = this.now();
    const reasons: string[] = [];
    if (
      this.streamDownSince !== undefined &&
      now - this.streamDownSince > this.opts.streamMaxDownMs
    ) {
      reasons.push(`stream disconnected for ${Math.round((now - this.streamDownSince) / 1000)}s`);
    }
    const lastOk = this.lastSuccessAt ?? this.startedAt;
    if (now - lastOk > this.opts.staleAfterMs) {
      reasons.push(`no successful sync check for ${Math.round((now - lastOk) / 1000)}s`);
    }
    return {
      healthy: reasons.length === 0,
      reasons,
      updatedAt: now,
      lastSuccessAt: this.lastSuccessAt ?? null,
      streamConnected: this.streamDownSince === undefined,
    };
  }
}

export async function writeHealthFile(path: string, report: HealthReport): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(report));
  await rename(tmp, path);
}

/** Exit code for the healthcheck command: 0 healthy, 1 unhealthy. */
export async function checkHealthFile(
  path: string,
  maxAgeMs = 120_000,
  now = Date.now(),
): Promise<{ ok: boolean; message: string }> {
  let report: HealthReport;
  try {
    report = JSON.parse(await readFile(path, "utf8")) as HealthReport;
  } catch {
    return { ok: false, message: `health file ${path} missing or unreadable` };
  }
  if (now - report.updatedAt > maxAgeMs) {
    return {
      ok: false,
      message: `health file is stale (${Math.round((now - report.updatedAt) / 1000)}s old)`,
    };
  }
  if (!report.healthy) return { ok: false, message: report.reasons.join("; ") };
  return { ok: true, message: "ok" };
}
