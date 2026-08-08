import { Accessory, Characteristic, HapStatusError, Service, uuid } from 'hap-nodejs';
import type { API, Logging, PlatformAccessory } from 'homebridge';

// `Categories` and `HAPStatus` are `const enum`s, so they cannot be referenced
// as values through a normal import. hap-nodejs is compiled with
// `preserveConstEnums`, so the runtime objects do exist.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hapRuntime = require('hap-nodejs') as Record<string, unknown>;

/**
 * A `PlatformAccessory` stand-in backed by the real hap-nodejs `Accessory`, so
 * that services and characteristics behave exactly as they do in Homebridge.
 */
export class FakePlatformAccessory extends Accessory {
  context: Record<string, unknown> = {};

  constructor(displayName: string, accessoryUUID: string) {
    super(displayName, accessoryUUID);
    // Swallow hap-nodejs characteristic warnings so they do not pollute the
    // Jest output; having a listener also stops the default console logging.
    this.on('characteristic-warning', () => undefined);
  }
}

export interface MockLog extends Logging {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
  success: jest.Mock;
  log: jest.Mock;
}

export function createMockLog(): MockLog {
  const log = jest.fn() as unknown as MockLog;
  log.info = jest.fn();
  log.warn = jest.fn();
  log.error = jest.fn();
  log.debug = jest.fn();
  log.success = jest.fn();
  log.log = jest.fn();
  log.prefix = 'test';
  return log;
}

export interface MockApi extends API {
  registerPlatformAccessories: jest.Mock;
  unregisterPlatformAccessories: jest.Mock;
  updatePlatformAccessories: jest.Mock;
  publishExternalAccessories: jest.Mock;
  /** Fire a Homebridge lifecycle event (e.g. `didFinishLaunching`). */
  emitEvent(event: string): void;
}

export function createMockApi(): MockApi {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const api = {
    version: 2.7,
    serverVersion: '1.11.4',
    hap: {
      Service,
      Characteristic,
      uuid,
      HapStatusError,
      Categories: hapRuntime.Categories,
      HAPStatus: hapRuntime.HAPStatus,
    },
    platformAccessory: FakePlatformAccessory as unknown as API['platformAccessory'],
    user: {
      configPath: () => '/tmp/config.json',
      storagePath: () => '/tmp',
      persistPath: () => '/tmp/persist',
      cachedAccessoryPath: () => '/tmp/accessories',
    },
    registerPlatformAccessories: jest.fn(),
    unregisterPlatformAccessories: jest.fn(),
    updatePlatformAccessories: jest.fn(),
    publishExternalAccessories: jest.fn(),
    registerAccessory: jest.fn(),
    registerPlatform: jest.fn(),
    on(event: string, listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return api;
    },
    emitEvent(event: string) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };

  return api as unknown as MockApi;
}

/** Build a `PlatformAccessory` the way Homebridge would. */
export function createAccessory(name: string, identity: string): PlatformAccessory {
  return new FakePlatformAccessory(name, uuid.generate(identity)) as unknown as PlatformAccessory;
}

export { Characteristic, Service, uuid };
