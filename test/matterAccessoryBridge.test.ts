import { MatterAccessoryBridge, type MatterAccessoryBridgeDeps } from '../src/matterAccessoryBridge';
import type { MatterAccessoryDefinition, MatterAPI } from '../src/matterTypes';
import type { OwnTonePlatform } from '../src/platform';
import { createMockLog, type MockLog } from './helpers/homebridgeMock';

function createMatterApi(): { matter: MatterAPI; registered: MatterAccessoryDefinition[]; updateAccessoryState: jest.Mock } {
  const registered: MatterAccessoryDefinition[] = [];
  const registerPlatformAccessories = jest.fn(async (_plugin: string, _platformName: string, accessories: MatterAccessoryDefinition[]) => {
    registered.push(...accessories);
  });
  const updateAccessoryState = jest.fn().mockResolvedValue(undefined);

  const matter: MatterAPI = {
    uuid: { generate: (data: string) => `matter-uuid:${data}` },
    deviceTypes: { OnOffSwitch: 'OnOffSwitch' },
    registerPlatformAccessories,
    updateAccessoryState,
  };

  return { matter, registered, updateAccessoryState };
}

function accessoryByDisplayName(registered: MatterAccessoryDefinition[], displayName: string): MatterAccessoryDefinition {
  const found = registered.find((accessory) => accessory.displayName === displayName);
  if (!found) {
    throw new Error(`No registered Matter accessory named "${displayName}"; got: ${registered.map((a) => a.displayName).join(', ')}`);
  }
  return found;
}

function createDeps(matter: MatterAPI, log: MockLog): MatterAccessoryBridgeDeps {
  const platform = { log, api: { matter } } as unknown as OwnTonePlatform;

  return {
    platform,
    config: {
      name: 'Living Room Music',
      host: '192.168.1.50',
      port: 3689,
      enableMatter: true,
      exposeTrackSwitches: true,
    } as MatterAccessoryBridgeDeps['config'],
    client: {
      play: jest.fn().mockResolvedValue(undefined),
      pause: jest.fn().mockResolvedValue(undefined),
      next: jest.fn().mockResolvedValue(undefined),
      previous: jest.fn().mockResolvedValue(undefined),
    } as unknown as MatterAccessoryBridgeDeps['client'],
    serialNumber: () => 'serial-123',
    runCommand: jest.fn().mockResolvedValue(true),
    poll: jest.fn().mockResolvedValue(undefined),
    handleMuteSet: jest.fn().mockResolvedValue(undefined),
    scheduleMomentaryReset: (reset) => reset(),
  };
}

/** Lets already-scheduled microtasks (e.g. an unawaited `.catch()`) run before assertions. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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

  it('logs at debug instead of throwing when pushState fails to update Matter Mute state', async () => {
    const { matter, updateAccessoryState } = createMatterApi();
    const log = createMockLog();
    const bridge = new MatterAccessoryBridge(createDeps(matter, log));

    await bridge.configure();
    updateAccessoryState.mockRejectedValue(new Error('update failed'));

    // isPlaying unchanged (false), isMuted flips true -> only the Mute branch fires.
    bridge.pushState(false, true);
    await flushMicrotasks();

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('could not update Matter Mute state'),
      'Living Room Music',
      'update failed',
    );
  });

  it('logs at debug instead of throwing when pushState fails to update Matter Play/Pause state', async () => {
    const { matter, updateAccessoryState } = createMatterApi();
    const log = createMockLog();
    const bridge = new MatterAccessoryBridge(createDeps(matter, log));

    await bridge.configure();
    updateAccessoryState.mockRejectedValue(new Error('update failed'));

    // isMuted unchanged (false), isPlaying flips true -> only the Play/Pause branch fires.
    bridge.pushState(true, false);
    await flushMicrotasks();

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('could not update Matter Play/Pause state'),
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

    const next = accessoryByDisplayName(registered, 'Living Room Music Next Track');
    await next.handlers?.onOff?.on?.();
    await flushMicrotasks();

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('could not reset Matter %s switch'),
      'Living Room Music',
      'Next Track',
      'reset failed',
    );
  });
});
