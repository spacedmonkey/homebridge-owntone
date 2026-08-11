import type { CharacteristicValue } from 'homebridge';

import type { MatterAccessoryDefinition, MatterAccessoryPart, MatterAPI, MatterCommandHandler, MatterErrorKind } from './matterTypes';
import { matterApiOf, matterErrorKind } from './matterTypes';
import type { OwnToneClient } from './owntoneClient';
import type { OwnTonePlatform } from './platform';
import { serverIdentity } from './platform';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import type { ResolvedServerConfig } from './types';
import { describeError } from './util';

/** Everything {@link MatterAccessoryBridge} needs from `OwnTonePlatformAccessory`, and nothing else. */
export interface MatterAccessoryBridgeDeps {
  platform: OwnTonePlatform;
  config: ResolvedServerConfig;
  client: OwnToneClient;
  serialNumber(): string;
  runCommand(label: string, action: () => Promise<void>, throwOnFailure?: boolean): Promise<boolean>;
  poll(): Promise<void>;
  handleMuteSet(value: CharacteristicValue): Promise<void>;
  scheduleMomentaryReset(reset: () => void): void;
}

type PartId = 'mute' | 'playpause' | 'next' | 'previous';

const PART_IDS: readonly PartId[] = ['mute', 'playpause', 'next', 'previous'];

/** Short, human-readable hint appended to a Matter failure log when the error is a recognized kind, so users get an actionable next step instead of a bare error message. */
const MATTER_ERROR_HINTS: Record<MatterErrorKind, string | undefined> = {
  commissioning: 'bridge is not commissioned yet — pair it via the Homebridge Matter UI',
  network: 'likely transient, should resolve on its own',
  storage: "check Homebridge's Matter storage path is writable",
  device: undefined,
  unknown: undefined,
};

/**
 * Publishes Mute, Play/Pause, Next and Previous as a single composed Matter
 * accessory (one `parts` sub-endpoint per control) via Homebridge's Matter
 * Plugin API (`api.matter`, Homebridge 2.x+) — mirroring the opt-in HomeKit
 * Switch services `OwnTonePlatformAccessory` exposes when
 * `exposeTrackSwitches` is on. There is no Matter device type for a
 * TV/media-player, absolute volume or output selection, so the primary
 * Television/Speaker/InputSource accessory has no Matter counterpart at all
 * and stays HomeKit-only.
 *
 * A no-op unless `exposeTrackSwitches` is also on — Matter accessories are
 * only ever published for buttons the user has already opted into having in
 * HomeKit, never introduced as Matter-only extras. Also a no-op on
 * Homebridge 1.x, where `api.matter` does not exist — logged once so the
 * user knows `enableMatter` had no effect rather than silently doing
 * nothing.
 */
export class MatterAccessoryBridge {
  private matterApi?: MatterAPI;
  private matterUuid?: string;
  private readonly partState = new Map<PartId, boolean>();

  constructor(private readonly deps: MatterAccessoryBridgeDeps) {}

  async configure(): Promise<void> {
    const { platform, config } = this.deps;
    const matter = matterApiOf(platform.api);

    if (!matter) {
      if (config.enableMatter && config.exposeTrackSwitches) {
        platform.log.warn(
          '"%s": Matter support was requested but this Homebridge version has no Matter Plugin API (Homebridge 2.x is required); ignoring.',
          config.name,
        );
      }
      return;
    }

    const identity = serverIdentity(config);

    if (!config.enableMatter || !config.exposeTrackSwitches) {
      // Matter is off for this server (or was just turned off) — clean up
      // anything a previous run may have published, under either the old
      // one-accessory-per-switch scheme or the current composed one, so
      // disabled/removed servers don't leave orphaned Matter accessories.
      await this.unregisterUuids(matter, [...this.legacyPartUuids(matter, identity), this.composedUuid(matter, identity)]);
      return;
    }

    // Upgrading from the old per-switch scheme: remove those four
    // accessories before publishing the new composed one so they don't
    // linger orphaned alongside it.
    await this.unregisterUuids(matter, this.legacyPartUuids(matter, identity));

    this.matterUuid = this.composedUuid(matter, identity);

    // Registration happens synchronously here, before the first poll has
    // ever resolved, so there is no real state to seed with yet — every
    // part starts at `false` and gets corrected by `pushState()` as soon as
    // the first poll (or push event) reports the real state, same as
    // HomeKit briefly showing defaults before its first characteristic
    // read. Seeding the map itself (not just each part's initial
    // `clusters` value) matters: without it, `pushState()`'s first
    // change-detection would compare against `undefined` and spuriously
    // push every part, not just the ones that actually changed.
    for (const id of PART_IDS) {
      this.partState.set(id, false);
    }

    const parts: MatterAccessoryPart[] = [
      this.toggledPart(matter, 'mute', 'Mute', {
        on: () => this.deps.handleMuteSet(true),
        off: () => this.deps.handleMuteSet(false),
      }),
      this.toggledPart(matter, 'playpause', 'Play/Pause', {
        on: async () => {
          await this.deps.runCommand('play', () => this.deps.client.play(), true);
          void this.deps.poll();
        },
        off: async () => {
          await this.deps.runCommand('pause', () => this.deps.client.pause(), true);
          void this.deps.poll();
        },
      }),
      this.momentaryPart(matter, 'next', 'Next Track', () => this.deps.client.next()),
      this.momentaryPart(matter, 'previous', 'Previous Track', () => this.deps.client.previous()),
    ];

    const accessory: MatterAccessoryDefinition = {
      UUID: this.matterUuid,
      displayName: `${config.name} Controls`,
      deviceType: matter.deviceTypes.OnOffSwitch,
      serialNumber: this.deps.serialNumber(),
      manufacturer: 'OwnTone',
      model: 'OwnTone Controls',
      parts,
    };

    try {
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.matterApi = matter;
      platform.log.info(
        '"%s": published Matter accessory "%s" (%s).',
        config.name,
        accessory.displayName,
        parts.map((part) => part.displayName).join(', '),
      );
      if (matter.status) {
        platform.log.debug('"%s": Matter bridge status is "%s".', config.name, matter.status);
      }
    } catch (error) {
      this.logMatterFailure('warn', 'could not publish Matter accessories', error);
    }
  }

