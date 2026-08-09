import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
  WithUUID,
  Characteristic as HAPCharacteristic,
} from 'homebridge';

import { ErrorThrottle } from './errorThrottle';
import { OwnToneClient, UnsupportedFeatureError } from './owntoneClient';
import type { OwnTonePushClientOptions } from './owntonePushClient';
import { OwnTonePushClient } from './owntonePushClient';
import type { OwnTonePlatform } from './platform';
import { serverIdentity } from './platform';
import {
  DEFAULT_VOLUME_STEP,
  FAILURE_THRESHOLD,
  SEEK_STEP_MS,
  SWITCH_RESET_DELAY,
  WEBSOCKET_RECONCILE_INTERVAL_MS,
} from './settings';
import type {
  ArtworkSnapshot,
  OutputSnapshot,
  OwnToneConfigResponse,
  PlayerSnapshot,
  ResolvedServerConfig,
  TrackSnapshot,
} from './types';

/** Identifier of the always-present "OwnTone" input source. */
const DEFAULT_INPUT_IDENTIFIER = 1;

/**
 * HomeKit's `Name`/`ConfiguredName` characteristics only accept letters,
 * numbers, spaces, apostrophes and a small set of punctuation, and must both
 * start and end with a letter or number. OwnTone output names (AirPlay,
 * Chromecast, etc. speakers) routinely contain parentheses, quote marks or
 * other characters HomeKit rejects, so they're normalized before being used
 * as an InputSource name.
 */
export function sanitizeHapName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} '.,-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '');

  return cleaned || 'Output';
}

type CharacteristicCtor = WithUUID<new () => HAPCharacteristic>;

interface InputSourceEntry {
  identifier: number;
  outputId?: string;
  service: Service;
}

/**
 * Represents one OwnTone server as a HomeKit Television accessory:
 *
 * - `Television` for power/transport control and the Apple Remote,
 * - `TelevisionSpeaker` for volume and (emulated) mute,
 * - one `InputSource` per OwnTone output,
 * - optionally `Switch` services for next/previous/play-pause.
 */
export class OwnTonePlatformAccessory {
  private readonly televisionService: Service;
  private readonly speakerService: Service;
  private playPauseSwitchService?: Service;
  private readonly inputs: InputSourceEntry[] = [];
  private readonly switchTimers = new Set<NodeJS.Timeout>();
  private readonly throttle = new ErrorThrottle();

  private pollTimer?: NodeJS.Timeout;
  private polling = false;
  private disposed = false;
  private consecutiveFailures = 0;
  private pushClient?: OwnTonePushClient;
  private wsConnected = false;
  private pushRefreshTimer?: NodeJS.Timeout;

  private reachable = false;
  private player?: PlayerSnapshot;
  private track?: TrackSnapshot;
  private outputs: OutputSnapshot[] = [];
  private artwork?: ArtworkSnapshot;
  private artworkTrackKey?: string;
  private activeIdentifier = DEFAULT_INPUT_IDENTIFIER;
  private supportsAbsoluteVolume = false;

  constructor(
    private readonly platform: OwnTonePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: ResolvedServerConfig,
    private readonly client: OwnToneClient,
    private readonly pushClientFactory: (options: OwnTonePushClientOptions) => OwnTonePushClient = (options) =>
      new OwnTonePushClient(options),
  ) {
    this.configureAccessoryInformation();
    this.televisionService = this.configureTelevisionService();
    this.speakerService = this.configureSpeakerService();
    this.configureDefaultInputSource();

    // Seed InputSources from the config's cached outputs (populated by the
    // custom UI's "Refresh Outputs" button) so they're available immediately
    // on startup, rather than waiting for the first live poll. The first
    // poll still runs its own live discovery below and will correct this if
    // the cache is stale.
    if (this.config.outputs.length > 0) {
      this.syncInputSources(this.config.outputs);
    }

    if (this.config.exposeTrackSwitches) {
      this.configureTrackSwitches();
    }

    void this.loadFirmwareRevision();
    this.startPolling();
  }

