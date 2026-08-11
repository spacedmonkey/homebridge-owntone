import type { Logging } from 'homebridge';

import { PUSH_MESSAGE_PREVIEW_MAX_LENGTH, WEBSOCKET_RECONNECT_MAX_DELAY_MS, WEBSOCKET_RECONNECT_MIN_DELAY_MS } from './settings';

/** `notify` categories documented at https://owntone.github.io/owntone-server/json-api/#push-notifications. */
export type OwnTonePushCategory = 'update' | 'database' | 'outputs' | 'player' | 'options' | 'volume' | 'queue';

/** The subset of a WHATWG `CloseEvent` this client logs for diagnostics. */
export interface WebSocketCloseEventLike {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

/** Minimal slice of the WHATWG WebSocket API this client relies on; injectable for tests. */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: WebSocketCloseEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

export interface OwnTonePushClientOptions {
  protocol: 'ws' | 'wss';
  host: string;
  port: number;
  categories: OwnTonePushCategory[];
  /**
   * Called whenever the server reports a change in one of `categories`.
   * OwnTone's docs don't specify the server->client message payload shape,
   * only that "the server will send a message each time one of the events
   * occurred" — so this fires for any message received while connected,
   * relying on the `notify` subscription (sent on open) to have already
   * scoped things server-side, rather than trying to parse and filter by
   * category client-side.
   */
  onEvent: () => void;
  onConnectionChange: (connected: boolean) => void;
  /**
   * Connect, disconnect and retry events are all logged at `info` (never
   * `debug`/`warn`) so they're visible without enabling debug mode — this
   * is the only way to tell, over a Homebridge process that may run for
   * months, whether push notifications are actually working.
   */
  log: Pick<Logging, 'debug' | 'info'>;
  /** Injectable for tests; defaults to undici's `WebSocket`. */
  webSocketImpl?: WebSocketCtor;
}

/**
 * Subscribes to OwnTone's push-notification WebSocket
 * (https://owntone.github.io/owntone-server/json-api/#push-notifications)
 * and calls back whenever something in a subscribed category changes.
 *
 * Reconnects automatically with backoff on any drop. Never throws — a
 * server without WebSocket support (or an unreachable one) just means
 * `onConnectionChange(false)` keeps firing and reconnects keep being
 * scheduled in the background; callers are expected to fall back to
 * polling rather than treating this as fatal.
 */
export class OwnTonePushClient {
  private socket?: WebSocketLike;
  private disposed = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelayMs: number = WEBSOCKET_RECONNECT_MIN_DELAY_MS;
  private everConnected = false;
  private connected = false;
  private url: string;

  constructor(private readonly options: OwnTonePushClientOptions) {
    this.url = `${options.protocol}://${options.host}:${options.port}`;
  }

  /** Open the connection. Safe to call again after `dispose()`. */
  connect(): void {
    if (this.disposed) {
      return;
    }

    const url = this.url;
    const WebSocketImpl = this.options.webSocketImpl ?? defaultWebSocketCtor();

    if (!WebSocketImpl) {
      this.handleDisconnect(new Error('No WebSocket implementation available in this Node.js runtime'));
      return;
    }

    let socket: WebSocketLike;
    try {
      // OwnTone only starts sending events once the client negotiates the
      // "notify" WebSocket subprotocol (Sec-WebSocket-Protocol) — without it
      // the handshake still succeeds and the socket looks connected, but the
      // server never pushes anything over it.
      socket = new WebSocketImpl(url, 'notify');
    } catch (error) {
      this.handleDisconnect(error);
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.connected = true;
      this.reconnectDelayMs = WEBSOCKET_RECONNECT_MIN_DELAY_MS;

      if (this.everConnected) {
        this.options.log.info('Push notification connection to %s re-established.', url);
      } else {
        this.everConnected = true;
        this.options.log.info('Push notifications active (%s).', url);
      }

      this.options.onConnectionChange(true);

      try {
        socket.send(JSON.stringify({ notify: this.options.categories }));
      } catch (error) {
        this.options.log.debug('Failed to send push notification subscription: %s', describeFailure(error));
      }
    };

    socket.onmessage = (event) => {
      this.options.log.debug('Push notification message received from %s: %s', url, describeMessage(event.data));
      this.options.onEvent();
    };

    socket.onerror = (event) => {
      this.handleDisconnect(event);
    };

    socket.onclose = (event) => {
      this.handleDisconnect(event);
    };
  }

