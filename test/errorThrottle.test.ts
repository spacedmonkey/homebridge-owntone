import { ErrorThrottle } from '../src/errorThrottle';

describe('ErrorThrottle', () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => {
    now = 0;
  });

  it('logs the first occurrence of a key immediately', () => {
    const logFn = jest.fn();
    const throttle = new ErrorThrottle(1000, clock);

    expect(throttle.log('poll', logFn, 'server unreachable')).toBe(true);
    expect(logFn).toHaveBeenCalledTimes(1);
    expect(logFn).toHaveBeenCalledWith('server unreachable');
  });

  it('suppresses repeated messages inside the throttle window', () => {
    const logFn = jest.fn();
    const throttle = new ErrorThrottle(1000, clock);

    throttle.log('poll', logFn, 'server unreachable');
    now = 500;
    expect(throttle.log('poll', logFn, 'server unreachable')).toBe(false);
    now = 999;
    expect(throttle.log('poll', logFn, 'server unreachable')).toBe(false);

    expect(logFn).toHaveBeenCalledTimes(1);
    expect(throttle.suppressedCount('poll')).toBe(2);
  });

  it('logs again once the throttle window has elapsed, reporting suppressed messages', () => {
    const logFn = jest.fn();
    const throttle = new ErrorThrottle(1000, clock);

    throttle.log('poll', logFn, 'server unreachable');
    now = 500;
    throttle.log('poll', logFn, 'server unreachable');
    now = 1500;
    expect(throttle.log('poll', logFn, 'server unreachable')).toBe(true);

    expect(logFn).toHaveBeenCalledTimes(2);
    expect(logFn).toHaveBeenLastCalledWith('server unreachable (1 similar message(s) suppressed)');
    expect(throttle.suppressedCount('poll')).toBe(0);
  });

  it('keeps separate windows per key', () => {
    const logFn = jest.fn();
    const throttle = new ErrorThrottle(1000, clock);

    expect(throttle.log('poll', logFn, 'a')).toBe(true);
    expect(throttle.log('artwork', logFn, 'b')).toBe(true);
    expect(logFn).toHaveBeenCalledTimes(2);
  });

  it('logs immediately again after reset()', () => {
    const logFn = jest.fn();
    const throttle = new ErrorThrottle(1000, clock);

    throttle.log('poll', logFn, 'server unreachable');
    throttle.reset('poll');
    expect(throttle.log('poll', logFn, 'server unreachable')).toBe(true);
    expect(logFn).toHaveBeenCalledTimes(2);
    expect(logFn).toHaveBeenLastCalledWith('server unreachable');
  });

  it('clear() forgets every key', () => {
    const logFn = jest.fn();
    const throttle = new ErrorThrottle(1000, clock);

    throttle.log('poll', logFn, 'a');
    throttle.clear();
    expect(throttle.log('poll', logFn, 'a')).toBe(true);
  });

  it('defaults to the real clock without throwing', () => {
    const logFn = jest.fn();
    const throttle = new ErrorThrottle();
    expect(throttle.log('poll', logFn, 'a')).toBe(true);
    expect(throttle.log('poll', logFn, 'a')).toBe(false);
  });
});
