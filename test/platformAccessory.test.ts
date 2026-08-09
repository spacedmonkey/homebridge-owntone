import type { PlatformAccessory, Service } from 'homebridge';

import type { OwnToneClient } from '../src/owntoneClient';
import { UnsupportedFeatureError } from '../src/owntoneClient';
import type { OwnTonePushClient, OwnTonePushClientOptions } from '../src/owntonePushClient';
import type { OwnTonePlatform } from '../src/platform';
import { OwnTonePlatformAccessory, sanitizeHapName } from '../src/platformAccessory';
import { serverIdentity } from '../src/platform';
import { DEFAULT_POLLING_INTERVAL, WEBSOCKET_RECONCILE_INTERVAL_MS } from '../src/settings';
import type { OutputSnapshot, PlayerSnapshot, ResolvedServerConfig, TrackSnapshot } from '../src/types';
import {
  Characteristic,
  Service as HapService,
  createAccessory,
  createMockApi,
  createMockLog,
  uuid,
  type MockLog,
} from './helpers/homebridgeMock';

const POLL_MS = DEFAULT_POLLING_INTERVAL * 1000;

function serverConfig(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return {
    name: 'Living Room Music',
    protocol: 'http',
    host: '192.168.1.50',
    port: 3689,
    pollingInterval: DEFAULT_POLLING_INTERVAL,
    timeout: 5000,
    ignoreCertificateErrors: false,
    exposeTrackSwitches: false,
    enableWebSocket: true,
    outputs: [],
    ...overrides,
  };
}

function playing(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    state: 'play',
    volume: 40,
    repeat: 'off',
    shuffle: false,
    consume: false,
    itemId: 12122,
    progressMs: 1000,
    lengthMs: 171735,
    ...overrides,
  };
}

function track(overrides: Partial<TrackSnapshot> = {}): TrackSnapshot {
  return {
    itemId: 12122,
    trackId: 10749,
    title: 'Angels',
    artist: 'The xx',
    album: 'Coexist',
    artworkUrl: '/artwork/item/12122',
    durationMs: 171735,
    ...overrides,
  };
}

function outputs(): OutputSnapshot[] {
  return [
    { id: '123', name: 'Kitchen', type: 'AirPlay', selected: true, volume: 50 },
    { id: '456', name: 'Study', type: 'AirPlay', selected: false, volume: 20 },
  ];
}

type FakeClient = jest.Mocked<
  Pick<
    OwnToneClient,
    | 'getConfig'
    | 'getStatus'
    | 'getNowPlaying'
    | 'getOutputs'
    | 'play'
    | 'pause'
    | 'stop'
    | 'toggle'
    | 'next'
    | 'previous'
    | 'seekRelative'
    | 'setVolume'
    | 'volumeUp'
    | 'volumeDown'
    | 'setMute'
    | 'selectOutputsExclusively'
    | 'updateOutput'
    | 'resolveArtworkUrl'
    | 'fetchArtwork'
  >
> & { baseUrl: string; description: string; muteIsEmulated: boolean };

function createFakeClient(): FakeClient {
  return {
    baseUrl: 'http://192.168.1.50:3689',
    description: 'http://192.168.1.50:3689',
    muteIsEmulated: true,
    getConfig: jest.fn().mockResolvedValue({ version: '28.4' }),
    getStatus: jest.fn().mockResolvedValue(playing()),
    getNowPlaying: jest.fn().mockResolvedValue(track()),
    getOutputs: jest.fn().mockResolvedValue(outputs()),
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    toggle: jest.fn().mockResolvedValue(undefined),
    next: jest.fn().mockResolvedValue(undefined),
    previous: jest.fn().mockResolvedValue(undefined),
    seekRelative: jest.fn().mockResolvedValue(undefined),
    setVolume: jest.fn().mockResolvedValue(undefined),
    volumeUp: jest.fn().mockResolvedValue(undefined),
    volumeDown: jest.fn().mockResolvedValue(undefined),
    setMute: jest.fn().mockResolvedValue(undefined),
    selectOutputsExclusively: jest.fn().mockResolvedValue(undefined),
    updateOutput: jest.fn().mockResolvedValue(undefined),
    resolveArtworkUrl: jest.fn((url?: string) => (url ? `http://192.168.1.50:3689${url}` : undefined)),
    fetchArtwork: jest.fn().mockResolvedValue({ contentType: 'image/png', byteLength: 4096 }),
  } as unknown as FakeClient;
}

