import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { credentialResponse } from "../src/git-credential.ts";

const env = { ZSS_GIT_HOST: "latex.example.edu", ZSS_GIT_USERNAME: "git", ZSS_GIT_TOKEN: "tok" };
const request = "protocol=https\nhost=latex.example.edu\npath=git/abc\n\n";

describe("credentialResponse", () => {
  test("answers get for the configured host", () => {
    expect(credentialResponse("get", request, env)).toBe("username=git\npassword=tok\n");
  });

  test("refuses other hosts, operations, and protocols", () => {
    expect(credentialResponse("get", "protocol=https\nhost=evil.example\n", env)).toBe("");
    expect(credentialResponse("store", request, env)).toBe("");
    expect(credentialResponse("erase", request, env)).toBe("");
    expect(credentialResponse("get", "protocol=ssh\nhost=latex.example.edu\n", env)).toBe("");
  });

  test("answers nothing without configuration", () => {
    expect(credentialResponse("get", request, {})).toBe("");
  });
});

test("the entrypoint works as a git credential helper", async () => {
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/index.ts"), "git-credential", "get"],
    { env: { ...env, PATH: process.env.PATH }, stdin: new Blob([request]), stdout: "pipe" },
  );
  expect(await new Response(proc.stdout).text()).toBe("username=git\npassword=tok\n");
  expect(await proc.exited).toBe(0);
});
