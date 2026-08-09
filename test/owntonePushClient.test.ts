import {
  OwnTonePushClient,
  type OwnTonePushClientOptions,
  type WebSocketCloseEventLike,
  type WebSocketCtor,
  type WebSocketLike,
} from '../src/owntonePushClient';
import { WEBSOCKET_RECONNECT_MAX_DELAY_MS, WEBSOCKET_RECONNECT_MIN_DELAY_MS } from '../src/settings';
import { createMockLog } from './helpers/homebridgeMock';

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: WebSocketCloseEventLike) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

function createHarness(overrides: Partial<OwnTonePushClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const webSocketImpl = jest.fn((_url: string): WebSocketLike => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });

  const log = createMockLog();
  const onEvent = jest.fn();
  const onConnectionChange = jest.fn();

  const client = new OwnTonePushClient({
    protocol: 'ws',
    host: '192.168.1.50',
    port: 3688,
    categories: ['player', 'volume'],
    onEvent,
    onConnectionChange,
    log,
    webSocketImpl: webSocketImpl as unknown as WebSocketCtor,
    ...overrides,
  });

  return { client, sockets, log, onEvent, onConnectionChange, webSocketImpl };
}

function latestSocket(sockets: FakeSocket[]): FakeSocket {
  return sockets[sockets.length - 1];
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('OwnTonePushClient — connecting', () => {
  it('opens a socket at the configured ws URL', () => {
    const { client, webSocketImpl } = createHarness({ protocol: 'wss', host: 'owntone.local', port: 3688 });
    client.connect();
    expect(webSocketImpl).toHaveBeenCalledWith('wss://owntone.local:3688');
  });

  it('sends a notify subscription for the configured categories once open', () => {
    const { client, sockets } = createHarness({ categories: ['player', 'outputs'] });
    client.connect();
    latestSocket(sockets).onopen?.();
    expect(JSON.parse(latestSocket(sockets).sent[0])).toEqual({ notify: ['player', 'outputs'] });
  });

  it('reports connected once the socket opens', () => {
    const { client, sockets, onConnectionChange } = createHarness();
    client.connect();
    latestSocket(sockets).onopen?.();
    expect(onConnectionChange).toHaveBeenCalledWith(true);
  });

  it('logs at info level, both for the first connection and for a later reconnect', () => {
    const { client, sockets, log } = createHarness();
    client.connect();
    latestSocket(sockets).onopen?.();
    expect(log.info).toHaveBeenCalledWith('Push notifications active (%s).', 'ws://192.168.1.50:3688');

    latestSocket(sockets).onclose?.({});
    jest.advanceTimersByTime(WEBSOCKET_RECONNECT_MIN_DELAY_MS);
    latestSocket(sockets).onopen?.();

    expect(log.info).toHaveBeenCalledWith('Push notification connection to %s re-established.', 'ws://192.168.1.50:3688');
  });
});

describe('OwnTonePushClient — events', () => {
  // OwnTone's docs don't specify the server->client message payload shape,
  // so any message received while connected is treated as "something in a
  // subscribed category changed" rather than parsed/filtered client-side.
  it('fires onEvent for any message received once connected', () => {
    const { client, sockets, onEvent } = createHarness();
    client.connect();
    latestSocket(sockets).onopen?.();
    latestSocket(sockets).onmessage?.({ data: '{"notify":["player"]}' });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('does not throw and still fires onEvent for a message with unparsable data', () => {
    const { client, sockets, onEvent } = createHarness();
    client.connect();
    latestSocket(sockets).onopen?.();
    expect(() => latestSocket(sockets).onmessage?.({ data: 'not json at all {{{' })).not.toThrow();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe('OwnTonePushClient — disconnects and reconnects', () => {
  it('logs a connection failure at info level, not warn or debug, so it is visible without debug mode', () => {
    const { client, sockets, log } = createHarness();
    client.connect();

    latestSocket(sockets).onerror?.(new Error('ECONNREFUSED'));

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'Push notification connection to %s unavailable: %s. Falling back to polling.',
      'ws://192.168.1.50:3688',
      'ECONNREFUSED',
    );
  });

  it('includes the close code and reason when the server closes the connection', () => {
    const { client, sockets, log } = createHarness();
    client.connect();

    latestSocket(sockets).onclose?.({ code: 1006, reason: 'abnormal closure', wasClean: false });

    expect(log.info).toHaveBeenCalledWith(
      'Push notification connection to %s unavailable: %s. Falling back to polling.',
      'ws://192.168.1.50:3688',
      'code 1006, abnormal closure',
    );
  });

  it('also logs the full stack at debug level, alongside the info summary', () => {
    const { client, sockets, log } = createHarness();
    client.connect();

    const error = new Error('ECONNREFUSED');
    latestSocket(sockets).onerror?.(error);

    expect(log.debug).toHaveBeenCalledWith(error.stack);
  });

  it('logs every retry attempt at info level, not just the first', () => {
    const { client, sockets, log } = createHarness();
    client.connect();

    latestSocket(sockets).onerror?.(new Error('refused'));
    const firstRetryLogs = log.info.mock.calls.filter((call) => String(call[0]).startsWith('Retrying')).length;
    expect(firstRetryLogs).toBe(1);

    jest.advanceTimersByTime(WEBSOCKET_RECONNECT_MIN_DELAY_MS);
    latestSocket(sockets).onerror?.(new Error('refused again'));
    const secondRetryLogs = log.info.mock.calls.filter((call) => String(call[0]).startsWith('Retrying')).length;
    expect(secondRetryLogs).toBe(2);
  });

  it('reports disconnected and schedules a reconnect on close', () => {
    const { client, sockets, onConnectionChange, webSocketImpl } = createHarness();
    client.connect();
    latestSocket(sockets).onopen?.();
    onConnectionChange.mockClear();

    latestSocket(sockets).onclose?.({});
    expect(onConnectionChange).toHaveBeenCalledWith(false);
    expect(webSocketImpl).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(WEBSOCKET_RECONNECT_MIN_DELAY_MS);
    expect(webSocketImpl).toHaveBeenCalledTimes(2);
  });

  it('reports disconnected and schedules a reconnect on error', () => {
    const { client, sockets, onConnectionChange, webSocketImpl } = createHarness();
    client.connect();

    latestSocket(sockets).onerror?.(new Error('ECONNREFUSED'));
    expect(onConnectionChange).toHaveBeenCalledWith(false);

    jest.advanceTimersByTime(WEBSOCKET_RECONNECT_MIN_DELAY_MS);
    expect(webSocketImpl).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially between reconnect attempts, capped at the max delay', () => {
    const { client, sockets, webSocketImpl } = createHarness();
    client.connect();

    let expectedDelay = WEBSOCKET_RECONNECT_MIN_DELAY_MS;
    for (let attempt = 0; attempt < 6; attempt++) {
      const callsBefore = webSocketImpl.mock.calls.length;
      latestSocket(sockets).onerror?.(new Error('refused'));

      jest.advanceTimersByTime(expectedDelay - 1);
      expect(webSocketImpl).toHaveBeenCalledTimes(callsBefore);

      jest.advanceTimersByTime(1);
      expect(webSocketImpl).toHaveBeenCalledTimes(callsBefore + 1);

      expectedDelay = Math.min(expectedDelay * 2, WEBSOCKET_RECONNECT_MAX_DELAY_MS);
    }

    expect(expectedDelay).toBe(WEBSOCKET_RECONNECT_MAX_DELAY_MS);
  });

  it('resets the backoff delay after a successful reconnect', () => {
    const { client, sockets, webSocketImpl } = createHarness();
    client.connect();

    // First failure: schedules a retry at the minimum delay, then doubles.
    latestSocket(sockets).onerror?.(new Error('refused'));
    jest.advanceTimersByTime(WEBSOCKET_RECONNECT_MIN_DELAY_MS);
    expect(webSocketImpl).toHaveBeenCalledTimes(2);

    // That retry succeeds.
    latestSocket(sockets).onopen?.();

    // A subsequent failure should retry at the *minimum* delay again, not
    // the doubled one, since the successful connection reset it.
    latestSocket(sockets).onclose?.({});
    jest.advanceTimersByTime(WEBSOCKET_RECONNECT_MIN_DELAY_MS - 1);
    expect(webSocketImpl).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(webSocketImpl).toHaveBeenCalledTimes(3);
  });

});

describe('OwnTonePushClient — isConnected', () => {
  it('is false initially, true once open, and false again after a drop', () => {
    const { client, sockets } = createHarness();
    expect(client.isConnected).toBe(false);

    client.connect();
    expect(client.isConnected).toBe(false);

    latestSocket(sockets).onopen?.();
    expect(client.isConnected).toBe(true);

    latestSocket(sockets).onclose?.({});
    expect(client.isConnected).toBe(false);
  });
});

describe('OwnTonePushClient — reconnect', () => {
  it('force-closes the current socket and opens a fresh one', () => {
    const { client, sockets, webSocketImpl } = createHarness();
    client.connect();
    latestSocket(sockets).onopen?.();
    const firstSocket = latestSocket(sockets);

    client.reconnect();

    expect(firstSocket.closed).toBe(true);
    expect(webSocketImpl).toHaveBeenCalledTimes(2);
  });

  it('does not report a connection change from the forced close, only from the fresh connection', () => {
    const { client, sockets, onConnectionChange } = createHarness();
    client.connect();
    latestSocket(sockets).onopen?.();
    onConnectionChange.mockClear();

    client.reconnect();
    expect(onConnectionChange).not.toHaveBeenCalledWith(false);

    latestSocket(sockets).onopen?.();
    expect(onConnectionChange).toHaveBeenCalledWith(true);
  });

  it('is a no-op when not currently connected', () => {
    const { client, webSocketImpl } = createHarness();
    client.connect();
    expect(webSocketImpl).toHaveBeenCalledTimes(1);

    client.reconnect();
    expect(webSocketImpl).toHaveBeenCalledTimes(1);
  });

  it('is a no-op after dispose()', () => {
    const { client, sockets, webSocketImpl } = createHarness();
    client.connect();
    latestSocket(sockets).onopen?.();

    client.dispose();
    client.reconnect();

    expect(webSocketImpl).toHaveBeenCalledTimes(1);
  });

  it('falls through to the normal failure handling if the fresh connection then fails', () => {
    const { client, sockets, onConnectionChange, log } = createHarness();
    client.connect();
    latestSocket(sockets).onopen?.();

    client.reconnect();
    latestSocket(sockets).onerror?.(new Error('refused after refresh'));

    expect(onConnectionChange).toHaveBeenCalledWith(false);
    expect(log.info).toHaveBeenCalledWith(
      'Push notification connection to %s unavailable: %s. Falling back to polling.',
      'ws://192.168.1.50:3688',
      'refused after refresh',
    );
  });
});

describe('OwnTonePushClient — dispose', () => {
  it('closes the socket and does not reconnect', () => {
    const { client, sockets, webSocketImpl } = createHarness();
    client.connect();
    latestSocket(sockets).onopen?.();

    client.dispose();
    expect(latestSocket(sockets).closed).toBe(true);

    jest.advanceTimersByTime(WEBSOCKET_RECONNECT_MAX_DELAY_MS * 10);
    expect(webSocketImpl).toHaveBeenCalledTimes(1);
  });

  it('cancels an already-scheduled reconnect', () => {
    const { client, sockets, webSocketImpl } = createHarness();
    client.connect();
    latestSocket(sockets).onerror?.(new Error('refused'));

    client.dispose();
    jest.advanceTimersByTime(WEBSOCKET_RECONNECT_MAX_DELAY_MS * 10);
    expect(webSocketImpl).toHaveBeenCalledTimes(1);
  });

  it('does not report a connection change from its own close', () => {
    const { client, sockets, onConnectionChange } = createHarness();
    client.connect();
    latestSocket(sockets).onopen?.();
    onConnectionChange.mockClear();

    client.dispose();
    expect(onConnectionChange).not.toHaveBeenCalled();
  });

  it('is idempotent and connect() after dispose() is a no-op', () => {
    const { client, webSocketImpl } = createHarness();
    client.connect();
    client.dispose();
    client.dispose();

    expect(() => client.connect()).not.toThrow();
    expect(webSocketImpl).toHaveBeenCalledTimes(1);
  });
});

describe('OwnTonePushClient — default transport resolution', () => {
  afterEach(() => {
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  });

  it('uses globalThis.WebSocket when no webSocketImpl is injected and a global one exists', () => {
    const sockets: FakeSocket[] = [];
    const ctor = jest.fn((_url: string) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    (globalThis as { WebSocket?: unknown }).WebSocket = ctor;

    const client = new OwnTonePushClient({
      protocol: 'ws',
      host: 'h',
      port: 1,
      categories: ['player'],
      onEvent: jest.fn(),
      onConnectionChange: jest.fn(),
      log: createMockLog(),
    });
    client.connect();

    expect(ctor).toHaveBeenCalledWith('ws://h:1');
  });
});