interface Harness {
  handler: OwnTonePlatformAccessory;
  accessory: PlatformAccessory;
  client: FakeClient;
  log: MockLog;
  television: Service;
  speaker: Service;
}

interface FakePushClientInstance {
  options: OwnTonePushClientOptions;
  connect: jest.Mock;
  dispose: jest.Mock;
}

/**
 * Stub push-client factory: records the options each "connection" was
 * created with and lets tests drive `onEvent`/`onConnectionChange`
 * manually, without opening a real socket. `OwnTonePushClient` itself is
 * unit-tested separately in owntonePushClient.test.ts — this is purely
 * about the integration seam in platformAccessory.ts.
 */
function createFakePushClientFactory(): {
  factory: (options: OwnTonePushClientOptions) => OwnTonePushClient;
  instances: FakePushClientInstance[];
} {
  const instances: FakePushClientInstance[] = [];
  const factory = (options: OwnTonePushClientOptions): OwnTonePushClient => {
    const instance: FakePushClientInstance = { options, connect: jest.fn(), dispose: jest.fn() };
    instances.push(instance);
    return instance as unknown as OwnTonePushClient;
  };
  return { factory, instances };
}

async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

async function build(
  config: Partial<ResolvedServerConfig> = {},
  client = createFakeClient(),
  pushClientFactory?: (options: OwnTonePushClientOptions) => OwnTonePushClient,
): Promise<Harness> {
  const resolved = serverConfig(config);
  const api = createMockApi();
  const log = createMockLog();
  const platform = {
    Service: HapService,
    Characteristic,
    api,
    log,
  } as unknown as OwnTonePlatform;

  const accessory = createAccessory(resolved.name, serverIdentity(resolved));
  const handler = new OwnTonePlatformAccessory(
    platform,
    accessory,
    resolved,
    client as unknown as OwnToneClient,
    pushClientFactory,
  );
  await flush();

  return {
    handler,
    accessory,
    client,
    log,
    television: accessory.getService(HapService.Television) as Service,
    speaker: accessory.getServiceById(HapService.TelevisionSpeaker, 'owntone-speaker') as Service,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('sanitizeHapName', () => {
  it('leaves an already-valid name untouched', () => {
    expect(sanitizeHapName('Living Room')).toBe('Living Room');
  });

  it('strips parentheses added around an output type', () => {
    expect(sanitizeHapName('Kitchen ATV (AirPlay 2)')).toBe('Kitchen ATV AirPlay 2');
  });

  it('strips characters HomeKit rejects, such as an inch mark', () => {
    expect(sanitizeHapName('55" The Frame (Chromecast)')).toBe('55 The Frame Chromecast');
  });

  it('trims leading/trailing punctuation left over after stripping', () => {
    expect(sanitizeHapName('(dummy)')).toBe('dummy');
  });

  it('falls back to a placeholder when nothing valid remains', () => {
    expect(sanitizeHapName('🎵🎶')).toBe('Output');
  });
});

describe('OwnTonePlatformAccessory — services', () => {
  it('exposes the accessory information expected by HomeKit', async () => {
    const { accessory, handler } = await build();
    const information = accessory.getService(HapService.AccessoryInformation) as Service;

    expect(information.getCharacteristic(Characteristic.Manufacturer).value).toBe('OwnTone');
    expect(information.getCharacteristic(Characteristic.Model).value).toBe('OwnTone Server');
    expect(information.getCharacteristic(Characteristic.Name).value).toBe('Living Room Music');
    expect(information.getCharacteristic(Characteristic.SerialNumber).value).toBe(uuid.generate(serverIdentity(serverConfig())));

    handler.dispose();
  });

  it('reports the OwnTone version as the firmware revision', async () => {
    const { accessory, handler } = await build();
    const information = accessory.getService(HapService.AccessoryInformation) as Service;

    expect(information.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('28.4');
    handler.dispose();
  });

  it('leaves the firmware revision at "unknown" when /api/config fails', async () => {
    const client = createFakeClient();
    client.getConfig.mockRejectedValue(new Error('nope'));

    const { accessory, handler } = await build({}, client);
    const information = accessory.getService(HapService.AccessoryInformation) as Service;

    expect(information.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('unknown');
    handler.dispose();
  });

  it('creates a Television service with a configured name and a linked speaker', async () => {
    const { television, speaker, handler } = await build();

    expect(television).toBeDefined();
    expect(television.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Living Room Music');
    expect(television.getCharacteristic(Characteristic.SleepDiscoveryMode).value).toBe(
      Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
    );
    expect(speaker).toBeDefined();
    expect(television.linkedServices).toContain(speaker);

    handler.dispose();
  });

  it('advertises absolute volume control when the HAP version supports it', async () => {
    const { speaker, handler } = await build();

    expect(speaker.getCharacteristic(Characteristic.VolumeControlType).value).toBe(Characteristic.VolumeControlType.ABSOLUTE);
    handler.dispose();
  });

  it('seeds input sources from the config outputs cache before the first poll resolves', async () => {
    const resolved = serverConfig({
      outputs: [{ id: '789', name: 'Garage', type: 'AirPlay', selected: false, volume: 0 }],
    });
    const api = createMockApi();
    const log = createMockLog();
    const platform = { Service: HapService, Characteristic, api, log } as unknown as OwnTonePlatform;
    const accessory = createAccessory(resolved.name, serverIdentity(resolved));
    const client = createFakeClient();

    const handler = new OwnTonePlatformAccessory(platform, accessory, resolved, client as unknown as OwnToneClient);

    // No await/flush yet — the seeded input must exist synchronously, from
    // the config cache, not from the (still-pending) first live poll.
    const inputs = accessory.services.filter((service) => service.UUID === HapService.InputSource.UUID);
    expect(inputs.map((service) => service.getCharacteristic(Characteristic.ConfiguredName).value)).toEqual([
      'OwnTone',
      'Garage AirPlay',
    ]);

    await flush();
    handler.dispose();
  });

  it('always exposes a default input source and adds one per OwnTone output', async () => {
    const { accessory, handler } = await build();

    const inputs = accessory.services.filter((service) => service.UUID === HapService.InputSource.UUID);
    expect(inputs).toHaveLength(3);
    expect(inputs.map((service) => service.getCharacteristic(Characteristic.ConfiguredName).value)).toEqual([
      'OwnTone',
      'Kitchen AirPlay',
      'Study AirPlay',
    ]);

    handler.dispose();
  });

  it('tracks the selected output as the active identifier', async () => {
    const { television, handler } = await build();

    // Kitchen is the only selected output, and it is the first one → id 2.
    expect(television.getCharacteristic(Characteristic.ActiveIdentifier).value).toBe(2);
    handler.dispose();
  });

  it('falls back to the generic input when several outputs are enabled', async () => {
    const client = createFakeClient();
    client.getOutputs.mockResolvedValue([
      { id: '123', name: 'Kitchen', selected: true, volume: 50 },
      { id: '456', name: 'Study', selected: true, volume: 20 },
    ]);

    const { television, handler } = await build({}, client);

    expect(television.getCharacteristic(Characteristic.ActiveIdentifier).value).toBe(1);
    handler.dispose();
  });

  it('does not create track switches by default', async () => {
    const { accessory, handler } = await build();

    expect(accessory.getServiceById(HapService.Switch, 'owntone-next')).toBeUndefined();
    handler.dispose();
  });

  it('creates track switches when exposeTrackSwitches is enabled', async () => {
    const { accessory, handler } = await build({ exposeTrackSwitches: true });

    expect(accessory.getServiceById(HapService.Switch, 'owntone-next')).toBeDefined();
    expect(accessory.getServiceById(HapService.Switch, 'owntone-previous')).toBeDefined();
    expect(accessory.getServiceById(HapService.Switch, 'owntone-playpause')).toBeDefined();
    handler.dispose();
  });

  it('does not create a Refresh Outputs switch (outputs refresh automatically every poll)', async () => {
    const { accessory, handler } = await build();

    expect(accessory.getServiceById(HapService.Switch, 'owntone-refresh-outputs')).toBeUndefined();
    handler.dispose();
  });
});

describe('OwnTonePlatformAccessory — state mapping', () => {
  it('is active while OwnTone is playing', async () => {
    const { television, handler } = await build();

    expect(television.getCharacteristic(Characteristic.Active).value).toBe(Characteristic.Active.ACTIVE);
    handler.dispose();
  });

  it('is inactive while OwnTone is paused', async () => {
    const client = createFakeClient();
    client.getStatus.mockResolvedValue(playing({ state: 'pause' }));

    const { television, handler } = await build({}, client);

    expect(television.getCharacteristic(Characteristic.Active).value).toBe(Characteristic.Active.INACTIVE);
    handler.dispose();
  });

  it('mirrors the OwnTone volume onto the speaker service', async () => {
    const { speaker, handler } = await build();

    expect(speaker.getCharacteristic(Characteristic.Volume).value).toBe(40);
    expect(speaker.getCharacteristic(Characteristic.Mute).value).toBe(false);
    handler.dispose();
  });

  it('updates the speaker volume on later polls when it changes on the server', async () => {
    const client = createFakeClient();
    const { speaker, handler } = await build({}, client);

    expect(speaker.getCharacteristic(Characteristic.Volume).value).toBe(40);

    client.getStatus.mockResolvedValue(playing({ volume: 75 }));
    await jest.advanceTimersByTimeAsync(POLL_MS);

    expect(speaker.getCharacteristic(Characteristic.Volume).value).toBe(75);
    expect(speaker.getCharacteristic(Characteristic.Mute).value).toBe(false);

    handler.dispose();
  });

  it('reports mute when the OwnTone volume is zero', async () => {
    const client = createFakeClient();
    client.getStatus.mockResolvedValue(playing({ volume: 0 }));

    const { speaker, handler } = await build({}, client);

    expect(speaker.getCharacteristic(Characteristic.Mute).value).toBe(true);
    handler.dispose();
  });
});

describe('OwnTonePlatformAccessory — commands', () => {
  it('plays and pauses through the Active characteristic', async () => {
    const { television, client, handler } = await build();

    await television.getCharacteristic(Characteristic.Active).handleSetRequest(Characteristic.Active.ACTIVE);
    expect(client.play).toHaveBeenCalled();

    await television.getCharacteristic(Characteristic.Active).handleSetRequest(Characteristic.Active.INACTIVE);
    expect(client.pause).toHaveBeenCalled();

    handler.dispose();
  });

  it.each([
    ['PLAY_PAUSE', 'toggle'],
    ['SELECT', 'toggle'],
    ['ARROW_RIGHT', 'next'],
    ['NEXT_TRACK', 'next'],
    ['ARROW_LEFT', 'previous'],
    ['PREVIOUS_TRACK', 'previous'],
  ] as const)('maps the %s remote key to %s()', async (key, method) => {
    const { television, client, handler } = await build();

    const value = (Characteristic.RemoteKey as unknown as Record<string, number>)[key];
    await television.getCharacteristic(Characteristic.RemoteKey).handleSetRequest(value);

    expect(client[method as 'toggle' | 'next' | 'previous']).toHaveBeenCalled();
    handler.dispose();
  });

  it('maps fast-forward and rewind to relative seeks', async () => {
    const { television, client, handler } = await build();

    await television.getCharacteristic(Characteristic.RemoteKey).handleSetRequest(Characteristic.RemoteKey.FAST_FORWARD);
    expect(client.seekRelative).toHaveBeenCalledWith(10000);

    await television.getCharacteristic(Characteristic.RemoteKey).handleSetRequest(Characteristic.RemoteKey.REWIND);
    expect(client.seekRelative).toHaveBeenCalledWith(-10000);

    handler.dispose();
  });

  it('ignores remote keys without an OwnTone equivalent', async () => {
    const { television, client, handler } = await build();

    await television.getCharacteristic(Characteristic.RemoteKey).handleSetRequest(Characteristic.RemoteKey.BACK);

    expect(client.toggle).not.toHaveBeenCalled();
    expect(client.next).not.toHaveBeenCalled();
    handler.dispose();
  });

  it('changes the volume through the volume selector', async () => {
    const { speaker, client, handler } = await build();

    await speaker.getCharacteristic(Characteristic.VolumeSelector).handleSetRequest(Characteristic.VolumeSelector.INCREMENT);
    expect(client.volumeUp).toHaveBeenCalled();

    await speaker.getCharacteristic(Characteristic.VolumeSelector).handleSetRequest(Characteristic.VolumeSelector.DECREMENT);
    expect(client.volumeDown).toHaveBeenCalled();

    handler.dispose();
  });

  it('sets an absolute volume', async () => {
    const { speaker, client, handler } = await build();

    await speaker.getCharacteristic(Characteristic.Volume).handleSetRequest(73);

    expect(client.setVolume).toHaveBeenCalledWith(73);
    handler.dispose();
  });

  it('mutes and unmutes', async () => {
    const { speaker, client, handler } = await build();

    await speaker.getCharacteristic(Characteristic.Mute).handleSetRequest(true);
    expect(client.setMute).toHaveBeenCalledWith(true);

    await speaker.getCharacteristic(Characteristic.Mute).handleSetRequest(false);
    expect(client.setMute).toHaveBeenCalledWith(false);

    handler.dispose();
  });

  it('selects an OwnTone output exclusively when the input changes', async () => {
    const { television, client, handler } = await build();

    await television.getCharacteristic(Characteristic.ActiveIdentifier).handleSetRequest(3);

    expect(client.selectOutputsExclusively).toHaveBeenCalledWith(['456']);
    handler.dispose();
  });

  it('treats the generic input as a no-op', async () => {
    const { television, client, handler } = await build();

    await television.getCharacteristic(Characteristic.ActiveIdentifier).handleSetRequest(1);

    expect(client.selectOutputsExclusively).not.toHaveBeenCalled();
    handler.dispose();
  });

  it('surfaces a HomeKit error when a command fails, and logs it', async () => {
    const client = createFakeClient();
    client.toggle.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const { television, log, handler } = await build({}, client);

    await expect(
      television.getCharacteristic(Characteristic.RemoteKey).handleSetRequest(Characteristic.RemoteKey.PLAY_PAUSE),
    ).rejects.toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('failed'), 'Living Room Music', 'toggle play/pause', 'connect ECONNREFUSED');

    handler.dispose();
  });

  it('logs unsupported features distinctly', async () => {
    const client = createFakeClient();
    client.next.mockRejectedValue(new UnsupportedFeatureError('PUT /api/player/next is not supported'));

    const { television, log, handler } = await build({}, client);

    await expect(
      television.getCharacteristic(Characteristic.RemoteKey).handleSetRequest(Characteristic.RemoteKey.ARROW_RIGHT),
    ).rejects.toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('not supported'),
      'Living Room Music',
      'next track',
      expect.stringContaining('/api/player/next'),
    );

    handler.dispose();
  });
});

describe('OwnTonePlatformAccessory — track switches', () => {
  it('runs the command and resets itself to off', async () => {
    const { accessory, client, handler } = await build({ exposeTrackSwitches: true });
    const nextSwitch = accessory.getServiceById(HapService.Switch, 'owntone-next') as Service;

    await nextSwitch.getCharacteristic(Characteristic.On).handleSetRequest(true);
    expect(client.next).toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(600);
    expect(nextSwitch.getCharacteristic(Characteristic.On).value).toBe(false);

    handler.dispose();
  });

  it('does nothing when the switch is turned off', async () => {
    const { accessory, client, handler } = await build({ exposeTrackSwitches: true });
    const nextSwitch = accessory.getServiceById(HapService.Switch, 'owntone-next') as Service;

    await nextSwitch.getCharacteristic(Characteristic.On).handleSetRequest(false);

    expect(client.next).not.toHaveBeenCalled();
    handler.dispose();
  });

  it('does not reject when the underlying command fails', async () => {
    const client = createFakeClient();
    client.previous.mockRejectedValue(new Error('boom'));

    const { accessory, log, handler } = await build({ exposeTrackSwitches: true }, client);
    const previousSwitch = accessory.getServiceById(HapService.Switch, 'owntone-previous') as Service;

    await expect(previousSwitch.getCharacteristic(Characteristic.On).handleSetRequest(true)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();

    handler.dispose();
  });
});

describe('OwnTonePlatformAccessory — polling', () => {
  it('polls immediately and then on the configured interval', async () => {
    const { client, handler } = await build();

    expect(client.getStatus).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(client.getStatus).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(client.getStatus).toHaveBeenCalledTimes(3);

    handler.dispose();
  });

  it('logs the track information after every poll completes, not just on change', async () => {
    const client = createFakeClient();
    const { log, handler } = await build({}, client);

    expect(log.info).toHaveBeenCalledWith(
      '"%s": poll complete — %s',
      'Living Room Music',
      expect.stringContaining('now playing "Angels" by "The xx"'),
    );

    log.info.mockClear();
    client.getNowPlaying.mockResolvedValue(track({ title: 'Angels', artist: 'The xx' }));
    await jest.advanceTimersByTimeAsync(POLL_MS);

    // Same track again — logTrackChange wouldn't log this, but the
    // poll-complete summary should still fire every cycle.
    expect(log.info).toHaveBeenCalledWith(
      '"%s": poll complete — %s',
      'Living Room Music',
      expect.stringContaining('now playing "Angels" by "The xx"'),
    );

    handler.dispose();
  });

  it('skips fetching now-playing and outputs while stopped', async () => {
    const client = createFakeClient();
    client.getStatus.mockResolvedValue(playing({ state: 'stop' }));

    const { handler } = await build({}, client);

    expect(client.getNowPlaying).not.toHaveBeenCalled();
    expect(client.getOutputs).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(POLL_MS);
    await jest.advanceTimersByTimeAsync(POLL_MS);

    expect(client.getNowPlaying).not.toHaveBeenCalled();
    expect(client.getOutputs).not.toHaveBeenCalled();

    handler.dispose();
  });

  it('resumes fetching now-playing and outputs once playback starts', async () => {
    const client = createFakeClient();
    client.getStatus.mockResolvedValue(playing({ state: 'stop' }));

    const { handler } = await build({}, client);

    client.getStatus.mockResolvedValue(playing({ state: 'play' }));
    await jest.advanceTimersByTimeAsync(POLL_MS);

    expect(client.getNowPlaying).toHaveBeenCalledTimes(1);
    expect(client.getOutputs).toHaveBeenCalledTimes(1);

    handler.dispose();
  });

  it('does not start a second poll while one is still running', async () => {
    const client = createFakeClient();
    let release: (() => void) | undefined;
    client.getStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(playing());
        }),
    );

    const { handler } = await build({}, client);
    expect(client.getStatus).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(POLL_MS);
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(client.getStatus).toHaveBeenCalledTimes(1);

    release?.();
    await flush();
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(client.getStatus).toHaveBeenCalledTimes(2);

    handler.dispose();
  });

  it('fetches outputs on every poll, same cadence as player/track state', async () => {
    const { client, handler } = await build();

    expect(client.getOutputs).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 50; i++) {
      await jest.advanceTimersByTimeAsync(POLL_MS);
    }
    expect(client.getOutputs).toHaveBeenCalledTimes(51);

    handler.dispose();
  });

  it('recovers on the next poll after an outputs fetch failure', async () => {
    const client = createFakeClient();
    client.getOutputs.mockRejectedValueOnce(new Error('bad gateway'));

    const { handler } = await build({}, client);
    expect(client.getOutputs).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(client.getOutputs).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(client.getOutputs).toHaveBeenCalledTimes(3);

    handler.dispose();
  });

  it('updates the active identifier when the selected output changes between polls', async () => {
    const client = createFakeClient();
    client.getOutputs.mockResolvedValue(outputs());

    const { television, handler } = await build({}, client);

    // Kitchen (index 0 → identifier 2) is selected initially.
    expect(television.getCharacteristic(Characteristic.ActiveIdentifier).value).toBe(2);

    client.getOutputs.mockResolvedValue([
      { id: '123', name: 'Kitchen', type: 'AirPlay', selected: false, volume: 50 },
      { id: '456', name: 'Study', type: 'AirPlay', selected: true, volume: 20 },
    ]);
    await jest.advanceTimersByTimeAsync(POLL_MS);

    // Study (index 1 → identifier 3) is now selected.
    expect(television.getCharacteristic(Characteristic.ActiveIdentifier).value).toBe(3);

    handler.dispose();
  });

  it('keeps working when now-playing metadata cannot be read', async () => {
    const client = createFakeClient();
    client.getNowPlaying.mockRejectedValue(new Error('bad gateway'));

    const { television, handler } = await build({}, client);

    expect(television.getCharacteristic(Characteristic.Active).value).toBe(Characteristic.Active.ACTIVE);
    handler.dispose();
  });

  it('keeps working when outputs cannot be read', async () => {
    const client = createFakeClient();
    client.getOutputs.mockRejectedValue(new Error('bad gateway'));

    const { television, accessory, handler } = await build({}, client);

    expect(television.getCharacteristic(Characteristic.Active).value).toBe(Characteristic.Active.ACTIVE);
    expect(accessory.services.filter((service) => service.UUID === HapService.InputSource.UUID)).toHaveLength(1);
    handler.dispose();
  });
});

