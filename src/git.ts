// Publishes the bibliography to the ShareLaTeX git bridge. Every publish starts from a fresh
// clone in a temporary directory that is removed afterwards, so there is no local repository
// state that could get corrupted or diverge, and no credentials are ever written to disk.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redact } from "./log.ts";

export interface GitTarget {
  url: string;
  username: string;
  token: string;
  branch: string;
  bibPath: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
  /** GIT_ALLOW_PROTOCOL value, e.g. "https". */
  allowedProtocols: string;
}

export type PublishResult = { changed: false } | { changed: true; commit: string };

export class GitError extends Error {
  override name = "GitError";
}

/** The remote moved on between clone and push; a fresh attempt will usually succeed. */
export class PushRejectedError extends GitError {
  override name = "PushRejectedError";
}

const PASSTHROUGH_ENV = [
  "PATH",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
];

const ENTRYPOINT = join(import.meta.dir, "index.ts");

/**
 * Environment for git child processes. Starts from an allow-list (so unrelated secrets such as
 * ZOTERO_API_KEY never reach git) and configures our own credential helper through
 * GIT_CONFIG_* variables, which keeps the token out of argv and out of .git/config.
 */
export function gitEnv(target: GitTarget, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const host = new URL(target.url).host;
  Object.assign(env, {
    HOME: home,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: target.allowedProtocols,
    GIT_AUTHOR_NAME: target.authorName,
    GIT_AUTHOR_EMAIL: target.authorEmail,
    GIT_COMMITTER_NAME: target.authorName,
    GIT_COMMITTER_EMAIL: target.authorEmail,
    ZSS_GIT_HOST: host,
    ZSS_GIT_USERNAME: target.username,
    ZSS_GIT_TOKEN: target.token,
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: `!"${process.execPath}" "${ENTRYPOINT}" git-credential`,
    GIT_CONFIG_KEY_1: "http.lowSpeedLimit",
    GIT_CONFIG_VALUE_1: "1000",
    GIT_CONFIG_KEY_2: "http.lowSpeedTime",
    GIT_CONFIG_VALUE_2: "60",
    GIT_CONFIG_KEY_3: "commit.gpgSign",
    GIT_CONFIG_VALUE_3: "false",
    GIT_CONFIG_KEY_4: "core.hooksPath",
    GIT_CONFIG_VALUE_4: "/dev/null",
  });
  return env;
}

async function git(
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? 120_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: redact(stderr.trim()) };
}

async function gitOrThrow(
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
): Promise<string> {
  const res = await git(args, opts);
  if (res.code !== 0) {
    throw new GitError(`git ${args[0]} failed (exit ${res.code}): ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

/** Clone, replace the bibliography file, and push if its content changed. */
export async function publishBibliography(
  target: GitTarget,
  content: string,
  workDir: string,
): Promise<PublishResult> {
  const tmp = await mkdtemp(join(workDir, "zss-"));
  try {
    const env = gitEnv(target, tmp);
    const repo = join(tmp, "repo");
    await gitOrThrow(
      [
        "clone",
        "--quiet",
        "--no-tags",
        "--single-branch",
        "--branch",
        target.branch,
        "--",
        target.url,
        repo,
      ],
      { cwd: tmp, env },
    );

    const file = join(repo, target.bibPath);
    const current = await readFile(file, "utf8").catch(() => undefined);
    if (current === content) return { changed: false };

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    await gitOrThrow(["add", "--", target.bibPath], { cwd: repo, env });
    await gitOrThrow(["commit", "--quiet", "--no-verify", "-m", target.commitMessage], {
      cwd: repo,
      env,
    });
    const commit = await gitOrThrow(["rev-parse", "HEAD"], { cwd: repo, env });

    const push = await git(["push", "--quiet", "origin", `HEAD:refs/heads/${target.branch}`], {
      cwd: repo,
      env,
    });
    if (push.code !== 0) {
      const Err = /rejected|non-fast-forward|fetch first/i.test(push.stderr)
        ? PushRejectedError
        : GitError;
      throw new Err(`git push failed (exit ${push.code}): ${push.stderr}`);
    }
    return { changed: true, commit };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
