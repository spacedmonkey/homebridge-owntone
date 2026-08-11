import { MatterAccessoryBridge, type MatterAccessoryBridgeDeps } from '../src/matterAccessoryBridge';
import type { MatterAccessoryDefinition, MatterAccessoryPart, MatterAPI, MatterBridgeStatus } from '../src/matterTypes';
import { serverIdentity } from '../src/platform';
import type { OwnTonePlatform } from '../src/platform';
import { createMockLog, type MockLog } from './helpers/homebridgeMock';

const IDENTITY = serverIdentity({ name: 'Living Room Music', host: '192.168.1.50', port: 3689 });

function createMatterApi(status?: MatterBridgeStatus): {
  matter: MatterAPI;
  registered: MatterAccessoryDefinition[];
  registerPlatformAccessories: jest.Mock;
  unregisterPlatformAccessories: jest.Mock;
  updateAccessoryState: jest.Mock;
} {
  const registered: MatterAccessoryDefinition[] = [];
  const registerPlatformAccessories = jest.fn(async (_plugin: string, _platformName: string, accessories: MatterAccessoryDefinition[]) => {
    registered.push(...accessories);
  });
  const unregisterPlatformAccessories = jest.fn().mockResolvedValue(undefined);
  const updateAccessoryState = jest.fn().mockResolvedValue(undefined);
  const getAccessoryState = jest.fn().mockResolvedValue({ onOff: false });

  const matter: MatterAPI = {
    uuid: { generate: (data: string) => `matter-uuid:${data}` },
    deviceTypes: { OnOffSwitch: 'OnOffSwitch' },
    clusterNames: { OnOff: 'onOff' },
    status,
    registerPlatformAccessories,
    unregisterPlatformAccessories,
    updateAccessoryState,
    getAccessoryState,
  };

  return { matter, registered, registerPlatformAccessories, unregisterPlatformAccessories, updateAccessoryState };
}

function legacyUuid(subtype: string): string {
  return `matter-uuid:${IDENTITY}:matter:${subtype}`;
}

function composedUuid(): string {
  return `matter-uuid:${IDENTITY}:matter:controls`;
}

function part(registered: MatterAccessoryDefinition[], id: string): MatterAccessoryPart {
  const found = registered[0]?.parts?.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`No registered Matter part "${id}"; got: ${registered[0]?.parts?.map((p) => p.id).join(', ')}`);
  }
  return found;
}

function createDeps(
  matter: MatterAPI | undefined,
  log: MockLog,
  configOverrides: Partial<MatterAccessoryBridgeDeps['config']> = {},
): MatterAccessoryBridgeDeps {
  const platform = { log, api: { matter } } as unknown as OwnTonePlatform;

  return {
    platform,
    config: {
      name: 'Living Room Music',
      host: '192.168.1.50',
      port: 3689,
      enableMatter: true,
      exposeTrackSwitches: true,
      ...configOverrides,
    } as MatterAccessoryBridgeDeps['config'],
    client: {
      play: jest.fn().mockResolvedValue(undefined),
      pause: jest.fn().mockResolvedValue(undefined),
      next: jest.fn().mockResolvedValue(undefined),
      previous: jest.fn().mockResolvedValue(undefined),
    } as unknown as MatterAccessoryBridgeDeps['client'],
    serialNumber: () => 'serial-123',
    runCommand: jest.fn((_label: string, action: () => Promise<void>) => action().then(() => true)),
    poll: jest.fn().mockResolvedValue(undefined),
    handleMuteSet: jest.fn().mockResolvedValue(undefined),
    scheduleMomentaryReset: (reset) => reset(),
  };
}

