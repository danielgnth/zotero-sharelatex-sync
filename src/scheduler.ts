// Coalesces sync requests: debounces bursts of change events (with an upper bound so a busy
// library cannot starve the sync), never runs two syncs at once, and retries failures with
// exponential backoff.

import { errorMessage, log } from "./log.ts";
import { backoffDelay } from "./util.ts";

export interface SchedulerOptions {
  debounceMs: number;
  maxDebounceMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  run: (reason: string) => Promise<void>;
}

export class SyncScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dueAt: number | undefined;
  private timerKind: "debounce" | "retry" | undefined;
  private firstRequestAt: number | undefined;
  private reasons = new Set<string>();
  private running: Promise<void> | undefined;
  private rerun = false;
  private failures = 0;
  private stopped = false;

  constructor(private readonly opts: SchedulerOptions) {}

  /** Request a sync. `immediate` skips the debounce window (startup, reconnect, safety checks). */
  request(reason: string, immediate = false): void {
    if (this.stopped) return;
    this.reasons.add(reason);
    if (this.running) {
      this.rerun = true;
      return;
    }
    const now = Date.now();
    if (immediate) {
      this.arm(0, "debounce");
      return;
    }
    // A pending retry that fires sooner than the debounce window already covers this request.
    if (this.timerKind === "retry" && this.dueAt !== undefined) {
      if (this.dueAt <= now + this.opts.debounceMs) return;
    }
    this.firstRequestAt ??= now;
    const target = Math.min(
      now + this.opts.debounceMs,
      this.firstRequestAt + this.opts.maxDebounceMs,
    );
    this.arm(target - now, "debounce");
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Stop scheduling and wait for an in-flight sync to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private arm(delayMs: number, kind: "debounce" | "retry"): void {
    clearTimeout(this.timer);
    this.timerKind = kind;
    this.dueAt = Date.now() + Math.max(0, delayMs);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.dueAt = undefined;
        this.timerKind = undefined;
        void this.fire();
      },
      Math.max(0, delayMs),
    );
  }

  private async fire(): Promise<void> {
    if (this.stopped || this.running) return;
    const reason = [...this.reasons].join(", ") || "retry";
    this.reasons.clear();
    this.firstRequestAt = undefined;

    let failed = false;
    this.running = (async () => {
      try {
        await this.opts.run(reason);
        this.failures = 0;
      } catch (err) {
        failed = true;
        this.failures++;
        const delay = backoffDelay(this.failures - 1, this.opts.retryBaseMs, this.opts.retryMaxMs);
        log.error("Sync failed", {
          reason,
          err: errorMessage(err),
          failures: this.failures,
          retryInMs: delay,
        });
        if (!this.stopped) this.arm(delay, "retry");
      }
    })();
    await this.running;
    this.running = undefined;

    if (this.rerun && !this.stopped) {
      this.rerun = false;
      // After a failure the retry timer is already armed; it will pick up the pending reasons.
      if (!failed) this.request("changes during sync");
    }
  }
}
