import type { OwnToneClient } from '../src/owntoneClient';
import { PollLoop, type PollLoopDeps } from '../src/pollLoop';
import { createMockLog } from './helpers/homebridgeMock';

function createDeps(overrides: Partial<PollLoopDeps> = {}): PollLoopDeps & { getStatus: jest.Mock } {
  const getStatus = jest.fn().mockResolvedValue({ state: 'stop' });
  const client = {
    description: 'http://192.168.1.50:3689',
    getStatus,
    getNowPlaying: jest.fn(),
    getOutputs: jest.fn(),
  } as unknown as OwnToneClient;

  return {
    config: { name: 'Living Room Music', pollingInterval: 5 } as PollLoopDeps['config'],
    client,
    log: createMockLog(),
    throttle: { log: jest.fn(), reset: jest.fn() } as unknown as PollLoopDeps['throttle'],
    pushClientFactory: jest.fn() as unknown as PollLoopDeps['pushClientFactory'],
    onSuccess: jest.fn(),
    onFailure: jest.fn(),
    getStatus,
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('PollLoop — disposed', () => {
  it('poll() is a no-op once disposed', async () => {
    const deps = createDeps();
    const loop = new PollLoop(deps);

    loop.dispose();
    await loop.poll();

    expect(deps.getStatus).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('does not schedule a new poll timer once disposed', () => {
    const deps = createDeps();
    const loop = new PollLoop(deps);

    loop.dispose();
    loop.start();

    jest.advanceTimersByTime(60_000);

    expect(deps.getStatus).not.toHaveBeenCalled();
  });
});
