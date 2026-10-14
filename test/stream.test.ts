// Runs the stream client against a local WebSocket server that speaks the Zotero protocol.

import { afterEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { ZoteroStream } from "../src/zotero/stream.ts";

interface FakeServer {
  url: string;
  sockets: ServerWebSocket<unknown>[];
  received: unknown[];
  stop: () => void;
}

function fakeZoteroStream(opts: { reject?: boolean } = {}): FakeServer {
  const sockets: ServerWebSocket<unknown>[] = [];
  const received: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
        ws.send(JSON.stringify({ event: "connected", retry: 20 }));
      },
      message(ws, data) {
        const msg = JSON.parse(String(data));
        received.push(msg);
        const topics = msg.subscriptions[0].topics as string[];
        ws.send(
          JSON.stringify(
            opts.reject
              ? {
                  event: "subscriptionsCreated",
                  subscriptions: [],
                  errors: [{ topic: topics[0], error: "Forbidden" }],
                }
              : { event: "subscriptionsCreated", subscriptions: [{ topics }], errors: [] },
          ),
        );
      },
    },
  });
  return { url: `ws://localhost:${server.port}`, sockets, received, stop: () => server.stop(true) };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

test("subscribes, forwards updates for its topic, and reconnects after a drop", async () => {
  const server = fakeZoteroStream();
  cleanups.push(server.stop);
  const events: string[] = [];
  const stream = new ZoteroStream({
    url: server.url,
    apiKey: "KEY",
    topic: "/users/42",
    onSubscribed: () => events.push("subscribed"),
    onDisconnected: () => events.push("disconnected"),
    onTopicUpdated: (v) => events.push(`updated:${v}`),
    maxReconnectDelayMs: 50,
  });
  cleanups.push(() => stream.stop());
  stream.start();

  await until(() => events.includes("subscribed"));
  expect(server.received[0]).toEqual({
    action: "createSubscriptions",
    subscriptions: [{ apiKey: "KEY", topics: ["/users/42"] }],
  });

  const ws = server.sockets[0];
  ws?.send(JSON.stringify({ event: "topicUpdated", topic: "/groups/1", version: 3 }));
  ws?.send(JSON.stringify({ event: "topicUpdated", topic: "/users/42", version: 7 }));
  await until(() => events.includes("updated:7"));
  expect(events).not.toContain("updated:3");

  ws?.close();
  await until(() => events.filter((e) => e === "subscribed").length === 2);
  expect(events).toEqual(["subscribed", "updated:7", "disconnected", "subscribed"]);
});

test("a rejected subscription closes and retries without reporting success", async () => {
  const server = fakeZoteroStream({ reject: true });
  cleanups.push(server.stop);
  let subscribed = 0;
  const stream = new ZoteroStream({
    url: server.url,
    apiKey: "BAD",
    topic: "/users/42",
    onSubscribed: () => subscribed++,
    onDisconnected: () => {},
    onTopicUpdated: () => {},
    maxReconnectDelayMs: 30,
  });
  cleanups.push(() => stream.stop());
  stream.start();
  await until(() => server.received.length >= 2);
  expect(subscribed).toBe(0);
});

test("handshake timeout triggers a reconnect", async () => {
  let connections = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open() {
        connections++; // never sends "connected"
      },
      message() {},
    },
  });
  cleanups.push(() => server.stop(true));
  const stream = new ZoteroStream({
    url: `ws://localhost:${server.port}`,
    apiKey: "KEY",
    topic: "/users/42",
    onSubscribed: () => {},
    onDisconnected: () => {},
    onTopicUpdated: () => {},
    handshakeTimeoutMs: 30,
    reconnectBaseMs: 10,
    maxReconnectDelayMs: 30,
  });
  cleanups.push(() => stream.stop());
  stream.start();
  await until(() => connections >= 2);
});
