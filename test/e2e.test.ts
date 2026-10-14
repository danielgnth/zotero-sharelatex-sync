// End-to-end: runs the real daemon process against a fake Zotero (REST + streaming API) and a
// real git smart-HTTP server (`git http-backend`) that requires HTTP Basic auth.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket, Subprocess } from "bun";

const API_KEY = "zotero-e2e-key-123";
const GIT_TOKEN = "git-e2e-token-456";

let root: string;
let remote: string;
let zotero: Server<undefined>;
let gitServer: Server<undefined>;
let daemon: Subprocess<"ignore", "pipe", "pipe">;
const output: string[] = [];
const sockets: ServerWebSocket<undefined>[] = [];

const library = {
  version: 1,
  items: {
    ROOT0001: [entry("AAAAAAAA", "alpha2020")],
    SUB00001: [] as ReturnType<typeof entry>[],
  } as Record<string, ReturnType<typeof entry>[]>,
};

function entry(key: string, cite: string) {
  return {
    key,
    data: { itemType: "journalArticle", dateAdded: `2024-01-01T00:00:00Z` },
    bibtex: `\n@article{${cite},\n\ttitle = {${cite}}\n}\n`,
  };
}

function git(args: string[], cwd: string): Promise<number> {
  return Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
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
  }).exited;
}

async function remoteFile(): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "--git-dir", remote, "show", "master:references.bib"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? text : undefined;
}

async function until(cond: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out; daemon output:\n${output.join("\n")}`);
    await Bun.sleep(25);
  }
}

/** Minimal CGI bridge for `git http-backend`. */
async function gitHttpBackend(req: Request): Promise<Response> {
  const expected = `Basic ${btoa(`git:${GIT_TOKEN}`)}`;
  if (req.headers.get("Authorization") !== expected) {
    return new Response("auth required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="git"' },
    });
  }
  const url = new URL(req.url);
  const proc = Bun.spawn(["git", "http-backend"], {
    stdin: new Uint8Array(await req.arrayBuffer()),
    stdout: "pipe",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: "git",
      REQUEST_METHOD: req.method,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers.get("Content-Type") ?? "",
      HTTP_GIT_PROTOCOL: req.headers.get("Git-Protocol") ?? "",
    },
  });
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  let split = 0;
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === 10 && out[i + 1] === 10) {
      split = i + 2;
      break;
    }
    if (out[i] === 13 && out[i + 1] === 10 && out[i + 2] === 13 && out[i + 3] === 10) {
      split = i + 4;
      break;
    }
  }
  const headers = new Headers();
  let status = 200;
  for (const line of new TextDecoder().decode(out.slice(0, split)).split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers.set(name, value);
  }
  return new Response(out.slice(split), { status, headers });
}

function zoteroApi(req: Request, srv: Server<undefined>): Response | undefined {
  if (req.headers.get("Upgrade") === "websocket") {
    return srv.upgrade(req, { data: undefined }) ? undefined : new Response("bad", { status: 400 });
  }
  if (req.headers.get("Zotero-API-Key") !== API_KEY)
    return new Response("Forbidden", { status: 403 });
  const url = new URL(req.url);
  const headers = { "Last-Modified-Version": String(library.version) };
  if (req.headers.get("If-Modified-Since-Version") === String(library.version)) {
    return new Response(null, { status: 304, headers });
  }
  if (url.pathname === "/users/42/items/top" && url.searchParams.get("format") === "keys") {
    return new Response("AAAAAAAA\n", { headers });
  }
  if (url.pathname === "/users/42/collections") {
    const collections = [
      { key: "ROOT0001", data: { name: "Thesis", parentCollection: false } },
      { key: "SUB00001", data: { name: "Chapter 1", parentCollection: "ROOT0001" } },
    ];
    return Response.json(collections, { headers: { ...headers, "Total-Results": "2" } });
  }
  const match = /^\/users\/42\/collections\/(\w+)\/items\/top$/.exec(url.pathname);
  if (match && url.searchParams.get("include") === "data,bibtex") {
    const items = library.items[match[1] ?? ""] ?? [];
    return Response.json(items, {
      headers: { ...headers, "Total-Results": String(items.length) },
    });
  }
  return new Response("Not found", { status: 404 });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "zss-e2e-"));
  remote = join(root, "project.git");
  const seed = join(root, "seed");
  await git(["init", "--quiet", "--bare", "--initial-branch=master", remote], root);
  await git(["init", "--quiet", "--initial-branch=master", seed], root);
  await Bun.write(join(seed, "main.tex"), "\\documentclass{article}\n");
  await git(["add", "."], seed);
  await git(["commit", "--quiet", "-m", "init"], seed);
  await git(["push", "--quiet", remote, "master"], seed);

  gitServer = Bun.serve({ port: 0, fetch: gitHttpBackend });
  zotero = Bun.serve({
    port: 0,
    fetch: zoteroApi,
    websocket: {
      open(ws) {
        sockets.push(ws);
        ws.send(JSON.stringify({ event: "connected", retry: 50 }));
      },
      message(ws, data) {
        const msg = JSON.parse(String(data));
        const sub = msg.subscriptions[0];
        const ok = sub.apiKey === API_KEY;
        ws.send(
          JSON.stringify({
            event: "subscriptionsCreated",
            subscriptions: ok ? [{ topics: sub.topics }] : [],
            errors: ok ? [] : [{ error: "Forbidden" }],
          }),
        );
      },
    },
  });

  const secretFile = join(root, "git-token");
  await Bun.write(secretFile, `${GIT_TOKEN}\n`);
  daemon = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "daemon"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      ZOTERO_API_KEY: API_KEY,
      ZOTERO_LIBRARY_ID: "42",
      ZOTERO_COLLECTION_KEY: "ROOT0001",
      ZOTERO_API_URL: `http://localhost:${zotero.port}`,
      ZOTERO_STREAM_URL: `ws://localhost:${zotero.port}`,
      SHARELATEX_GIT_URL: `http://localhost:${gitServer.port}/project.git`,
      SHARELATEX_ALLOW_INSECURE_HTTP: "true",
      SHARELATEX_GIT_TOKEN_FILE: secretFile,
      SYNC_DEBOUNCE_SECONDS: "0",
      WORK_DIR: root,
      HEALTH_FILE: join(root, "health.json"),
      LOG_LEVEL: "debug",
    },
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) output.push(...decoder.decode(chunk).trim().split("\n"));
    })();
  }
});