describe('OwnTonePlatformAccessory — push notifications', () => {
  it('connects the push client when the server advertises a websocket port', async () => {
    const client = createFakeClient();
    client.getConfig.mockResolvedValue({ version: '28.4', websocket_port: 3688 });
    const { factory, instances } = createFakePushClientFactory();

    const { handler } = await build({}, client, factory);
    await flush();

    expect(instances).toHaveLength(1);
    expect(instances[0].options).toMatchObject({
      protocol: 'ws',
      host: '192.168.1.50',
      port: 3688,
      categories: ['player', 'volume', 'outputs', 'queue', 'options'],
    });
    expect(instances[0].connect).toHaveBeenCalledTimes(1);

    handler.dispose();
  });

  it('maps an https server to a wss push connection', async () => {
    const client = createFakeClient();
    client.getConfig.mockResolvedValue({ version: '28.4', websocket_port: 3688 });
    const { factory, instances } = createFakePushClientFactory();

    const { handler } = await build({ protocol: 'https' }, client, factory);
    await flush();

    expect(instances[0].options.protocol).toBe('wss');

    handler.dispose();
  });

  it('does not connect a push client when the server has no websocket port', async () => {
    const client = createFakeClient();
    const { factory, instances } = createFakePushClientFactory();

    const { handler } = await build({}, client, factory);
    await flush();

    expect(instances).toHaveLength(0);

    handler.dispose();
  });

  it('does not connect a push client when enableWebSocket is disabled, even if the server advertises one', async () => {
    const client = createFakeClient();
    client.getConfig.mockResolvedValue({ version: '28.4', websocket_port: 3688 });
    const { factory, instances } = createFakePushClientFactory();

    const { handler } = await build({ enableWebSocket: false }, client, factory);
    await flush();

    expect(instances).toHaveLength(0);

    handler.dispose();
  });

  it('triggers an immediate poll when the push client reports an event', async () => {
    const client = createFakeClient();
    client.getConfig.mockResolvedValue({ version: '28.4', websocket_port: 3688 });
    const { factory, instances } = createFakePushClientFactory();

    const { handler } = await build({}, client, factory);
    await flush();
    expect(client.getStatus).toHaveBeenCalledTimes(1);

    instances[0].options.onEvent();
    await flush();

    expect(client.getStatus).toHaveBeenCalledTimes(2);

    handler.dispose();
  });

  it('polls at the reconciliation interval while the push connection is healthy, and reverts immediately when it drops', async () => {
    const client = createFakeClient();
    client.getConfig.mockResolvedValue({ version: '28.4', websocket_port: 3688 });
    const { factory, instances } = createFakePushClientFactory();

    const { handler } = await build({}, client, factory);
    await flush();
    expect(client.getStatus).toHaveBeenCalledTimes(1);

    instances[0].options.onConnectionChange(true);

    // Well under the reconciliation interval — no extra poll yet, even
    // though several multiples of the old fast interval have passed.
    await jest.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(client.getStatus).toHaveBeenCalledTimes(1);

    // The reconciliation interval elapses — one more poll.
    await jest.advanceTimersByTimeAsync(WEBSOCKET_RECONCILE_INTERVAL_MS - POLL_MS * 3);
    expect(client.getStatus).toHaveBeenCalledTimes(2);

    // Connection drops — fast polling resumes immediately.
    instances[0].options.onConnectionChange(false);
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(client.getStatus).toHaveBeenCalledTimes(3);

    handler.dispose();
  });

  it('disposes the push client when the accessory is disposed', async () => {
    const client = createFakeClient();
    client.getConfig.mockResolvedValue({ version: '28.4', websocket_port: 3688 });
    const { factory, instances } = createFakePushClientFactory();

    const { handler } = await build({}, client, factory);
    await flush();

    handler.dispose();

    expect(instances[0].dispose).toHaveBeenCalledTimes(1);
  });
});

