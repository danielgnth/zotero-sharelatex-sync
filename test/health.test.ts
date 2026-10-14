import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHealthFile, Health, writeHealthFile } from "../src/health.ts";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("healthy while the stream connects and syncs succeed", () => {
  const c = clock();
  const h = new Health({ streamMaxDownMs: 1000, staleAfterMs: 5000, now: c.now });
  expect(h.report().healthy).toBe(true);
  h.markStreamUp();
  h.markSyncSuccess();
  c.advance(4000);
  expect(h.report()).toMatchObject({ healthy: true, streamConnected: true });
});

test("unhealthy when the stream stays down too long", () => {
  const c = clock();
  const h = new Health({ streamMaxDownMs: 1000, staleAfterMs: 50_000, now: c.now });
  h.markStreamUp();
  h.markStreamDown();
  c.advance(500);
  h.markStreamDown(); // does not reset the outage start
  c.advance(600);
  expect(h.report().reasons).toEqual(["stream disconnected for 1s"]);
  h.markStreamUp();
  expect(h.report().healthy).toBe(true);
});

test("unhealthy when no sync check succeeded recently (including never)", () => {
  const c = clock();
  const h = new Health({ streamMaxDownMs: 50_000, staleAfterMs: 1000, now: c.now });
  h.markStreamUp();
  c.advance(1500);
  expect(h.report().healthy).toBe(false);
  h.markSyncSuccess();
  expect(h.report().healthy).toBe(true);
});

test("health file round trip and staleness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zss-health-"));
  const file = join(dir, "health.json");
  expect((await checkHealthFile(file)).ok).toBe(false);

  const h = new Health({ streamMaxDownMs: 1000, staleAfterMs: 1000 });
  const report = h.report();
  await writeHealthFile(file, report);
  expect(await checkHealthFile(file, 60_000, report.updatedAt + 10)).toEqual({
    ok: true,
    message: "ok",
  });
  expect((await checkHealthFile(file, 60_000, report.updatedAt + 61_000)).message).toContain(
    "stale",
  );

  await writeHealthFile(file, { ...report, healthy: false, reasons: ["broken"] });
  expect(await checkHealthFile(file, 60_000, report.updatedAt)).toEqual({
    ok: false,
    message: "broken",
  });
});