  /** Stop all timers. Called by the platform on Homebridge shutdown. */
  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.pushRefreshTimer) {
      clearInterval(this.pushRefreshTimer);
      this.pushRefreshTimer = undefined;
    }
    for (const timer of this.switchTimers) {
      clearTimeout(timer);
    }
    this.switchTimers.clear();
    this.pushClient?.dispose();
  }

  /** Latest cached artwork metadata, if any. Exposed for logging and tests. */
  get currentArtwork(): ArtworkSnapshot | undefined {
    return this.artwork;
  }

  /** OwnTone outputs seen by the most recent refresh. */
  get currentOutputs(): OutputSnapshot[] {
    return this.outputs;
  }

  /** `true` while the OwnTone server is answering polls. */
  get isReachable(): boolean {
    return this.reachable;
  }

  /** `true` while the push-notification WebSocket is connected. Always `false` if the server doesn't support it or `enableWebSocket` is off. */
  get isPushConnected(): boolean {
    return this.wsConnected;
  }

  /* -------------------------------------------------------------------- *
   * Service setup
   * -------------------------------------------------------------------- */

  private configureAccessoryInformation(): void {
    const { Service, Characteristic } = this.platform;
    const information =
      this.accessory.getService(Service.AccessoryInformation) ?? this.accessory.addService(Service.AccessoryInformation);

    information
      .setCharacteristic(Characteristic.Manufacturer, 'OwnTone')
      .setCharacteristic(Characteristic.Model, 'OwnTone Server')
      .setCharacteristic(Characteristic.Name, this.config.name)
      .setCharacteristic(Characteristic.SerialNumber, this.serialNumber());

    this.setIfSupported(information, 'FirmwareRevision', 'unknown');
  }

  /**
   * Deterministic serial number derived from host, port and name — the same
   * inputs that produce the accessory UUID, so it stays stable across
   * restarts and config reloads.
   */
  private serialNumber(): string {
    return this.platform.api.hap.uuid.generate(serverIdentity(this.config));
  }

  private configureTelevisionService(): Service {
    const { Service, Characteristic } = this.platform;
    const service = this.accessory.getService(Service.Television) ?? this.accessory.addService(Service.Television, this.config.name);

    this.setIfSupported(service, 'ConfiguredName', this.config.name);
    this.setIfSupported(service, 'SleepDiscoveryMode', Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => this.currentActiveState())
      .onSet((value) => this.handleActiveSet(value));

    service
      .getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(() => this.activeIdentifier)
      .onSet((value) => this.handleActiveIdentifierSet(value));

    const remoteKey = this.optionalCharacteristic('RemoteKey');
    if (remoteKey) {
      service.getCharacteristic(remoteKey).onSet((value) => this.handleRemoteKey(value));
    } else {
      this.platform.log.warn('"%s": this HAP version has no RemoteKey characteristic; Apple Remote control is unavailable.', this.config.name);
    }

    const powerModeSelection = this.optionalCharacteristic('PowerModeSelection');
    if (powerModeSelection) {
      // OwnTone has no "settings screen"; acknowledge and ignore so the Home
      // app does not report a failure.
      service.getCharacteristic(powerModeSelection).onSet(() => {
        this.platform.log.debug('"%s": PowerModeSelection received; no OwnTone equivalent, ignoring.', this.config.name);
      });
    }

    if (typeof service.setPrimaryService === 'function') {
      service.setPrimaryService(true);
    }

    return service;
  }

  private configureSpeakerService(): Service {
    const { Service, Characteristic } = this.platform;
    const service =
      this.accessory.getServiceById(Service.TelevisionSpeaker, 'owntone-speaker') ??
      this.accessory.addService(Service.TelevisionSpeaker, `${this.config.name} Volume`, 'owntone-speaker');

    this.setIfSupported(service, 'Active', Characteristic.Active.ACTIVE);

    const volumeCharacteristic = this.optionalCharacteristic('Volume');
    this.supportsAbsoluteVolume = volumeCharacteristic !== undefined;

    const volumeControlType = this.optionalCharacteristic('VolumeControlType');
    if (volumeControlType) {
      const enumValues = enumsOf(volumeControlType);
      const absolute = enumValues.ABSOLUTE;
      const relative = enumValues.RELATIVE;
      const chosen = this.supportsAbsoluteVolume ? (absolute ?? relative) : relative;
      if (chosen !== undefined) {
        service.setCharacteristic(volumeControlType, chosen);
      }
    }

    const volumeSelector = this.optionalCharacteristic('VolumeSelector');
    if (volumeSelector) {
      service.getCharacteristic(volumeSelector).onSet((value) => this.handleVolumeSelector(volumeSelector, value));
    } else {
      this.platform.log.debug('"%s": VolumeSelector is unavailable in this HAP version.', this.config.name);
    }

    service
      .getCharacteristic(Characteristic.Mute)
      .onGet(() => this.currentMuteState())
      .onSet((value) => this.handleMuteSet(value));

    if (volumeCharacteristic) {
      service
        .getCharacteristic(volumeCharacteristic)
        .onGet(() => this.player?.volume ?? 0)
        .onSet((value) => this.handleVolumeSet(value));
    } else {
      this.platform.log.info(
        '"%s": absolute volume is not available in this HAP version; only relative volume control is exposed.',
        this.config.name,
      );
    }

    if (typeof this.televisionService?.addLinkedService === 'function') {
      this.televisionService.addLinkedService(service);
    }

    return service;
  }

  /**
   * A Television service must expose at least one input source. Identifier 1
   * is the generic "OwnTone" source and is always present; OwnTone outputs are
   * added as identifiers 2..n once the first poll has discovered them.
   */
  private configureDefaultInputSource(): void {
    const service = this.ensureInputService(DEFAULT_INPUT_IDENTIFIER, 'OwnTone');
    this.inputs.push({ identifier: DEFAULT_INPUT_IDENTIFIER, service });
    this.televisionService.setCharacteristic(this.platform.Characteristic.ActiveIdentifier, DEFAULT_INPUT_IDENTIFIER);
  }

  private ensureInputService(identifier: number, name: string): Service {
    const { Service, Characteristic } = this.platform;
    const subtype = `input-${identifier}`;
    const service =
      this.accessory.getServiceById(Service.InputSource, subtype) ??
      this.accessory.addService(Service.InputSource, name, subtype);

    service.setCharacteristic(Characteristic.Identifier, identifier);
    service.setCharacteristic(Characteristic.ConfiguredName, name);
    this.setIfSupported(service, 'Name', name);
    service.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
    service.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.OTHER);
    this.setIfSupported(service, 'CurrentVisibilityState', Characteristic.CurrentVisibilityState.SHOWN);

    if (typeof this.televisionService?.addLinkedService === 'function') {
      this.televisionService.addLinkedService(service);
    }

    return service;
  }

  private configureTrackSwitches(): void {
    this.addTrackSwitch('owntone-next', 'Next Track', () => this.client.next());
    this.addTrackSwitch('owntone-previous', 'Previous Track', () => this.client.previous());
    this.configurePlayPauseSwitch();
  }

  /**
   * Unlike the momentary Next/Previous switches, Play/Pause reflects actual
   * playback state — on while OwnTone is playing, off while paused or
   * stopped — and setting it drives playback directly (`play()`/`pause()`,
   * the same commands the Television's `Active` characteristic uses), same
   * behaviour as `handleActiveSet` below.
   */
  private configurePlayPauseSwitch(): void {
    const { Service, Characteristic } = this.platform;
    const displayName = `${this.config.name} Play/Pause`;
    const service =
      this.accessory.getServiceById(Service.Switch, 'owntone-playpause') ??
      this.accessory.addService(Service.Switch, displayName, 'owntone-playpause');

    this.setIfSupported(service, 'ConfiguredName', displayName);
    this.playPauseSwitchService = service;

    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.isPlaying)
      .onSet(async (value) => {
        const shouldPlay = value === true;
        await this.runCommand(shouldPlay ? 'play' : 'pause', () => (shouldPlay ? this.client.play() : this.client.pause()), true);
        void this.poll();
      });
  }

  private addTrackSwitch(subtype: string, name: string, action: () => Promise<void>): void {
    const { Service, Characteristic } = this.platform;
    const displayName = `${this.config.name} ${name}`;
    const service =
      this.accessory.getServiceById(Service.Switch, subtype) ?? this.accessory.addService(Service.Switch, displayName, subtype);

    this.setIfSupported(service, 'ConfiguredName', displayName);

    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (value !== true) {
          return;
        }

        // Reset back to "off" regardless of the outcome so the switch behaves
        // statelessly in the Home app.
        const timer = setTimeout(() => {
          this.switchTimers.delete(timer);
          service.updateCharacteristic(Characteristic.On, false);
        }, SWITCH_RESET_DELAY);
        this.switchTimers.add(timer);

        await this.runCommand(name, action);
      });
  }

  /* -------------------------------------------------------------------- *
   * HomeKit handlers
   * -------------------------------------------------------------------- */

  private get isPlaying(): boolean {
    return this.reachable && this.player?.state === 'play';
  }

  private currentActiveState(): CharacteristicValue {
    const { Characteristic } = this.platform;
    return this.isPlaying ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
  }

  private currentMuteState(): CharacteristicValue {
    return this.reachable && (this.player?.volume ?? 0) === 0;
  }

  private async handleActiveSet(value: CharacteristicValue): Promise<void> {
    const shouldPlay = value === this.platform.Characteristic.Active.ACTIVE;
    await this.runCommand(shouldPlay ? 'play' : 'pause', () => (shouldPlay ? this.client.play() : this.client.pause()), true);
    void this.poll();
  }

  private async handleActiveIdentifierSet(value: CharacteristicValue): Promise<void> {
    const identifier = Number(value);
    const entry = this.inputs.find((input) => input.identifier === identifier);

    if (!entry || !entry.outputId) {
      // The generic "OwnTone" source has no output to select.
      this.activeIdentifier = DEFAULT_INPUT_IDENTIFIER;
      this.platform.log.debug('"%s": input %d selected; no OwnTone output change required.', this.config.name, identifier);
      return;
    }

    const outputId = entry.outputId;
    await this.runCommand(`select output ${outputId}`, () => this.client.selectOutputsExclusively([outputId]), true);
    this.activeIdentifier = identifier;
    void this.poll();
  }

  private async handleRemoteKey(value: CharacteristicValue): Promise<void> {
    const remoteKey = this.optionalCharacteristic('RemoteKey');
    if (!remoteKey) {
      return;
    }

    const keys = enumsOf(remoteKey);
    const actions = new Map<number, { label: string; run: () => Promise<void> }>();

    const register = (key: number | undefined, label: string, run: () => Promise<void>): void => {
      if (typeof key === 'number') {
        actions.set(key, { label, run });
      }
    };

    register(keys.PLAY_PAUSE, 'toggle play/pause', () => this.client.toggle());
    register(keys.SELECT, 'toggle play/pause', () => this.client.toggle());
    register(keys.PLAY, 'play', () => this.client.play());
    register(keys.PAUSE, 'pause', () => this.client.pause());
    register(keys.NEXT_TRACK, 'next track', () => this.client.next());
    register(keys.ARROW_RIGHT, 'next track', () => this.client.next());
    register(keys.PREVIOUS_TRACK, 'previous track', () => this.client.previous());
    register(keys.ARROW_LEFT, 'previous track', () => this.client.previous());
    register(keys.FAST_FORWARD, 'seek forward', () => this.client.seekRelative(SEEK_STEP_MS));
    register(keys.REWIND, 'seek backward', () => this.client.seekRelative(-SEEK_STEP_MS));

    const action = actions.get(Number(value));
    if (!action) {
      // BACK, EXIT, INFORMATION, ARROW_UP/DOWN … have no OwnTone equivalent.
      this.platform.log.debug('"%s": remote key %s has no OwnTone equivalent, ignoring.', this.config.name, String(value));
      return;
    }

    await this.runCommand(action.label, action.run, true);
    void this.poll();
  }

  private async handleVolumeSelector(volumeSelector: CharacteristicCtor, value: CharacteristicValue): Promise<void> {
    const increment = Number(value) === (enumsOf(volumeSelector).INCREMENT ?? 0);
    await this.runCommand(
      increment ? 'volume up' : 'volume down',
      () => (increment ? this.client.volumeUp(DEFAULT_VOLUME_STEP) : this.client.volumeDown(DEFAULT_VOLUME_STEP)),
      true,
    );
    void this.poll();
  }

  private async handleVolumeSet(value: CharacteristicValue): Promise<void> {
    const volume = Math.max(0, Math.min(100, Math.round(Number(value))));
    await this.runCommand(`set volume to ${volume}`, () => this.client.setVolume(volume), true);
  }

  private async handleMuteSet(value: CharacteristicValue): Promise<void> {
    const muted = value === true;
    await this.runCommand(muted ? 'mute' : 'unmute', () => this.client.setMute(muted), true);
    void this.poll();
  }

  /**
   * Run an OwnTone command, converting failures into a HomeKit-visible error
   * when `throwOnFailure` is set. Never rejects with a raw network error.
   */
  private async runCommand(label: string, action: () => Promise<void>, throwOnFailure = false): Promise<boolean> {
    try {
      await action();
      this.platform.log.debug('"%s": %s succeeded.', this.config.name, label);
      return true;
    } catch (error) {
      if (error instanceof UnsupportedFeatureError) {
        this.platform.log.warn('"%s": %s is not supported by this OwnTone server (%s).', this.config.name, label, error.message);
      } else {
        this.platform.log.warn('"%s": %s failed: %s', this.config.name, label, describeError(error));
      }

      if (throwOnFailure) {
        this.throwCommunicationFailure();
      }
      return false;
    }
  }

  private throwCommunicationFailure(): never {
    const hap = this.platform.api.hap as unknown as {
      HapStatusError?: new (status: number) => Error;
      HAPStatus?: Record<string, number>;
    };

    const status = hap.HAPStatus?.SERVICE_COMMUNICATION_FAILURE ?? -70402;
    if (hap.HapStatusError) {
      throw new hap.HapStatusError(status);
    }
    throw new Error('OwnTone command failed');
  }

  /* -------------------------------------------------------------------- *
   * Polling
   * -------------------------------------------------------------------- */

  private startPolling(): void {
    void this.poll();
    this.restartPollTimer();
  }

  /**
   * (Re)creates the poll timer at whichever cadence currently applies.
   * While the push-notification WebSocket is connected, that's just an
   * infrequent reconciliation safety net (`WEBSOCKET_RECONCILE_INTERVAL_MS`)
   * since state changes arrive via `onEvent` instead; otherwise it's the
   * configured `pollingInterval`, same as before push support existed.
   * Called on startup and whenever the WebSocket connects/disconnects.
   */
  private restartPollTimer(): void {
    if (this.disposed) {
      return;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    const intervalMs = this.wsConnected ? WEBSOCKET_RECONCILE_INTERVAL_MS : this.config.pollingInterval * 1000;
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.polling) {
      this.platform.log.debug('"%s": previous poll still running, skipping this cycle.', this.config.name);
      return;
    }

    this.polling = true;
    this.platform.log.debug('"%s": polling %s.', this.config.name, this.client.description);
    try {
      const player = await this.client.getStatus();

      let track: TrackSnapshot | undefined;
      let outputs: OutputSnapshot[] | undefined;

      // Stopped means nothing is playing and there's nothing new to say
      // about which output is in use, so skip both extra requests — one
      // round trip to OwnTone instead of three, every poll.
      if (player.state !== 'stop') {
        try {
          track = await this.client.getNowPlaying();
        } catch (error) {
          // Metadata is optional — a failure here must not mark the whole
          // server unreachable.
          this.throttle.log('nowplaying', (message) => this.platform.log.debug(message), `"${this.config.name}": could not read now-playing metadata: ${describeError(error)}`);
        }

        // Refreshed every poll, same cadence as player/track state, so the
        // active HomeKit input tracks the currently-selected output even when
        // it's changed outside Homebridge (e.g. from the OwnTone web UI).
        try {
          outputs = await this.client.getOutputs();
        } catch (error) {
          this.throttle.log('outputs', (message) => this.platform.log.debug(message), `"${this.config.name}": could not read outputs: ${describeError(error)}`);
        }
      }

      this.onPollSuccess(player, track, outputs);
    } catch (error) {
      this.onPollFailure(error);
    } finally {
      this.polling = false;
    }
  }

  private onPollSuccess(player: PlayerSnapshot, track: TrackSnapshot | undefined, outputs: OutputSnapshot[] | undefined): void {
    const wasUnreachable = !this.reachable;

    this.consecutiveFailures = 0;
    this.reachable = true;
    this.throttle.reset('poll');

    if (wasUnreachable) {
      this.platform.log.info('"%s": OwnTone server at %s is reachable.', this.config.name, this.client.description);
    }

    this.player = player;
    this.logTrackChange(track);
    this.track = track;

    if (outputs) {
      this.syncInputSources(outputs);
    }

    this.pushStateToHomeKit();
    void this.refreshArtwork();

    this.platform.log.info('"%s": poll complete — %s', this.config.name, this.describeTrack(this.track));
  }

  private onPollFailure(error: unknown): void {
    this.consecutiveFailures += 1;

    const message =
      error instanceof UnsupportedFeatureError
        ? `"${this.config.name}": ${this.client.description} did not recognise the OwnTone player API — is this really an OwnTone server? (${error.message})`
        : `"${this.config.name}": OwnTone server at ${this.client.description} is unreachable: ${describeError(error)}`;

    this.throttle.log('poll', (text) => this.platform.log.warn(text), message);

    if (this.consecutiveFailures >= FAILURE_THRESHOLD && this.reachable) {
      this.platform.log.warn(
        '"%s": marking accessory as unavailable after %d consecutive failures.',
        this.config.name,
        this.consecutiveFailures,
      );
    }

    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.reachable = false;
      this.player = undefined;
      this.track = undefined;
      this.pushStateToHomeKit();
    }
  }

  private pushStateToHomeKit(): void {
    const { Characteristic } = this.platform;

    this.updateIfChanged(this.televisionService, Characteristic.Active, this.currentActiveState());
    this.updateIfChanged(this.televisionService, Characteristic.ActiveIdentifier, this.activeIdentifier);
    this.updateIfChanged(this.speakerService, Characteristic.Mute, this.currentMuteState());

    if (this.playPauseSwitchService) {
      this.updateIfChanged(this.playPauseSwitchService, Characteristic.On, this.isPlaying);
    }

    const volumeCharacteristic = this.optionalCharacteristic('Volume');
    if (volumeCharacteristic) {
      this.updateIfChanged(this.speakerService, volumeCharacteristic, this.player?.volume ?? 0);
    }
  }

  private updateIfChanged(service: Service, characteristic: CharacteristicCtor, value: CharacteristicValue): void {
    try {
      const current = service.getCharacteristic(characteristic).value;
      if (current !== value) {
        service.updateCharacteristic(characteristic, value);
      }
    } catch (error) {
      this.platform.log.debug('"%s": could not update characteristic: %s', this.config.name, describeError(error));
    }
  }

  /** Add/refresh one InputSource per OwnTone output and track the selected one. */
  private syncInputSources(outputs: OutputSnapshot[]): void {
    this.outputs = outputs;

    outputs.forEach((output, index) => {
      const identifier = index + 2; // identifier 1 is the generic source
      const label = sanitizeHapName(output.type ? `${output.name} (${output.type})` : output.name);

      let entry = this.inputs.find((input) => input.identifier === identifier);
      if (!entry) {
        entry = { identifier, outputId: output.id, service: this.ensureInputService(identifier, label) };
        this.inputs.push(entry);
        this.platform.log.debug('"%s": discovered OwnTone output "%s" as input %d.', this.config.name, output.name, identifier);
      } else {
        entry.outputId = output.id;
        this.setIfSupported(entry.service, 'ConfiguredName', label);
      }
    });

    const selected = outputs.filter((output) => output.selected);
    if (selected.length === 1) {
      const index = outputs.findIndex((output) => output.id === selected[0].id);
      this.activeIdentifier = index >= 0 ? index + 2 : DEFAULT_INPUT_IDENTIFIER;
    } else {
      // Zero or several outputs enabled — neither maps onto a single HomeKit
      // input, so fall back to the generic source.
      this.activeIdentifier = DEFAULT_INPUT_IDENTIFIER;
    }
  }

  /* -------------------------------------------------------------------- *
   * Metadata & artwork
   * -------------------------------------------------------------------- */

  private logTrackChange(track: TrackSnapshot | undefined): void {
    const previous = trackKey(this.track);
    const next = trackKey(track);
    if (previous === next) {
      return;
    }

    this.platform.log.debug('"%s": %s', this.config.name, this.describeTrack(track));
  }

  private describeTrack(track: TrackSnapshot | undefined): string {
    if (!track) {
      return 'nothing playing.';
    }

    return (
      `now playing "${track.title ?? 'unknown title'}" by "${track.artist ?? 'unknown artist'}" ` +
      `from "${track.album ?? 'unknown album'}" (${this.player?.state ?? 'unknown state'}, ` +
      `${formatDuration(this.player?.progressMs, track.durationMs ?? this.player?.lengthMs)})`
    );
  }

  /**
   * Fetch the current track's artwork once per track. HomeKit has no
   * characteristic for cover art, so this is kept in memory for logging and
   * potential future use only — see the README.
   */
  private async refreshArtwork(): Promise<void> {
    const key = trackKey(this.track);

    if (key === this.artworkTrackKey) {
      return;
    }
    this.artworkTrackKey = key;

      const url = this.client.resolveArtworkUrl(this.track?.artworkUrl);
    if (!url) {
      this.artwork = undefined;
      return;
    }

    try {
      const { contentType, byteLength } = await this.client.fetchArtwork(url);
      this.artwork = { url, contentType, byteLength };
      this.platform.log.debug('"%s": cached artwork %s (%s, %d bytes)', this.config.name, url, contentType ?? 'unknown type', byteLength);
    } catch (error) {
      this.artwork = undefined;
      this.throttle.log('artwork', (message) => this.platform.log.debug(message), `"${this.config.name}": artwork could not be fetched: ${describeError(error)}`);
    }
  }

  /**
   * Runs once at startup: records the OwnTone version as the accessory's
   * firmware revision, and — if the server advertises a websocket port —
   * connects the push-notification client. Both come from the same
   * `/api/config` call to avoid a second request.
   */
  private async loadFirmwareRevision(): Promise<void> {
    try {
      const config = await this.client.getConfig();

      const version = typeof config?.version === 'string' && config.version.trim() ? config.version.trim() : undefined;
      if (version) {
        const information = this.accessory.getService(this.platform.Service.AccessoryInformation);
        if (information) {
          this.setIfSupported(information, 'FirmwareRevision', version);
        }
        this.platform.log.info('"%s": connected to OwnTone %s at %s', this.config.name, version, this.client.description);
      }

      this.connectPushClientIfSupported(config);
    } catch (error) {
      this.platform.log.debug('"%s": could not read the OwnTone version: %s', this.config.name, describeError(error));
    }
  }

  /**
   * Connects the push-notification WebSocket when `/api/config` says the
   * server supports it. Per OwnTone's JSON API docs, `websocket_port` is
   * always present in that response — it's `0` when the server wasn't
   * built with (or has disabled) websocket support, and the actual port
   * otherwise. Either way this is a one-time check at startup: servers
   * without support just fall back to polling at `config.pollingInterval`,
   * identical to before push support existed.
   */
  private connectPushClientIfSupported(config: OwnToneConfigResponse): void {
    if (!this.config.enableWebSocket) {
      this.platform.log.debug('"%s": push notifications disabled by config.', this.config.name);
      return;
    }

    const port = config.websocket_port;
    if (!Number.isInteger(port) || (port as number) <= 0) {
      this.platform.log.info('"%s": OwnTone server does not advertise WebSocket support; using polling only.', this.config.name);
      return;
    }

    this.pushClient = this.pushClientFactory({
      protocol: this.config.protocol === 'https' ? 'wss' : 'ws',
      host: this.config.host,
      port: port as number,
      categories: ['player', 'volume', 'outputs', 'queue', 'options'],
      onEvent: () => void this.poll(),
      onConnectionChange: (connected) => this.handlePushConnectionChange(connected),
      log: this.platform.log,
    });
    this.pushClient.connect();
  }

  /** Switches the poll timer between the fast configured interval and the slow WebSocket-connected reconciliation interval. */
  private handlePushConnectionChange(connected: boolean): void {
    if (this.wsConnected === connected) {
      return;
    }
    this.wsConnected = connected;
    this.restartPollTimer();

    if (this.pushRefreshTimer) {
      clearInterval(this.pushRefreshTimer);
      this.pushRefreshTimer = undefined;
    }

    if (connected) {
      // Belt-and-suspenders for a process that may run for months: forces a
      // fresh connection periodically, since a socket stuck "open" while
      // actually dead never fires close/error and would otherwise never be
      // detected (see OwnTonePushClient.reconnect()). User-configurable via
      // pushReconnectInterval — has no effect at all while disconnected,
      // since it's only (re)started here, on transitioning to connected.
      const intervalMs = this.config.pushReconnectInterval * 60_000;
      this.pushRefreshTimer = setInterval(() => this.pushClient?.reconnect(), intervalMs);
      if (typeof this.pushRefreshTimer.unref === 'function') {
        this.pushRefreshTimer.unref();
      }
    }
  }

  /* -------------------------------------------------------------------- *
   * Defensive HAP helpers
   * -------------------------------------------------------------------- */

  /**
   * Look a characteristic constructor up by name so the plugin keeps working
   * on HAP versions where it does not exist (Homebridge 1.x vs 2.x).
   */
  private optionalCharacteristic(name: string): CharacteristicCtor | undefined {
    const candidate = (this.platform.Characteristic as unknown as Record<string, unknown>)[name];
    return typeof candidate === 'function' ? (candidate as CharacteristicCtor) : undefined;
  }

  /** `setCharacteristic`, but a no-op when the characteristic does not exist. */
  private setIfSupported(service: Service, name: string, value: CharacteristicValue): void {
    const characteristic = this.optionalCharacteristic(name);
    if (!characteristic) {
      this.platform.log.debug('"%s": characteristic %s is unavailable in this HAP version.', this.config.name, name);
      return;
    }
    try {
      service.setCharacteristic(characteristic, value);
    } catch (error) {
      this.platform.log.debug('"%s": could not set %s: %s', this.config.name, name, describeError(error));
    }
  }
}

/** Read the numeric enum constants declared on a characteristic constructor. */
function enumsOf(characteristic: CharacteristicCtor): Record<string, number | undefined> {
  return characteristic as unknown as Record<string, number | undefined>;
}

function trackKey(track: TrackSnapshot | undefined): string {
  if (!track) {
    return '';
  }
  return [track.itemId ?? '', track.trackId ?? '', track.title ?? '', track.album ?? '', track.artworkUrl ?? ''].join('|');
}

function formatDuration(progressMs: number | undefined, durationMs: number | undefined): string {
  if (!durationMs) {
    return 'unknown length';
  }
  return `${formatMs(progressMs ?? 0)}/${formatMs(durationMs)}`;
}

function formatMs(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
