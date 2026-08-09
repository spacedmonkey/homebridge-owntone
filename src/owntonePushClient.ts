import type { Logging } from 'homebridge';

import { ErrorThrottle } from './errorThrottle';
import { WEBSOCKET_RECONNECT_MAX_DELAY_MS, WEBSOCKET_RECONNECT_MIN_DELAY_MS } from './settings';

/** `notify` categories documented at https://owntone.github.io/owntone-server/json-api/#push-notifications. */
export type OwnTonePushCategory = 'update' | 'database' | 'outputs' | 'player' | 'options' | 'volume' | 'queue';

/** Minimal slice of the WHATWG WebSocket API this client relies on; injectable for tests. */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

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
  private readonly throttle = new ErrorThrottle();
  private socket?: WebSocketLike;
  private disposed = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelayMs: number = WEBSOCKET_RECONNECT_MIN_DELAY_MS;
  private everConnected = false;

  constructor(private readonly options: OwnTonePushClientOptions) {}

  /** Open the connection. Safe to call again after `dispose()`. */
  connect(): void {
    if (this.disposed) {
      return;
    }

    const url = `${this.options.protocol}://${this.options.host}:${this.options.port}`;
    const WebSocketImpl = this.options.webSocketImpl ?? defaultWebSocketCtor();

    if (!WebSocketImpl) {
      this.handleDisconnect(new Error('No WebSocket implementation available in this Node.js runtime'));
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = new WebSocketImpl(url);
    } catch (error) {
      this.handleDisconnect(error);
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelayMs = WEBSOCKET_RECONNECT_MIN_DELAY_MS;
      this.throttle.reset('connect');

      if (this.everConnected) {
        this.options.log.debug('Push notification connection to %s re-established.', url);
      } else {
        this.everConnected = true;
        this.options.log.info('Push notifications active (%s).', url);
      }

      this.options.onConnectionChange(true);

      try {
        socket.send(JSON.stringify({ notify: this.options.categories }));
      } catch (error) {
        this.options.log.debug('Failed to send push notification subscription: %s', describeError(error));
      }
    };

    socket.onmessage = () => {
      this.options.onEvent();
    };

    socket.onerror = (event) => {
      this.handleDisconnect(event);
    };

    socket.onclose = () => {
      this.handleDisconnect(undefined);
    };
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
    this.detachSocket();
    this.options.onConnectionChange(false);

    if (this.disposed) {
      return;
    }

    this.throttle.log(
      'connect',
      (message) => this.options.log.debug(message),
      `Push notification connection unavailable: ${describeError(error)}. Falling back to polling and retrying in the background.`,
    );

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, WEBSOCKET_RECONNECT_MAX_DELAY_MS);

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

function describeError(error: unknown): string {
  if (error === undefined) {
    return 'connection closed';
  }
  return error instanceof Error ? error.message : String(error);
}
