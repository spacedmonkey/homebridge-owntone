import {
  APIEvent,
  type API,
  type Characteristic,
  type DynamicPlatformPlugin,
  type Logging,
  type PlatformAccessory,
  type PlatformConfig,
  type Service,
} from 'homebridge';

import { OwnToneClient } from './owntoneClient';
import { OwnTonePlatformAccessory } from './platformAccessory';
import {
  DEFAULT_POLLING_INTERVAL,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings';
import type { OutputSnapshot, OwnTonePlatformConfig, OwnToneServerConfig, ResolvedServerConfig } from './types';

/**
 * Homebridge dynamic platform for OwnTone.
 *
 * One accessory is created per entry of the `servers` config array. Because
 * HomeKit does not allow a bridge to expose `Television` services, each
 * accessory is published as an *external* accessory and therefore has to be
 * paired individually in the Home app.
 */
export class OwnTonePlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;

  /** Accessories restored from the Homebridge cache (legacy bridged ones). */
  readonly cachedAccessories: PlatformAccessory[] = [];

  private readonly handlers: OwnTonePlatformAccessory[] = [];

  constructor(
    readonly log: Logging,
    readonly config: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Initialising %s platform', PLATFORM_NAME);

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      try {
        this.discoverDevices();
      } catch (error) {
        // Never let a config problem take Homebridge down with us.
        this.log.error('Failed to set up OwnTone accessories: %s', describeError(error));
      }
    });

    this.api.on(APIEvent.SHUTDOWN, () => {
      this.log.debug('Shutting down, stopping %d poller(s)', this.handlers.length);
      for (const handler of this.handlers) {
        handler.dispose();
      }
    });
  }

  /**
   * Called by Homebridge for every accessory it restored from disk. We keep
   * them only so that they can be cleaned up in {@link discoverDevices}.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Restored cached accessory "%s"', accessory.displayName);
    this.cachedAccessories.push(accessory);
  }

  /** Build one Television accessory per configured OwnTone server. */
  private discoverDevices(): void {
    const servers = resolveServerConfigs(this.config as OwnTonePlatformConfig, this.log);

    if (servers.length === 0) {
      this.log.warn(
        'No usable OwnTone servers configured. Add at least one entry with a "name" and a "host" ' +
          'under the "servers" array in the Homebridge UI.',
      );
    }

    const seenUuids = new Set<string>();

    for (const server of servers) {
      const uuid = this.api.hap.uuid.generate(serverIdentity(server));

      if (seenUuids.has(uuid)) {
        this.log.warn(
          'Skipping duplicate OwnTone server "%s" (%s:%d) — another entry already uses the same name, host and port.',
          server.name,
          server.host,
          server.port,
        );
        continue;
      }
      seenUuids.add(uuid);

      const accessory = new this.api.platformAccessory(server.name, uuid);
      accessory.category = this.api.hap.Categories.TELEVISION;
      accessory.context.server = server;

      const client = new OwnToneClient({
        protocol: server.protocol,
        host: server.host,
        port: server.port,
        timeout: server.timeout,
        username: server.username,
        password: server.password,
        bearerToken: server.bearerToken,
        ignoreCertificateErrors: server.ignoreCertificateErrors,
      });

      this.handlers.push(new OwnTonePlatformAccessory(this, accessory, server, client));

      this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
      this.log.info(
        'Published OwnTone accessory "%s" for %s (polling every %ds). ' +
          'Television accessories cannot be bridged, so pair it separately in the Home app.',
        server.name,
        client.description,
        server.pollingInterval,
      );
    }

    this.cleanUpCachedAccessories(seenUuids);
  }

  /**
   * Remove accessories left in the Homebridge cache. Anything cached is stale
   * by definition: either the server was removed from the config, or it dates
   * back to a bridged registration and is now published externally instead.
   */
  private cleanUpCachedAccessories(configuredUuids: Set<string>): void {
    if (this.cachedAccessories.length === 0) {
      return;
    }

    // Snapshot the list: the array is emptied below, and Homebridge (like the
    // test-suite) may still be holding on to the argument we hand it.
    const removable = [...this.cachedAccessories];

    for (const accessory of removable) {
      if (configuredUuids.has(accessory.UUID)) {
        this.log.info(
          'Removing bridged accessory "%s" from the bridge; it is now published as a standalone Television accessory.',
          accessory.displayName,
        );
      } else {
        this.log.info('Removing accessory "%s" — it is no longer present in the configuration.', accessory.displayName);
      }
    }

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removable);
    this.cachedAccessories.length = 0;
  }
}

