import type { API } from 'homebridge';

/**
 * Minimal slice of Homebridge 2.x's native Matter Plugin API (`api.matter`)
 * this plugin relies on. Homebridge's own published type definitions only
 * gained this in 2.x, and this plugin's `homebridge` devDependency is
 * pinned to 1.x for compatibility, so this is a hand-written subset of the
 * real shape rather than an import — checked for at runtime via
 * {@link matterApiOf}, the same way the rest of this codebase
 * feature-detects optional HAP characteristics instead of hard-requiring a
 * specific HAP/Homebridge version.
 */
export interface MatterOnOffState {
  onOff: boolean;
}

export type MatterCommandHandler = () => void | Promise<void>;

export interface MatterOnOffHandlers {
  on?: MatterCommandHandler;
  off?: MatterCommandHandler;
}

export interface MatterAccessoryDefinition {
  UUID: string;
  displayName: string;
  deviceType: unknown;
  serialNumber: string;
  manufacturer: string;
  model: string;
  clusters?: {
    onOff?: Partial<MatterOnOffState>;
  };
  handlers?: {
    onOff?: MatterOnOffHandlers;
  };
}

export interface MatterAPI {
  readonly uuid: { generate(data: string): string };
  readonly deviceTypes: Record<string, unknown>;
  registerPlatformAccessories(pluginIdentifier: string, platformName: string, accessories: MatterAccessoryDefinition[]): Promise<void>;
  updateAccessoryState(uuid: string, cluster: 'onOff', attributes: Partial<MatterOnOffState>): Promise<void>;
}

/** Feature-detects Homebridge's native Matter Plugin API, absent before Homebridge 2.x. */
export function matterApiOf(api: API): MatterAPI | undefined {
  return (api as unknown as { matter?: MatterAPI }).matter;
}