afterAll(async () => {
  daemon?.kill();
  await daemon?.exited;
  zotero?.stop(true);
  gitServer?.stop(true);
  await rm(root, { recursive: true, force: true });
});

test("syncs on startup and on stream notifications, then shuts down cleanly", async () => {
  await until(async () => (await remoteFile())?.includes("@article{alpha2020,") ?? false);
  await until(() => sockets.length > 0 && output.some((l) => l.includes("Subscribed")));

  // A change in a subcollection arrives via the streaming API.
  library.version = 2;
  library.items.SUB00001 = [entry("BBBBBBBB", "beta2021")];
  for (const ws of sockets) {
    ws.send(JSON.stringify({ event: "topicUpdated", topic: "/users/42", version: 2 }));
  }
  await until(async () => (await remoteFile())?.includes("@article{beta2021,") ?? false);
  const bib = (await remoteFile()) ?? "";
  expect(bib.indexOf("alpha2020")).toBeLessThan(bib.indexOf("beta2021"));

  await until(async () => {
    const health = await readFile(join(root, "health.json"), "utf8").catch(() => "{}");
    return JSON.parse(health).streamConnected === true;
  });

  daemon.kill("SIGTERM");
  expect(await daemon.exited).toBe(0);

  const logs = output.join("\n");
  expect(logs).toContain("Pushed bibliography");
  expect(logs).not.toContain(GIT_TOKEN);
  expect(logs).not.toContain(API_KEY);
  expect(logs).not.toContain(btoa(`git:${GIT_TOKEN}`));
}, 30_000);