  /**
   * Removes the Matter accessory this bridge may have registered. Called on
   * Homebridge shutdown (via `OwnTonePlatformAccessory.dispose()`) so a
   * removed/disabled server doesn't leave its Matter accessory behind.
   */
  async dispose(): Promise<void> {
    if (!this.matterApi || !this.matterUuid) {
      return;
    }
    await this.unregisterUuids(this.matterApi, [this.matterUuid]);
    this.matterApi = undefined;
  }

  /**
   * Mirrors the subset of state that has a Matter part onto it. A no-op
   * until registration (see {@link configure}) has completed — `matterApi`
   * stays unset otherwise, including on Homebridge 1.x or while
   * `enableMatter` is off.
   */
  pushState(isPlaying: boolean, isMuted: boolean): void {
    if (!this.matterApi || !this.matterUuid) {
      return;
    }

    const { platform, config } = this.deps;

    if (isMuted !== this.partState.get('mute')) {
      platform.log.debug('"%s": Matter Mute changed -> %s.', config.name, isMuted);
      this.updatePartState('mute', isMuted);
    }

    if (isPlaying !== this.partState.get('playpause')) {
      platform.log.debug('"%s": Matter Play/Pause changed -> %s.', config.name, isPlaying);
      this.updatePartState('playpause', isPlaying);
    }
  }

  /** Builds a Mute/Play-Pause style part: stays on/off until explicitly toggled again. */
  private toggledPart(
    matter: MatterAPI,
    id: PartId,
    displayName: string,
    handlers: { on: MatterCommandHandler; off: MatterCommandHandler },
  ): MatterAccessoryPart {
    return {
      id,
      displayName,
      deviceType: matter.deviceTypes.OnOffSwitch,
      clusters: { onOff: { onOff: this.partState.get(id) ?? false } },
      handlers: {
        onOff: {
          on: handlers.on,
          off: handlers.off,
          get: () => ({ onOff: this.partState.get(id) ?? false }),
        },
      },
    };
  }

  /**
   * Builds a Matter part for a momentary action (Next/Previous track):
   * turning it on runs the action then auto-resets back to off after a
   * short delay, the same "tap to trigger" pattern the HomeKit version of
   * these switches uses — Matter's `GenericSwitch` device type exists for
   * physical momentary switches but isn't user-tappable in Apple Home, so
   * `OnOffSwitch` is used here too.
   */
  private momentaryPart(matter: MatterAPI, id: PartId, displayName: string, action: () => Promise<void>): MatterAccessoryPart {
    return {
      id,
      displayName,
      deviceType: matter.deviceTypes.OnOffSwitch,
      clusters: { onOff: { onOff: false } },
      handlers: {
        onOff: {
          on: async () => {
            this.deps.scheduleMomentaryReset(() => this.updatePartState(id, false));
            await this.deps.runCommand(displayName, action);
          },
          get: () => ({ onOff: this.partState.get(id) ?? false }),
        },
      },
    };
  }

  /** Updates the cached state for one part and, if registered, pushes it to Matter. */
  private updatePartState(id: PartId, onOff: boolean): void {
    this.partState.set(id, onOff);

    if (!this.matterApi || !this.matterUuid) {
      return;
    }

    void this.matterApi
      .updateAccessoryState(this.matterUuid, this.matterApi.clusterNames.OnOff, { onOff }, id)
      .catch((error) => this.logMatterFailure('debug', `could not update Matter ${id} state`, error));
  }

  private composedUuid(matter: MatterAPI, identity: string): string {
    return matter.uuid.generate(`${identity}:matter:controls`);
  }

  /** UUIDs of the four standalone accessories this bridge published before it was switched to a single composed (`parts`) device. */
  private legacyPartUuids(matter: MatterAPI, identity: string): string[] {
    return PART_IDS.map((id) => matter.uuid.generate(`${identity}:matter:${id}`));
  }

  /** Best-effort unregister: most of these UUIDs were never registered this run, so a "not found"-style rejection is the common case, not a real failure — logged at debug and otherwise ignored. */
  private async unregisterUuids(matter: MatterAPI, uuids: string[]): Promise<void> {
    try {
      await matter.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        uuids.map((UUID) => ({ UUID })),
      );
    } catch (error) {
      this.logMatterFailure('debug', 'Matter cleanup', error);
    }
  }

  private logMatterFailure(level: 'warn' | 'debug', baseMessage: string, error: unknown): void {
    const { platform, config } = this.deps;
    const hint = MATTER_ERROR_HINTS[matterErrorKind(error)];
    const detail = describeError(error);
    const message = hint ? `"%s": ${baseMessage}: %s (${hint}).` : `"%s": ${baseMessage}: %s`;

    if (level === 'warn') {
      platform.log.warn(message, config.name, detail);
    } else {
      platform.log.debug(message, config.name, detail);
    }
  }
}
