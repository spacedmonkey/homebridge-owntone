import type { PlatformAccessory, PlatformConfig } from 'homebridge';

import { OwnTonePlatform, resolveServerConfigs, serverIdentity } from '../src/platform';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';
import type { OwnTonePlatformConfig } from '../src/types';
import { createAccessory, createMockApi, createMockLog, type MockApi, type MockLog } from './helpers/homebridgeMock';

const disposeSpy = jest.fn();

jest.mock('../src/platformAccessory', () => ({
  OwnTonePlatformAccessory: jest.fn().mockImplementation(() => ({ dispose: disposeSpy })),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { OwnTonePlatformAccessory } = require('../src/platformAccessory') as {
  OwnTonePlatformAccessory: jest.Mock;
};

function platformConfig(servers: unknown): PlatformConfig {
  return { platform: PLATFORM_NAME, name: 'OwnTone', servers } as unknown as PlatformConfig;
}

function launch(config: PlatformConfig): { platform: OwnTonePlatform; api: MockApi; log: MockLog } {
  const api = createMockApi();
  const log = createMockLog();
  const platform = new OwnTonePlatform(log, config, api);
  return { platform, api, log };
}

describe('resolveServerConfigs', () => {
  const log = createMockLog();

  beforeEach(() => jest.clearAllMocks());

  it('returns an empty list when no servers are configured', () => {
    expect(resolveServerConfigs({} as OwnTonePlatformConfig, log)).toEqual([]);
  });

  it('warns and returns an empty list when servers is not an array', () => {
    expect(resolveServerConfigs({ servers: 'nope' } as unknown as OwnTonePlatformConfig, log)).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });

  it('applies every documented default', () => {
    const [server] = resolveServerConfigs(
      { servers: [{ name: 'Living Room Music', host: '192.168.1.50' }] } as OwnTonePlatformConfig,
      log,
    );

    expect(server).toEqual({
      name: 'Living Room Music',
      protocol: 'http',
      host: '192.168.1.50',
      port: 3689,
      pollingInterval: 5,
      timeout: 5000,
      username: undefined,
      password: undefined,
      bearerToken: undefined,
      ignoreCertificateErrors: false,
      exposeTrackSwitches: false,
      enableMatter: false,
      enableWebSocket: true,
      pushReconnectInterval: 15,
      outputs: [],
    });
  });

  it('defaults enableWebSocket to true, and respects an explicit false', () => {
    const servers = resolveServerConfigs(
      {
        servers: [
          { name: 'A', host: 'a' },
          { name: 'B', host: 'b', enableWebSocket: true },
          { name: 'C', host: 'c', enableWebSocket: false },
        ],
      } as OwnTonePlatformConfig,
      log,
    );

    expect(servers.map((server) => server.enableWebSocket)).toEqual([true, true, false]);
  });

  it('defaults pushReconnectInterval to 15 minutes, uses a valid explicit value, and clamps out-of-range ones', () => {
    const servers = resolveServerConfigs(
      {
        servers: [
          { name: 'A', host: 'a' },
          { name: 'B', host: 'b', pushReconnectInterval: 30 },
          { name: 'C', host: 'c', pushReconnectInterval: 0 },
          { name: 'D', host: 'd', pushReconnectInterval: 5000 },
        ],
      } as OwnTonePlatformConfig,
      log,
    );

    expect(servers.map((server) => server.pushReconnectInterval)).toEqual([15, 30, 1, 1440]);
  });

  it('uses the default polling interval when it is omitted or unusable', () => {
    const servers = resolveServerConfigs(
      {
        servers: [
          { name: 'A', host: 'a' },
          { name: 'B', host: 'b', pollingInterval: undefined },
          { name: 'C', host: 'c', pollingInterval: 'abc' as unknown as number },
        ],
      } as OwnTonePlatformConfig,
      log,
    );

    expect(servers.map((server) => server.pollingInterval)).toEqual([5, 5, 5]);
  });

  it('keeps explicit values and clamps out-of-range ones', () => {
    const [server] = resolveServerConfigs(
      {
        servers: [
          {
            name: 'Office Music',
            protocol: 'https',
            host: 'owntone-office.local',
            port: 8443,
            pollingInterval: 0,
            timeout: 10,
            username: 'alice',
            password: 'pw',
            bearerToken: 'tok',
            ignoreCertificateErrors: true,
            exposeTrackSwitches: true,
          },
        ],
      } as OwnTonePlatformConfig,
      log,
    );

    expect(server).toMatchObject({
      protocol: 'https',
      port: 8443,
      pollingInterval: 1,
      timeout: 500,
      username: 'alice',
      bearerToken: 'tok',
      ignoreCertificateErrors: true,
      exposeTrackSwitches: true,
    });
  });

  it('falls back to http for an unknown protocol', () => {
    const [server] = resolveServerConfigs(
      { servers: [{ name: 'A', host: 'a', protocol: 'ftp' as unknown as 'http' }] } as OwnTonePlatformConfig,
      log,
    );

    expect(server.protocol).toBe('http');
    expect(log.warn).toHaveBeenCalled();
  });

  it('skips entries without a name or host but keeps the valid ones', () => {
    const servers = resolveServerConfigs(
      {
        servers: [
          { host: 'a' } as never,
          { name: 'No host' } as never,
          undefined as never,
          { name: 'Good', host: 'good.local' },
        ],
      } as OwnTonePlatformConfig,
      log,
    );

    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('Good');
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it('supports multiple servers', () => {
    const servers = resolveServerConfigs(
      {
        servers: [
          { name: 'Living Room Music', host: '192.168.1.50' },
          { name: 'Office Music', protocol: 'https', host: 'owntone-office.local' },
        ],
      } as OwnTonePlatformConfig,
      log,
    );

    expect(servers.map((server) => server.name)).toEqual(['Living Room Music', 'Office Music']);
  });

  it('carries over a valid cached outputs array', () => {
    const [server] = resolveServerConfigs(
      {
        servers: [
          {
            name: 'Living Room Music',
            host: '192.168.1.50',
            outputs: [
              { id: '123', name: 'Kitchen', type: 'AirPlay', selected: true, volume: 50 },
              { id: '456', name: 'Study', selected: false, volume: 0 },
            ],
          },
        ],
      } as OwnTonePlatformConfig,
      log,
    );

    expect(server.outputs).toEqual([
      { id: '123', name: 'Kitchen', type: 'AirPlay', selected: true, volume: 50 },
      { id: '456', name: 'Study', type: undefined, selected: false, volume: 0 },
    ]);
  });

  it('drops malformed cached output entries instead of throwing', () => {
    const [server] = resolveServerConfigs(
      {
        servers: [
          {
            name: 'Living Room Music',
            host: '192.168.1.50',
            outputs: [
              { id: '123', name: 'Kitchen', selected: true, volume: 50 },
              { name: 'Missing id' },
              { id: '789' },
              'not an object',
              null,
            ] as unknown as OwnTonePlatformConfig['servers'],
          },
        ],
      } as unknown as OwnTonePlatformConfig,
      log,
    );

    expect(server.outputs).toEqual([{ id: '123', name: 'Kitchen', type: undefined, selected: true, volume: 50 }]);
  });

  it('defaults outputs to an empty array when absent or not an array', () => {
    const servers = resolveServerConfigs(
      {
        servers: [
          { name: 'A', host: 'a' },
          { name: 'B', host: 'b', outputs: 'nope' as unknown as OwnTonePlatformConfig['servers'] },
        ],
      } as unknown as OwnTonePlatformConfig,
      log,
    );

    expect(servers.map((server) => server.outputs)).toEqual([[], []]);
  });
});

describe('serverIdentity', () => {
  it('is stable and case-insensitive for the host', () => {
    const a = serverIdentity({ name: 'Living Room', host: 'OwnTone.Local', port: 3689 });
    const b = serverIdentity({ name: 'Living Room', host: 'owntone.local', port: 3689 });
    expect(a).toBe(b);
  });

  it('differs when the port or name differs', () => {
    const base = serverIdentity({ name: 'A', host: 'h', port: 3689 });
    expect(serverIdentity({ name: 'A', host: 'h', port: 3690 })).not.toBe(base);
    expect(serverIdentity({ name: 'B', host: 'h', port: 3689 })).not.toBe(base);
  });
});

describe('OwnTonePlatform', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates exactly one accessory per configured server', () => {
    const { api } = launch(
      platformConfig([
        { name: 'Living Room Music', host: '192.168.1.50' },
        { name: 'Office Music', protocol: 'https', host: 'owntone-office.local' },
      ]),
    );

    api.emitEvent('didFinishLaunching');

    expect(OwnTonePlatformAccessory).toHaveBeenCalledTimes(2);
    expect(api.publishExternalAccessories).toHaveBeenCalledTimes(2);

    const names = api.publishExternalAccessories.mock.calls.map((call) => call[1][0].displayName);
    expect(names).toEqual(['Living Room Music', 'Office Music']);
    expect(api.publishExternalAccessories.mock.calls[0][0]).toBe(PLUGIN_NAME);
  });

  it('generates stable UUIDs across restarts', () => {
    const config = platformConfig([{ name: 'Living Room Music', host: '192.168.1.50' }]);

    const first = launch(config);
    first.api.emitEvent('didFinishLaunching');
    const second = launch(config);
    second.api.emitEvent('didFinishLaunching');

    const uuidOf = (api: MockApi) => api.publishExternalAccessories.mock.calls[0][1][0].UUID;
    expect(uuidOf(first.api)).toBe(uuidOf(second.api));
  });

  it('sets the television category and stores the resolved config on the accessory', () => {
    const { api } = launch(platformConfig([{ name: 'Living Room Music', host: '192.168.1.50' }]));
    api.emitEvent('didFinishLaunching');

    const accessory = api.publishExternalAccessories.mock.calls[0][1][0] as PlatformAccessory;
    expect(accessory.category).toBe(api.hap.Categories.TELEVISION);
    expect(accessory.context.server).toMatchObject({ host: '192.168.1.50', port: 3689 });
  });

  it('skips duplicate server entries', () => {
    const { api, log } = launch(
      platformConfig([
        { name: 'Living Room Music', host: '192.168.1.50' },
        { name: 'Living Room Music', host: '192.168.1.50' },
      ]),
    );

    api.emitEvent('didFinishLaunching');

    expect(api.publishExternalAccessories).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('duplicate'), expect.anything(), expect.anything(), expect.anything());
  });

  it('warns when nothing usable is configured', () => {
    const { api, log } = launch(platformConfig([]));
    api.emitEvent('didFinishLaunching');

    expect(api.publishExternalAccessories).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No usable OwnTone servers configured'));
  });

  it('removes stale cached accessories that are no longer configured', () => {
    const { platform, api } = launch(platformConfig([{ name: 'Living Room Music', host: '192.168.1.50' }]));

    const stale = createAccessory('Removed Server', 'homebridge-owntone:gone:3689:Removed Server');
    platform.configureAccessory(stale);

    api.emitEvent('didFinishLaunching');

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [stale]);
  });

  it('does not call unregisterPlatformAccessories when the cache is empty', () => {
    const { api } = launch(platformConfig([{ name: 'Living Room Music', host: '192.168.1.50' }]));
    api.emitEvent('didFinishLaunching');

    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  });

  it('disposes every accessory poller on shutdown', () => {
    const { api } = launch(
      platformConfig([
        { name: 'A', host: 'a' },
        { name: 'B', host: 'b' },
      ]),
    );

    api.emitEvent('didFinishLaunching');
    api.emitEvent('shutdown');

    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });

  it('logs instead of throwing when discovery fails', () => {
    const { api, log } = launch(platformConfig([{ name: 'A', host: 'a' }]));
    OwnTonePlatformAccessory.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    expect(() => api.emitEvent('didFinishLaunching')).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to set up'), 'boom');
  });
});
