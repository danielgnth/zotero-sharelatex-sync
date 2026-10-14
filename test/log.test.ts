import { afterEach, expect, test } from "bun:test";
import { log, redact, registerSecret, setLogSink } from "../src/log.ts";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

test("redacts registered secrets, their encodings, and URL credentials", () => {
  registerSecret("tok/en+secret", "git");
  expect(redact("token tok/en+secret here")).toBe("token *** here");
  expect(redact(`enc ${encodeURIComponent("tok/en+secret")}`)).toBe("enc ***");
  expect(redact(`Authorization: Basic ${btoa("git:tok/en+secret")}`)).toBe(
    "Authorization: Basic ***",
  );
  expect(redact("fatal: https://user:pw@host/git/x not found")).toBe(
    "fatal: https://***@host/git/x not found",
  );
});

test("log lines are JSON and redacted, including error fields", () => {
  const lines: string[] = [];
  restore = setLogSink((line) => lines.push(line));
  registerSecret("hunter2-secret");
  log.error("boom", { err: new Error("bad hunter2-secret") });
  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0] ?? "{}");
  expect(record).toMatchObject({ level: "error", msg: "boom", err: "bad ***" });
});
