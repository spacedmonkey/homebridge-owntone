import type { API } from 'homebridge';

/**
 * Minimal slice of Homebridge 2.x's native Matter Plugin API (`api.matter`)
 * this plugin relies on. Homebridge's own published type definitions only
 * gained this in 2.x, and this plugin's `homebridge` devDependency is
 * pinned to 1.x for compatibility, so this is a hand-written subset of the
 * real shape rather than an import — checked for at runtime via
 * {@link matterApiOf}, the same way the rest of this codebase
 * feature-detects optional HAP characteristics instead of hard-requiring a
 * specific HAP/Homebridge version. Exact field/method shapes below (in
 * particular {@link MatterAPI.unregisterPlatformAccessories} and the error
 * `name`s in {@link matterErrorKind}) are a best-effort match to Homebridge's
 * documented API surface, not a verified import — if Homebridge's real
 * runtime shape differs, calls degrade the same way any other unexpected
 * Matter failure does here: caught and logged, never thrown.
 */
export interface MatterOnOffState {
  onOff: boolean;
}

/** The one cluster this plugin uses, named the way `matter.clusterNames.OnOff` would resolve it. */
export const MATTER_ONOFF_CLUSTER = 'onOff' as const;

export interface MatterClusterNames {
  readonly OnOff: typeof MATTER_ONOFF_CLUSTER;
}

/** Identifies which sub-endpoint of a composed (`parts`) accessory a handler call is for. */
export interface MatterHandlerContext {
  partId?: string;
}

export type MatterCommandHandler = (context?: MatterHandlerContext) => void | Promise<void>;
export type MatterStateHandler = (context?: MatterHandlerContext) => MatterOnOffState | Promise<MatterOnOffState>;

export interface MatterOnOffHandlers {
  on?: MatterCommandHandler;
  off?: MatterCommandHandler;
  /** Pull-based state read, called when a Matter controller reads this cluster's attributes on demand. */
  get?: MatterStateHandler;
}

/** A sub-endpoint of a composed `MatterAccessoryDefinition`, appearing as one combinable/splittable control under its parent in Apple Home. */
export interface MatterAccessoryPart {
  id: string;
  displayName: string;
  deviceType: unknown;
  clusters?: {
    onOff?: Partial<MatterOnOffState>;
  };
  handlers?: {
    onOff?: MatterOnOffHandlers;
  };
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
  /** Independently controllable sub-endpoints under a `BridgedNode` parent — one Apple Home tile with several controls, instead of one tile per control. */
  parts?: MatterAccessoryPart[];
}

/** Whether Homebridge's Matter bridge is paired with a Matter controller (Apple Home, etc.) yet. */
export type MatterBridgeStatus = 'commissioned' | 'uncommissioned' | 'unknown';

export type MatterErrorKind = 'commissioning' | 'device' | 'network' | 'storage' | 'unknown';

/** Classifies a Matter API rejection by its (documented) error class name, for actionable log messages instead of one generic failure message. */
export function matterErrorKind(error: unknown): MatterErrorKind {
  const name = error instanceof Error ? error.name : undefined;
  switch (name) {
    case 'MatterCommissioningError':
      return 'commissioning';
    case 'MatterDeviceError':
      return 'device';
    case 'MatterNetworkError':
      return 'network';
    case 'MatterStorageError':
      return 'storage';
    default:
      return 'unknown';
  }
}

export interface MatterAPI {
  readonly uuid: { generate(data: string): string };
  readonly deviceTypes: Record<string, unknown>;
  readonly clusterNames: MatterClusterNames;
  /** Present once the Matter bridge has finished starting; absent (rather than a slow/blocking read) if this Homebridge build doesn't report it. */
  readonly status?: MatterBridgeStatus;
  registerPlatformAccessories(pluginIdentifier: string, platformName: string, accessories: MatterAccessoryDefinition[]): Promise<void>;
  /** Only `UUID` is required — call sites pass either full definitions or `{ UUID }` stubs for accessories that may never have been registered this run. */
  unregisterPlatformAccessories(
    pluginIdentifier: string,
    platformName: string,
    accessories: Array<Pick<MatterAccessoryDefinition, 'UUID'>>,
  ): Promise<void>;
  updateAccessoryState(
    uuid: string,
    cluster: typeof MATTER_ONOFF_CLUSTER,
    attributes: Partial<MatterOnOffState>,
    partId?: string,
  ): Promise<void>;
  getAccessoryState(uuid: string, cluster: typeof MATTER_ONOFF_CLUSTER, partId?: string): Promise<MatterOnOffState>;
}

/** Feature-detects Homebridge's native Matter Plugin API, absent before Homebridge 2.x. */
export function matterApiOf(api: API): MatterAPI | undefined {
  return (api as unknown as { matter?: MatterAPI }).matter;
}