/** Lets already-scheduled microtasks (e.g. an unawaited `.catch()`) run before assertions. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('MatterAccessoryBridge — registration', () => {
  it('registers a single composed accessory with Mute, Play/Pause, Next and Previous parts', async () => {
    const { matter, registered } = createMatterApi();
    const bridge = new MatterAccessoryBridge(createDeps(matter, createMockLog()));

    await bridge.configure();

    expect(registered).toHaveLength(1);
    expect(registered[0].UUID).toBe(composedUuid());
    expect(registered[0].parts?.map((p) => p.id).sort()).toEqual(['mute', 'next', 'playpause', 'previous']);
  });

  it('seeds Mute and Play/Pause parts at "off" and Next/Previous with no on/off state to sync', async () => {
    const { matter, registered } = createMatterApi();
    const bridge = new MatterAccessoryBridge(createDeps(matter, createMockLog()));

    await bridge.configure();

    expect(part(registered, 'mute').clusters?.onOff).toEqual({ onOff: false });
    expect(part(registered, 'playpause').clusters?.onOff).toEqual({ onOff: false });
    expect(part(registered, 'next').clusters?.onOff).toEqual({ onOff: false });
  });

  it('logs the Matter bridge status at debug after a successful registration, when reported', async () => {
    const { matter } = createMatterApi('uncommissioned');
    const log = createMockLog();
    const bridge = new MatterAccessoryBridge(createDeps(matter, log));

    await bridge.configure();

    expect(log.debug).toHaveBeenCalledWith('"%s": Matter bridge status is "%s".', 'Living Room Music', 'uncommissioned');
  });

  it('does not register anything when enableMatter is off', async () => {
    const { matter, registerPlatformAccessories } = createMatterApi();
    const bridge = new MatterAccessoryBridge(createDeps(matter, createMockLog(), { enableMatter: false }));

    await bridge.configure();

    expect(registerPlatformAccessories).not.toHaveBeenCalled();
  });

  it('warns once and does nothing when enableMatter is on but Homebridge has no Matter Plugin API', async () => {
    const log = createMockLog();
    const bridge = new MatterAccessoryBridge(createDeps(undefined, log));

    await bridge.configure();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Matter'), 'Living Room Music');
  });
});

describe('MatterAccessoryBridge — cleanup', () => {
  it('unregisters the four legacy per-switch UUIDs before publishing the composed accessory (upgrade path)', async () => {
    const { matter, unregisterPlatformAccessories } = createMatterApi();
    const bridge = new MatterAccessoryBridge(createDeps(matter, createMockLog()));

    await bridge.configure();

    expect(unregisterPlatformAccessories).toHaveBeenCalledWith('homebridge-owntone', 'OwnTone', [
      { UUID: legacyUuid('mute') },
      { UUID: legacyUuid('playpause') },
      { UUID: legacyUuid('next') },
      { UUID: legacyUuid('previous') },
    ]);
  });

  it('unregisters both legacy and composed UUIDs, and does not register anything, when Matter is disabled', async () => {
    const { matter, unregisterPlatformAccessories, registerPlatformAccessories } = createMatterApi();
    const bridge = new MatterAccessoryBridge(createDeps(matter, createMockLog(), { enableMatter: false }));

    await bridge.configure();

    expect(registerPlatformAccessories).not.toHaveBeenCalled();
    expect(unregisterPlatformAccessories).toHaveBeenCalledWith('homebridge-owntone', 'OwnTone', [
      { UUID: legacyUuid('mute') },
      { UUID: legacyUuid('playpause') },
      { UUID: legacyUuid('next') },
      { UUID: legacyUuid('previous') },
      { UUID: composedUuid() },
    ]);
  });

  it('unregisters the composed accessory on dispose', async () => {
    const { matter, unregisterPlatformAccessories } = createMatterApi();
    const bridge = new MatterAccessoryBridge(createDeps(matter, createMockLog()));

    await bridge.configure();
    unregisterPlatformAccessories.mockClear();
    await bridge.dispose();

    expect(unregisterPlatformAccessories).toHaveBeenCalledWith('homebridge-owntone', 'OwnTone', [{ UUID: composedUuid() }]);
  });

  it('does nothing on dispose when nothing was ever registered', async () => {
    const { matter, unregisterPlatformAccessories } = createMatterApi();
    const bridge = new MatterAccessoryBridge(createDeps(matter, createMockLog(), { enableMatter: false }));

    await bridge.configure();
    unregisterPlatformAccessories.mockClear();
    await bridge.dispose();

    expect(unregisterPlatformAccessories).not.toHaveBeenCalled();
  });

  it('does not throw when unregisterPlatformAccessories rejects, and logs at debug', async () => {
    const { matter, unregisterPlatformAccessories } = createMatterApi();
    unregisterPlatformAccessories.mockRejectedValue(new Error('not found'));
    const log = createMockLog();
    const bridge = new MatterAccessoryBridge(createDeps(matter, log));

    await expect(bridge.configure()).resolves.toBeUndefined();
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('Matter cleanup'), 'Living Room Music', 'not found');
  });
});

describe('MatterAccessoryBridge — handlers', () => {
  it('Mute handler calls handleMuteSet(true)/(false)', async () => {
    const { matter, registered } = createMatterApi();
    const deps = createDeps(matter, createMockLog());
    const bridge = new MatterAccessoryBridge(deps);

    await bridge.configure();
    await part(registered, 'mute').handlers?.onOff?.on?.();
    expect(deps.handleMuteSet).toHaveBeenCalledWith(true);

    await part(registered, 'mute').handlers?.onOff?.off?.();
    expect(deps.handleMuteSet).toHaveBeenCalledWith(false);
  });

  it('Play/Pause handler calls play()/pause()', async () => {
    const { matter, registered } = createMatterApi();
    const deps = createDeps(matter, createMockLog());
    const bridge = new MatterAccessoryBridge(deps);

    await bridge.configure();
    await part(registered, 'playpause').handlers?.onOff?.on?.();
    expect(deps.client.play).toHaveBeenCalled();

    await part(registered, 'playpause').handlers?.onOff?.off?.();
    expect(deps.client.pause).toHaveBeenCalled();
  });

  it('Next/Previous handlers run the action and auto-reset back to off', async () => {
    const { matter, registered, updateAccessoryState } = createMatterApi();
    const deps = createDeps(matter, createMockLog());
    const bridge = new MatterAccessoryBridge(deps);

    await bridge.configure();
    await part(registered, 'next').handlers?.onOff?.on?.();

    expect(deps.client.next).toHaveBeenCalled();
    expect(updateAccessoryState).toHaveBeenCalledWith(composedUuid(), 'onOff', { onOff: false }, 'next');
  });

  it('get handlers return the last-known cached state instead of always false', async () => {
    const { matter, registered } = createMatterApi();
    const bridge = new MatterAccessoryBridge(createDeps(matter, createMockLog()));

    await bridge.configure();
    bridge.pushState(true, true);

    expect(await part(registered, 'mute').handlers?.onOff?.get?.()).toEqual({ onOff: true });
    expect(await part(registered, 'playpause').handlers?.onOff?.get?.()).toEqual({ onOff: true });
  });
});

describe('MatterAccessoryBridge — pushState', () => {
  it('updates only the part whose state actually changed, targeting it via partId', async () => {
    const { matter, registered, updateAccessoryState } = createMatterApi();
    const bridge = new MatterAccessoryBridge(createDeps(matter, createMockLog()));

    await bridge.configure();
    updateAccessoryState.mockClear();

    bridge.pushState(false, true);

    expect(updateAccessoryState).toHaveBeenCalledWith(registered[0].UUID, 'onOff', { onOff: true }, 'mute');
    expect(updateAccessoryState).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'playpause');
  });

  it('is a no-op before registration has completed', () => {
    const { matter, updateAccessoryState } = createMatterApi();
    const bridge = new MatterAccessoryBridge(createDeps(matter, createMockLog()));

    bridge.pushState(true, true);

    expect(updateAccessoryState).not.toHaveBeenCalled();
  });
});

describe('MatterAccessoryBridge — failures are caught, not thrown', () => {
  it('logs a warning instead of throwing when registerPlatformAccessories rejects', async () => {
    const { matter } = createMatterApi();
    (matter.registerPlatformAccessories as jest.Mock).mockRejectedValue(new Error('registration failed'));
    const log = createMockLog();
    const bridge = new MatterAccessoryBridge(createDeps(matter, log));

    await expect(bridge.configure()).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not publish Matter accessories'),
      'Living Room Music',
      'registration failed',
    );
  });

  it('appends an actionable hint when a registration failure is a recognized Matter error kind', async () => {
    const { matter } = createMatterApi();
    const commissioningError = new Error('not paired');
    commissioningError.name = 'MatterCommissioningError';
    (matter.registerPlatformAccessories as jest.Mock).mockRejectedValue(commissioningError);
    const log = createMockLog();
    const bridge = new MatterAccessoryBridge(createDeps(matter, log));

    await bridge.configure();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('pair it via the Homebridge Matter UI'),
      'Living Room Music',
      'not paired',
    );
  });

  it('logs at debug instead of throwing when pushState fails to update Matter state', async () => {
    const { matter, updateAccessoryState } = createMatterApi();
    const log = createMockLog();
    const bridge = new MatterAccessoryBridge(createDeps(matter, log));

    await bridge.configure();
    updateAccessoryState.mockRejectedValue(new Error('update failed'));

    bridge.pushState(false, true);
    await flushMicrotasks();

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('could not update Matter mute state'),
      'Living Room Music',
      'update failed',
    );
  });

  it('logs at debug instead of throwing when the momentary-reset Matter update fails', async () => {
    const { matter, registered, updateAccessoryState } = createMatterApi();
    const log = createMockLog();
    const bridge = new MatterAccessoryBridge(createDeps(matter, log));

    await bridge.configure();
    updateAccessoryState.mockRejectedValue(new Error('reset failed'));

    await part(registered, 'next').handlers?.onOff?.on?.();
    await flushMicrotasks();

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('could not update Matter next state'),
      'Living Room Music',
      'reset failed',
    );
  });
});
