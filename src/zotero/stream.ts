// Zotero streaming API client: https://www.zotero.org/support/dev/web_api/v3/streaming_api
// Uses "multi-key" mode: connect, wait for `connected`, then subscribe to exactly one library
// topic. The API key travels inside the TLS-protected message, never in the URL.

import { log } from "../log.ts";
import { backoffDelay } from "../util.ts";

export interface ZoteroStreamOptions {
  url: string;
  apiKey: string;
  /** Library topic, e.g. "/users/123" or "/groups/456". */
  topic: string;
  /** Called after the subscription is confirmed (initially and after every reconnect). */
  onSubscribed: () => void;
  onDisconnected: () => void;
  onTopicUpdated: (version: number | undefined) => void;
  /** Give up on a connection that has not subscribed within this time. */
  handshakeTimeoutMs?: number;
  /** Reconnect base delay until the server announces its own `retry` value. */
  reconnectBaseMs?: number;
  maxReconnectDelayMs?: number;
  createSocket?: (url: string) => WebSocket;
}

interface StreamMessage {
  event?: string;
  retry?: number;
  topic?: string;
  version?: number;
  subscriptions?: { topics?: string[] }[];
  errors?: { topic?: string; error?: string }[];
}

export class ZoteroStream {
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private serverRetryMs: number;
  private subscribed = false;
  private stopped = true;

  constructor(private readonly opts: ZoteroStreamOptions) {
    this.serverRetryMs = opts.reconnectBaseMs ?? 10_000;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.handshakeTimer);
    this.socket?.close(1000, "shutdown");
    this.socket = undefined;
  }

  private connect(): void {
    if (this.stopped) return;
    log.debug("Connecting to Zotero streaming API", { url: this.opts.url });
    const createSocket = this.opts.createSocket ?? ((url) => new WebSocket(url));
    let socket: WebSocket;
    try {
      socket = createSocket(this.opts.url);
    } catch (err) {
      log.warn("Could not open Zotero stream", { err });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => {
      log.warn("Zotero stream handshake timed out");
      socket.close(4000, "handshake timeout");
    }, this.opts.handshakeTimeoutMs ?? 30_000);

    socket.addEventListener("message", (ev) => this.handleMessage(socket, ev.data));
    socket.addEventListener("error", () => log.debug("Zotero stream socket error"));
    socket.addEventListener("close", (ev) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      clearTimeout(this.handshakeTimer);
      const wasSubscribed = this.subscribed;
      this.subscribed = false;
      if (wasSubscribed) this.opts.onDisconnected();
      if (this.stopped) return;
      log.warn("Zotero stream closed", { code: ev.code, reason: ev.reason || undefined });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = backoffDelay(
      this.attempt++,
      this.serverRetryMs,
      Math.max(this.serverRetryMs, this.opts.maxReconnectDelayMs ?? 300_000),
    );
    log.info("Reconnecting to Zotero stream", { delayMs: delay, attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private handleMessage(socket: WebSocket, data: unknown): void {
    let msg: StreamMessage;
    try {
      msg = JSON.parse(String(data)) as StreamMessage;
    } catch {
      log.warn("Ignoring malformed stream message");
      return;
    }
    switch (msg.event) {
      case "connected":
        if (typeof msg.retry === "number" && msg.retry > 0) this.serverRetryMs = msg.retry;
        socket.send(
          JSON.stringify({
            action: "createSubscriptions",
            subscriptions: [{ apiKey: this.opts.apiKey, topics: [this.opts.topic] }],
          }),
        );
        return;
      case "subscriptionsCreated": {
        const ok = msg.subscriptions?.some((s) => s.topics?.includes(this.opts.topic));
        if (!ok) {
          log.error("Zotero stream rejected the subscription", {
            topic: this.opts.topic,
            errors: msg.errors,
          });
          socket.close(4001, "subscription rejected");
          return;
        }
        clearTimeout(this.handshakeTimer);
        this.attempt = 0;
        this.subscribed = true;
        log.info("Subscribed to Zotero stream", { topic: this.opts.topic });
        this.opts.onSubscribed();
        return;
      }
      case "topicUpdated":
        if (msg.topic === this.opts.topic) {
          log.debug("Zotero library updated", { version: msg.version });
          this.opts.onTopicUpdated(typeof msg.version === "number" ? msg.version : undefined);
        }
        return;
      case "topicRemoved":
        if (msg.topic === this.opts.topic) {
          log.error("Zotero stream access to library removed; resubscribing");
          socket.close(4002, "topic removed");
        }
        return;
      default:
        log.debug("Ignoring stream event", { event: msg.event });
    }
  }
}