/**
 * Stable identity string for a server entry. Feeding this through
 * `hap.uuid.generate` keeps the accessory UUID — and therefore the HomeKit
 * pairing — stable across restarts.
 */
export function serverIdentity(server: Pick<ResolvedServerConfig, 'name' | 'host' | 'port'>): string {
  return `${PLUGIN_NAME}:${server.host.trim().toLowerCase()}:${server.port}:${server.name.trim()}`;
}

/**
 * Validate the `servers` array and apply defaults. Invalid entries are logged
 * and skipped rather than throwing, so one bad entry cannot prevent the other
 * servers from loading.
 */
export function resolveServerConfigs(
  config: OwnTonePlatformConfig | undefined,
  log: Pick<Logging, 'warn' | 'debug'>,
): ResolvedServerConfig[] {
  const raw = config?.servers;

  if (raw === undefined) {
    return [];
  }

  if (!Array.isArray(raw)) {
    log.warn('The "servers" option must be an array; ignoring it.');
    return [];
  }

  const resolved: ResolvedServerConfig[] = [];

  raw.forEach((entry: OwnToneServerConfig | undefined, index: number) => {
    if (!entry || typeof entry !== 'object') {
      log.warn('Ignoring servers[%d]: expected an object.', index);
      return;
    }

    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const host = typeof entry.host === 'string' ? entry.host.trim() : '';

    if (!name) {
      log.warn('Ignoring servers[%d]: "name" is required.', index);
      return;
    }
    if (!host) {
      log.warn('Ignoring server "%s": "host" is required.', name);
      return;
    }

    const protocol = entry.protocol === 'https' ? 'https' : 'http';
    if (entry.protocol !== undefined && entry.protocol !== 'http' && entry.protocol !== 'https') {
      log.warn('Server "%s": unknown protocol "%s", falling back to http.', name, String(entry.protocol));
    }

    resolved.push({
      name,
      protocol,
      host,
      port: positiveInt(entry.port, DEFAULT_PORT, 1, 65535),
      pollingInterval: positiveInt(entry.pollingInterval, DEFAULT_POLLING_INTERVAL, 1, 3600),
      timeout: positiveInt(entry.timeout, DEFAULT_TIMEOUT, 500, 120_000),
      username: nonEmpty(entry.username),
      password: nonEmpty(entry.password),
      bearerToken: nonEmpty(entry.bearerToken),
      ignoreCertificateErrors: entry.ignoreCertificateErrors === true,
      exposeTrackSwitches: entry.exposeTrackSwitches === true,
      // Defaults to enabled — unlike the booleans above, only an explicit
      // `false` opts out, rather than requiring an explicit `true` to opt in.
      enableWebSocket: entry.enableWebSocket !== false,
      outputs: resolveOutputs(entry.outputs),
    });
  });

  return resolved;
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Validate the `outputs` cache written by the custom UI's "Refresh Outputs"
 * button. Malformed or hand-edited entries are dropped rather than rejected,
 * since this is a best-effort seed for the initial InputSource list, not a
 * required field.
 */
function resolveOutputs(value: unknown): OutputSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const outputs: OutputSnapshot[] = [];

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }

    const candidate = raw as Partial<Record<keyof OutputSnapshot, unknown>>;
    const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : undefined;
    const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : undefined;

    if (!id || !name) {
      continue;
    }

    outputs.push({
      id,
      name,
      type: typeof candidate.type === 'string' && candidate.type.trim() ? candidate.type : undefined,
      selected: candidate.selected === true,
      volume: typeof candidate.volume === 'number' && Number.isFinite(candidate.volume) ? candidate.volume : 0,
    });
  }

  return outputs;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
