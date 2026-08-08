import { LOG_THROTTLE_WINDOW } from './settings';

/** Minimal logger surface — satisfied by the Homebridge `Logging` object. */
export type ThrottledLogFn = (message: string, ...parameters: unknown[]) => void;

interface ThrottleEntry {
  lastLoggedAt: number;
  suppressed: number;
}

/**
 * Suppresses repeated identical log messages so that an OwnTone server which
 * has been offline for hours does not fill the Homebridge log.
 *
 * The first occurrence of a key is logged immediately. Further occurrences
 * within `windowMs` are counted but not logged. Once the window has elapsed,
 * the next occurrence is logged again along with the number of messages that
 * were suppressed in the meantime.
 */
export class ErrorThrottle {
  private readonly entries = new Map<string, ThrottleEntry>();

  /**
   * @param windowMs Minimum delay between two identical messages.
   * @param now Injectable clock, mainly so tests do not need timer mocking.
   */
  constructor(
    private readonly windowMs: number = LOG_THROTTLE_WINDOW,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Log `message` through `logFn` unless an identical `key` was logged less
   * than `windowMs` ago.
   *
   * @returns `true` when the message was actually emitted.
   */
  log(key: string, logFn: ThrottledLogFn, message: string): boolean {
    const timestamp = this.now();
    const entry = this.entries.get(key);

    if (entry && timestamp - entry.lastLoggedAt < this.windowMs) {
      entry.suppressed += 1;
      return false;
    }

    const suppressed = entry?.suppressed ?? 0;
    this.entries.set(key, { lastLoggedAt: timestamp, suppressed: 0 });

    if (suppressed > 0) {
      logFn(`${message} (${suppressed} similar message(s) suppressed)`);
    } else {
      logFn(message);
    }

    return true;
  }

  /**
   * Forget a key so that the next occurrence is logged immediately. Call this
   * after a successful request to make recovery visible in the log.
   */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Forget every key. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of occurrences suppressed for `key` since it was last logged. */
  suppressedCount(key: string): number {
    return this.entries.get(key)?.suppressed ?? 0;
  }
}