describe('OwnTonePlatformAccessory — availability', () => {
  it('marks the accessory inactive after three consecutive failures and recovers afterwards', async () => {
    const client = createFakeClient();
    const { television, log, handler } = await build({}, client);

    expect(handler.isReachable).toBe(true);
    expect(television.getCharacteristic(Characteristic.Active).value).toBe(Characteristic.Active.ACTIVE);

    client.getStatus.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(handler.isReachable).toBe(true);
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(handler.isReachable).toBe(true);
    await jest.advanceTimersByTimeAsync(POLL_MS);

    expect(handler.isReachable).toBe(false);
    expect(television.getCharacteristic(Characteristic.Active).value).toBe(Characteristic.Active.INACTIVE);

    client.getStatus.mockResolvedValue(playing());
    await jest.advanceTimersByTimeAsync(POLL_MS);

    expect(handler.isReachable).toBe(true);
    expect(television.getCharacteristic(Characteristic.Active).value).toBe(Characteristic.Active.ACTIVE);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('is reachable'), 'Living Room Music', 'http://192.168.1.50:3689');

    handler.dispose();
  });

  it('throttles the unreachable warning instead of logging on every poll', async () => {
    const client = createFakeClient();
    client.getStatus.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const { log, handler } = await build({}, client);

    const unreachableWarnings = () =>
      log.warn.mock.calls.filter((call) => typeof call[0] === 'string' && call[0].includes('is unreachable')).length;

    expect(unreachableWarnings()).toBe(1);

    for (let i = 0; i < 5; i++) {
      await jest.advanceTimersByTimeAsync(POLL_MS);
    }

    expect(unreachableWarnings()).toBe(1);
    handler.dispose();
  });

  it('never rejects out of the poll loop', async () => {
    const client = createFakeClient();
    client.getStatus.mockRejectedValue(new Error('kaboom'));
    client.getConfig.mockRejectedValue(new Error('kaboom'));

    const { handler } = await build({}, client);
    await expect(jest.advanceTimersByTimeAsync(POLL_MS * 3)).resolves.toBeUndefined();

    handler.dispose();
  });
});

