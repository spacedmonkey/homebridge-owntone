import type { Logging } from 'homebridge';

import type { ErrorThrottle } from './errorThrottle';
import type { OwnToneClient } from './owntoneClient';
import type { OwnTonePushClientOptions } from './owntonePushClient';
import { OwnTonePushClient } from './owntonePushClient';
import { WEBSOCKET_RECONCILE_INTERVAL_MS } from './settings';
import type { OutputSnapshot, OwnToneConfigResponse, PlayerSnapshot, ResolvedServerConfig, TrackSnapshot } from './types';
import { describeError } from './util';

/** Everything {@link PollLoop} needs from `OwnTonePlatformAccessory`, and nothing else. */
export interface PollLoopDeps {
  config: ResolvedServerConfig;
  client: OwnToneClient;
  log: Logging;
  /** Shared with the rest of the accessory — the same instance, not a copy. */
  throttle: ErrorThrottle;
  pushClientFactory: (options: OwnTonePushClientOptions) => OwnTonePushClient;
  onSuccess(player: PlayerSnapshot, track: TrackSnapshot | undefined, outputs: OutputSnapshot[] | undefined): void;
  onFailure(error: unknown): void;
}

/**
 * Owns the poll timer, in-flight poll de-duplication, and the
 * push-notification WebSocket client that can switch that timer to a slower
 * reconciliation cadence while connected.
 */
export class PollLoop {
  private pollTimer?: NodeJS.Timeout;
  private polling = false;
  private disposed = false;
  private pushClient?: OwnTonePushClient;
  private wsConnected = false;
  private pushRefreshTimer?: NodeJS.Timeout;

  constructor(private readonly deps: PollLoopDeps) {}

  /** `true` while the push-notification WebSocket is connected. */
  get isConnected(): boolean {
    return this.wsConnected;
  }

  start(): void {
    void this.poll();
    this.restartPollTimer();
  }

  /** Stop the poll timer, the push-client reconnect timer, and the push client itself. */
  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.pushRefreshTimer) {
      clearInterval(this.pushRefreshTimer);
      this.pushRefreshTimer = undefined;
    }
    this.pushClient?.dispose();
  }

  /**
   * (Re)creates the poll timer at whichever cadence currently applies.
   * While the push-notification WebSocket is connected, that's just an
   * infrequent reconciliation safety net (`WEBSOCKET_RECONCILE_INTERVAL_MS`)
   * since state changes arrive via `onEvent` instead; otherwise it's the
   * configured `pollingInterval`, same as before push support existed.
   * Called on startup and whenever the WebSocket connects/disconnects.
   */
  private restartPollTimer(): void {
    if (this.disposed) {
      return;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    const intervalMs = this.wsConnected ? WEBSOCKET_RECONCILE_INTERVAL_MS : this.deps.config.pollingInterval * 1000;
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  async poll(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.polling) {
      this.deps.log.debug('"%s": previous poll still running, skipping this cycle.', this.deps.config.name);
      return;
    }

    this.polling = true;
    this.deps.log.debug('"%s": polling %s.', this.deps.config.name, this.deps.client.description);
    try {
      const player = await this.deps.client.getStatus();

      let track: TrackSnapshot | undefined;
      let outputs: OutputSnapshot[] | undefined;

      // Stopped means nothing is playing and there's nothing new to say
      // about which output is in use, so skip both extra requests — one
      // round trip to OwnTone instead of three, every poll.
      if (player.state !== 'stop') {
        try {
          track = await this.deps.client.getNowPlaying();
        } catch (error) {
          // Metadata is optional — a failure here must not mark the whole
          // server unreachable.
          this.deps.throttle.log(
            'nowplaying',
            (message) => this.deps.log.debug(message),
            `"${this.deps.config.name}": could not read now-playing metadata: ${describeError(error)}`,
          );
        }

        // Refreshed every poll, same cadence as player/track state, so the
        // active HomeKit input tracks the currently-selected output even when
        // it's changed outside Homebridge (e.g. from the OwnTone web UI).
        try {
          outputs = await this.deps.client.getOutputs();
        } catch (error) {
          this.deps.throttle.log(
            'outputs',
            (message) => this.deps.log.debug(message),
            `"${this.deps.config.name}": could not read outputs: ${describeError(error)}`,
          );
        }
      }

      this.deps.onSuccess(player, track, outputs);
    } catch (error) {
      this.deps.onFailure(error);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Connects the push-notification WebSocket when `/api/config` says the
   * server supports it. Per OwnTone's JSON API docs, `websocket_port` is
   * always present in that response — it's `0` when the server wasn't
   * built with (or has disabled) websocket support, and the actual port
   * otherwise. Either way this is a one-time check at startup: servers
   * without support just fall back to polling at `config.pollingInterval`,
   * identical to before push support existed.
   */
  connectPushClientIfSupported(config: OwnToneConfigResponse): void {
    if (!this.deps.config.enableWebSocket) {
      this.deps.log.debug('"%s": push notifications disabled by config.', this.deps.config.name);
      return;
    }

    const port = config.websocket_port;
    if (!Number.isInteger(port) || (port as number) <= 0) {
      this.deps.log.info('"%s": OwnTone server does not advertise WebSocket support; using polling only.', this.deps.config.name);
      return;
    }

    this.pushClient = this.deps.pushClientFactory({
      protocol: this.deps.config.protocol === 'https' ? 'wss' : 'ws',
      host: this.deps.config.host,
      port: port as number,
      categories: ['player', 'volume', 'outputs', 'queue', 'options'],
      onEvent: () => {
        this.deps.log.debug('"%s": push notification triggered a poll.', this.deps.config.name);
        void this.poll();
      },
      onConnectionChange: (connected) => this.handlePushConnectionChange(connected),
      log: this.deps.log,
    });
    this.pushClient.connect();
  }

  /** Switches the poll timer between the fast configured interval and the slow WebSocket-connected reconciliation interval. */
  private handlePushConnectionChange(connected: boolean): void {
    if (this.wsConnected === connected) {
      return;
    }
    this.wsConnected = connected;
    this.restartPollTimer();

    if (this.pushRefreshTimer) {
      clearInterval(this.pushRefreshTimer);
      this.pushRefreshTimer = undefined;
    }

    if (connected) {
      // Belt-and-suspenders for a process that may run for months: forces a
      // fresh connection periodically, since a socket stuck "open" while
      // actually dead never fires close/error and would otherwise never be
      // detected (see OwnTonePushClient.reconnect()). User-configurable via
      // pushReconnectInterval — has no effect at all while disconnected,
      // since it's only (re)started here, on transitioning to connected.
      const intervalMs = this.deps.config.pushReconnectInterval * 60_000;
      this.pushRefreshTimer = setInterval(() => this.pushClient?.reconnect(), intervalMs);
      if (typeof this.pushRefreshTimer.unref === 'function') {
        this.pushRefreshTimer.unref();
      }
    }
  }
}
