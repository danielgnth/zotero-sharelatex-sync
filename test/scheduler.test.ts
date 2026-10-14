import { expect, test } from "bun:test";
import { SyncScheduler } from "../src/scheduler.ts";

function setup(run: (reason: string) => Promise<void>, overrides = {}) {
  return new SyncScheduler({
    debounceMs: 40,
    maxDebounceMs: 100,
    retryBaseMs: 30,
    retryMaxMs: 30,
    run,
    ...overrides,
  });
}

test("debounces bursts into a single run with all reasons", async () => {
  const runs: string[] = [];
  const s = setup(async (reason) => {
    runs.push(reason);
  });
  s.request("a");
  await Bun.sleep(10);
  s.request("b");
  await Bun.sleep(20);
  s.request("a");
  expect(runs).toEqual([]);
  await Bun.sleep(80);
  expect(runs).toEqual(["a, b"]);
  await s.stop();
});

test("maxDebounce bounds the delay under a constant stream of events", async () => {
  const runs: number[] = [];
  const started = Date.now();
  const s = setup(async () => {
    runs.push(Date.now() - started);
  });
  for (let i = 0; i < 12; i++) {
    s.request("tick");
    await Bun.sleep(15);
  }
  expect(runs.length).toBeGreaterThanOrEqual(1);
  expect(runs[0]).toBeLessThan(150);
  await s.stop();
});

test("immediate requests skip the debounce", async () => {
  const runs: string[] = [];
  const s = setup(async (reason) => {
    runs.push(reason);
  });
  s.request("now", true);
  await Bun.sleep(5);
  expect(runs).toEqual(["now"]);
  await s.stop();
});

test("never runs concurrently and reruns after changes during a sync", async () => {
  let active = 0;
  let maxActive = 0;
  const runs: string[] = [];
  const s = setup(
    async (reason) => {
      active++;
      maxActive = Math.max(maxActive, active);
      runs.push(reason);
      await Bun.sleep(30);
      active--;
    },
    { debounceMs: 5, maxDebounceMs: 5 },
  );
  s.request("first", true);
  await Bun.sleep(5);
  s.request("during");
  s.request("during", true);
  await Bun.sleep(100);
  expect(maxActive).toBe(1);
  expect(runs).toEqual(["first", "during, changes during sync"]);
  await s.stop();
});

test("retries failures with backoff until success", async () => {
  let attempts = 0;
  const s = setup(async () => {
    attempts++;
    if (attempts < 3) throw new Error("transient");
  });
  s.request("go", true);
  await Bun.sleep(150);
  expect(attempts).toBe(3);
  expect(s.consecutiveFailures).toBe(0);
  await s.stop();
});

test("stop waits for the in-flight sync and prevents new ones", async () => {
  let finished = false;
  const s = setup(async () => {
    await Bun.sleep(30);
    finished = true;
  });
  s.request("go", true);
  await Bun.sleep(5);
  await s.stop();
  expect(finished).toBe(true);
  s.request("after stop", true);
  await Bun.sleep(10);
});
