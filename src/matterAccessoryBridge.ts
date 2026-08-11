import type { CharacteristicValue } from 'homebridge';

import type { MatterAccessoryDefinition, MatterAPI } from './matterTypes';
import { matterApiOf } from './matterTypes';
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

/**
 * Publishes Mute, Play/Pause, Next and Previous as native Matter accessories
 * via Homebridge's Matter Plugin API (`api.matter`, Homebridge 2.x+) —
 * mirroring the opt-in HomeKit Switch services `OwnTonePlatformAccessory`
 * exposes when `exposeTrackSwitches` is on, one-for-one. There is no Matter
 * device type for a TV/media-player, absolute volume or output selection, so
 * the primary Television/Speaker/InputSource accessory has no Matter
 * counterpart at all and stays HomeKit-only.
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
  private matterMuteUuid?: string;
  private matterMutedState?: boolean;
  private matterPlayPauseUuid?: string;
  private matterPlayingState?: boolean;

  constructor(private readonly deps: MatterAccessoryBridgeDeps) {}

  async configure(): Promise<void> {
    const { platform, config, client } = this.deps;

    if (!config.enableMatter || !config.exposeTrackSwitches) {
      return;
    }

    const matter = matterApiOf(platform.api);
    if (!matter) {
      platform.log.warn(
        '"%s": Matter support was requested but this Homebridge version has no Matter Plugin API (Homebridge 2.x is required); ignoring.',
        config.name,
      );
      return;
    }

    const identity = serverIdentity(config);
    const deviceType = matter.deviceTypes.OnOffSwitch;
    const accessories: MatterAccessoryDefinition[] = [];

    // Registration happens synchronously in the constructor, before the
    // first poll has ever resolved, so there is no real state to seed with
    // yet — both accessories start at `false` and get corrected by
    // `pushState()` as soon as the first poll (or push event) reports the
    // real state, same as HomeKit briefly showing defaults before its first
    // characteristic read.
    this.matterMuteUuid = matter.uuid.generate(`${identity}:matter:mute`);
    this.matterMutedState = false;
    accessories.push({
      UUID: this.matterMuteUuid,
      displayName: `${config.name} Mute`,
      deviceType,
      serialNumber: `${this.deps.serialNumber()}-mute`,
      manufacturer: 'OwnTone',
      model: 'OwnTone Mute',
      clusters: { onOff: { onOff: this.matterMutedState } },
      handlers: {
        onOff: {
          on: () => this.deps.handleMuteSet(true),
          off: () => this.deps.handleMuteSet(false),
        },
      },
    });

    this.matterPlayPauseUuid = matter.uuid.generate(`${identity}:matter:playpause`);
    this.matterPlayingState = false;
    accessories.push({
      UUID: this.matterPlayPauseUuid,
      displayName: `${config.name} Play/Pause`,
      deviceType,
      serialNumber: `${this.deps.serialNumber()}-playpause`,
      manufacturer: 'OwnTone',
      model: 'OwnTone Play/Pause',
      clusters: { onOff: { onOff: this.matterPlayingState } },
      handlers: {
        onOff: {
          on: async () => {
            await this.deps.runCommand('play', () => client.play(), true);
            void this.deps.poll();
          },
          off: async () => {
            await this.deps.runCommand('pause', () => client.pause(), true);
            void this.deps.poll();
          },
        },
      },
    });

    accessories.push(this.momentaryAccessoryDefinition(matter, identity, 'next', 'Next Track', () => client.next()));
    accessories.push(this.momentaryAccessoryDefinition(matter, identity, 'previous', 'Previous Track', () => client.previous()));

    try {
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
      this.matterApi = matter;
      platform.log.info(
        '"%s": published %d Matter accessor%s (%s).',
        config.name,
        accessories.length,
        accessories.length === 1 ? 'y' : 'ies',
        accessories.map((accessory) => accessory.displayName).join(', '),
      );
    } catch (error) {
      platform.log.warn('"%s": could not publish Matter accessories: %s', config.name, describeError(error));
    }
  }

  /**
   * Mirrors the subset of state that has a Matter accessory onto it. A no-op
   * until registration (see {@link configure}) has completed — `matterApi`
   * stays unset otherwise, including on Homebridge 1.x or while
   * `enableMatter` is off.
   */
  pushState(isPlaying: boolean, isMuted: boolean): void {
    if (!this.matterApi) {
      return;
    }

    const { platform, config } = this.deps;

    if (this.matterMuteUuid && isMuted !== this.matterMutedState) {
      this.matterMutedState = isMuted;
      platform.log.debug('"%s": Matter Mute changed -> %s.', config.name, isMuted);
      void this.matterApi
        .updateAccessoryState(this.matterMuteUuid, 'onOff', { onOff: isMuted })
        .catch((error) => platform.log.debug('"%s": could not update Matter Mute state: %s', config.name, describeError(error)));
    }

    if (this.matterPlayPauseUuid && isPlaying !== this.matterPlayingState) {
      this.matterPlayingState = isPlaying;
      platform.log.debug('"%s": Matter Play/Pause changed -> %s.', config.name, isPlaying);
      void this.matterApi
        .updateAccessoryState(this.matterPlayPauseUuid, 'onOff', { onOff: isPlaying })
        .catch((error) => platform.log.debug('"%s": could not update Matter Play/Pause state: %s', config.name, describeError(error)));
    }
  }

  /**
   * Builds a Matter accessory for a momentary action (Next/Previous track):
   * turning it on runs the action then auto-resets back to off after a
   * short delay, the same "tap to trigger" pattern the HomeKit version of
   * these switches uses — Matter's `GenericSwitch` device type exists for
   * physical momentary switches but isn't user-tappable in Apple Home, so
   * `OnOffSwitch` is used here too.
   */
  private momentaryAccessoryDefinition(
    matter: MatterAPI,
    identity: string,
    subtype: string,
    name: string,
    action: () => Promise<void>,
  ): MatterAccessoryDefinition {
    const uuid = matter.uuid.generate(`${identity}:matter:${subtype}`);
    const { platform, config } = this.deps;

    return {
      UUID: uuid,
      displayName: `${config.name} ${name}`,
      deviceType: matter.deviceTypes.OnOffSwitch,
      serialNumber: `${this.deps.serialNumber()}-${subtype}`,
      manufacturer: 'OwnTone',
      model: `OwnTone ${name}`,
      clusters: { onOff: { onOff: false } },
      handlers: {
        onOff: {
          on: async () => {
            this.deps.scheduleMomentaryReset(() => {
              void this.matterApi
                ?.updateAccessoryState(uuid, 'onOff', { onOff: false })
                .catch((error) => platform.log.debug('"%s": could not reset Matter %s switch: %s', config.name, name, describeError(error)));
            });

            await this.deps.runCommand(name, action);
          },
        },
      },
    };
  }
}