describe('OwnTonePlatformAccessory — artwork', () => {
  it('caches artwork metadata for the current track', async () => {
    const { handler } = await build();

    expect(handler.currentArtwork).toEqual({
      url: 'http://192.168.1.50:3689/artwork/item/12122',
      contentType: 'image/png',
      byteLength: 4096,
    });

    handler.dispose();
  });

  it('does not re-download artwork while the track is unchanged', async () => {
    const { client, handler } = await build();

    expect(client.fetchArtwork).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(POLL_MS);
    await jest.advanceTimersByTimeAsync(POLL_MS);

    expect(client.fetchArtwork).toHaveBeenCalledTimes(1);
    handler.dispose();
  });

  it('re-downloads artwork when the track changes', async () => {
    const { client, handler } = await build();

    client.getNowPlaying.mockResolvedValue(track({ itemId: 999, title: 'Sunset', artworkUrl: '/artwork/item/999' }));
    await jest.advanceTimersByTimeAsync(POLL_MS);

    expect(client.fetchArtwork).toHaveBeenCalledTimes(2);
    expect(handler.currentArtwork?.url).toBe('http://192.168.1.50:3689/artwork/item/999');
    handler.dispose();
  });

  it('clears artwork when the track has none', async () => {
    const client = createFakeClient();
    client.getNowPlaying.mockResolvedValue(track({ artworkUrl: undefined }));

    const { handler } = await build({}, client);

    expect(handler.currentArtwork).toBeUndefined();
    expect(client.fetchArtwork).not.toHaveBeenCalled();
    handler.dispose();
  });

  it('survives an artwork download failure', async () => {
    const client = createFakeClient();
    client.fetchArtwork.mockRejectedValue(new Error('404 Not Found'));

    const { handler } = await build({}, client);

    expect(handler.currentArtwork).toBeUndefined();
    handler.dispose();
  });
});

describe('OwnTonePlatformAccessory — dispose', () => {
  it('stops polling', async () => {
    const { client, handler } = await build();
    const callsAtDispose = client.getStatus.mock.calls.length;

    handler.dispose();
    await jest.advanceTimersByTimeAsync(POLL_MS * 4);

    expect(client.getStatus).toHaveBeenCalledTimes(callsAtDispose);
  });
});
