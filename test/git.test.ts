// Exercises publishing against a real (local, bare) git repository.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitTarget, gitEnv, publishBibliography } from "../src/git.ts";

let root: string;
let remote: string;

async function sh(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return out.trim();
}

function target(overrides: Partial<GitTarget> = {}): GitTarget {
  return {
    url: `file://${remote}`,
    username: "git",
    token: "tok",
    branch: "master",
    bibPath: "bib/references.bib",
    commitMessage: "Update bibliography from Zotero",
    authorName: "Zotero Sync",
    authorEmail: "zotero-sync@localhost",
    allowedProtocols: "file",
    ...overrides,
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "zss-git-"));
  remote = join(root, "remote.git");
  const seed = join(root, "seed");
  await sh(["git", "init", "--quiet", "--bare", "--initial-branch=master", remote], root);
  await sh(["git", "init", "--quiet", "--initial-branch=master", seed], root);
  await Bun.write(join(seed, "main.tex"), "\\documentclass{article}\n");
  await sh(["git", "add", "."], seed);
  await sh(["git", "commit", "--quiet", "-m", "init"], seed);
  await sh(["git", "push", "--quiet", remote, "master"], seed);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("commits and pushes a new bibliography, then is a no-op for identical content", async () => {
  const work = await mkdtemp(join(root, "work-"));
  const first = await publishBibliography(target(), "@book{a,}\n", work);
  expect(first.changed).toBe(true);
  const log = await sh(["git", "--git-dir", remote, "log", "--format=%an|%s", "master"], root);
  expect(log.split("\n")[0]).toBe("Zotero Sync|Update bibliography from Zotero");
  expect(await sh(["git", "--git-dir", remote, "show", "master:bib/references.bib"], root)).toBe(
    "@book{a,}",
  );

  const second = await publishBibliography(target(), "@book{a,}\n", work);
  expect(second).toEqual({ changed: false });

  // Temporary clones are cleaned up.
  expect(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: work, onlyFiles: false }))).toEqual(
    [],
  );
});

test("fails cleanly on a missing branch without leaking the token", async () => {
  const work = await mkdtemp(join(root, "work-"));
  const err = await publishBibliography(target({ branch: "nope" }), "x", work).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("git clone failed");
  expect((err as Error).message).not.toContain("tok");
});

test("respects GIT_ALLOW_PROTOCOL", async () => {
  const work = await mkdtemp(join(root, "work-"));
  const err = await publishBibliography(target({ allowedProtocols: "https" }), "x", work).catch(
    (e) => e,
  );
  expect((err as Error).message).toContain("git clone failed");
});

test("git environment excludes unrelated secrets and keeps the token out of config keys", () => {
  process.env.ZOTERO_API_KEY = "should-not-leak";
  try {
    const env = gitEnv(target({ url: "https://latex.example.edu:8443/git/x" }), "/tmp/h");
    expect(env.ZOTERO_API_KEY).toBeUndefined();
    expect(env.ZSS_GIT_HOST).toBe("latex.example.edu:8443");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_VALUE_0).toContain("git-credential");
    for (const [key, value] of Object.entries(env)) {
      if (key !== "ZSS_GIT_TOKEN") expect(value).not.toContain("tok");
    }
  } finally {
    delete process.env.ZOTERO_API_KEY;
  }
});

test("published file content matches exactly", async () => {
  const work = await mkdtemp(join(root, "work-"));
  const content = "% header\n\n@book{b,}\n";
  await publishBibliography(target({ bibPath: "refs.bib" }), content, work);
  const check = join(root, "check");
  await sh(["git", "clone", "--quiet", remote, check], root);
  expect(await readFile(join(check, "refs.bib"), "utf8")).toBe(content);
});