  /** Whether the connection is currently open. */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Force-closes and reopens the connection, even if it currently looks
   * fine. There's no ping/pong control exposed by the WHATWG WebSocket API
   * this client is built on, so a connection stuck "open" while actually
   * dead can't be detected directly — this is the way to periodically rule
   * that out (see `WEBSOCKET_REFRESH_INTERVAL_MS`) or to force a retry on
   * demand. A no-op if not currently connected — the existing reconnect
   * backoff already owns that case.
   */
  reconnect(): void {
    if (this.disposed || !this.connected) {
      return;
    }

    this.detachSocket()?.close();
    this.connect();
  }

  /** Stop reconnecting and close the socket. Idempotent. */
  dispose(): void {
    this.disposed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.detachSocket()?.close();
  }

  /** Detaches handlers from the current socket (if any) so it can be closed without triggering a reconnect, and returns it. */
  private detachSocket(): WebSocketLike | undefined {
    const socket = this.socket;
    if (!socket) {
      return undefined;
    }

    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    this.socket = undefined;
    return socket;
  }

  private handleDisconnect(error: unknown): void {
    this.connected = false;
    this.detachSocket();
    this.options.onConnectionChange(false);

    if (this.disposed) {
      return;
    }

    // info, not warn/debug: connect/disconnect/retry are all always visible
    // without enabling debug mode — this is the only way to tell, over a
    // Homebridge process that may run for months, whether push notifications
    // are actually working. Not throttled either, so every attempt shows up.
    // Polling is unaffected either way — onConnectionChange(false) above
    // means the poll timer is already at (or reverts to) the fast configured
    // interval, same as if push had never been available at all.
    this.options.log.info(
      'Push notification connection to %s unavailable: %s. Falling back to polling.',
      this.url,
      describeFailure(error),
    );

    // The full stack is genuinely useful for diagnosing *why* (DNS, refused,
    // TLS, etc.) but is too noisy for the info summary line above, so it's
    // only surfaced at debug.
    if (error instanceof Error && error.stack) {
      this.options.log.debug(error.stack);
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, WEBSOCKET_RECONNECT_MAX_DELAY_MS);

    this.options.log.info('Retrying push notification connection to %s in %dms.', this.url, delay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }
}

/**
 * Node 22+ has a stable global `WebSocket`; Node 20 (the plugin's minimum
 * supported version) does not expose one without a flag, so this falls back
 * to `undici`'s implementation — already a direct dependency (see
 * `owntoneClient.ts`'s `getDispatcher()` for the same lazy-require pattern,
 * used there for the same reason: avoid the import cost when it's unused).
 */
function defaultWebSocketCtor(): WebSocketCtor | undefined {
  if (typeof globalThis.WebSocket === 'function') {
    return globalThis.WebSocket as unknown as WebSocketCtor;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WebSocket } = require('undici') as typeof import('undici');
    return WebSocket as unknown as WebSocketCtor;
  } catch {
    return undefined;
  }
}

/** Best-effort, size-capped rendering of a raw WebSocket message payload for debug logging. */
function describeMessage(data: unknown): string {
  const text = typeof data === 'string' ? data : String(data);
  return text.length > PUSH_MESSAGE_PREVIEW_MAX_LENGTH ? `${text.slice(0, PUSH_MESSAGE_PREVIEW_MAX_LENGTH)}…` : text;
}

/**
 * Best-effort description of whatever `onerror`/`onclose` handed us. Neither
 * is guaranteed to be a real `Error` — a WHATWG `CloseEvent` carries `code`/
 * `reason`/`wasClean` instead of a message, and a plain `error` `Event`
 * often carries no detail at all beyond its `type` — so this pulls out
 * whatever fields are actually present rather than falling through to an
 * unhelpful `String(event)` (typically `"[object Event]"`).
 */
function describeFailure(error: unknown): string {
  if (error === undefined) {
    return 'connection closed';
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object') {
    const candidate = error as { type?: unknown; code?: unknown; reason?: unknown; message?: unknown; error?: unknown };
    const parts: string[] = [];

    if (typeof candidate.type === 'string') {
      parts.push(candidate.type);
    }
    if (typeof candidate.code === 'number') {
      parts.push(`code ${candidate.code}`);
    }
    if (typeof candidate.reason === 'string' && candidate.reason) {
      parts.push(candidate.reason);
    }
    if (typeof candidate.message === 'string' && candidate.message) {
      parts.push(candidate.message);
    }
    if (candidate.error instanceof Error) {
      parts.push(candidate.error.message);
    }

    if (parts.length > 0) {
      return parts.join(', ');
    }
  }

  return String(error);
}
