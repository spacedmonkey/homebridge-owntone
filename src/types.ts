import type { PlatformConfig } from 'homebridge';

/** Supported transport protocols for the OwnTone JSON API. */
export type Protocol = 'http' | 'https';

/**
 * A single OwnTone server entry, exactly as it appears in the Homebridge
 * config (`platforms[].servers[]`). Everything except `name` and `host` is
 * optional; see {@link ResolvedServerConfig} for the defaulted shape used
 * internally.
 */
export interface OwnToneServerConfig {
  name: string;
  protocol?: Protocol;
  host: string;
  port?: number;
  pollingInterval?: number;
  timeout?: number;
  username?: string;
  password?: string;
  bearerToken?: string;
  ignoreCertificateErrors?: boolean;
  exposeTrackSwitches?: boolean;
}

/** The platform block of the Homebridge config. */
export interface OwnTonePlatformConfig extends PlatformConfig {
  servers?: OwnToneServerConfig[];
}

/**
 * A server config with all defaults applied and all values validated/clamped.
 * This is what the platform hands to accessories and clients.
 */
export interface ResolvedServerConfig {
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  /** Seconds. */
  pollingInterval: number;
  /** Milliseconds. */
  timeout: number;
  username?: string;
  password?: string;
  bearerToken?: string;
  ignoreCertificateErrors: boolean;
  exposeTrackSwitches: boolean;
}

/* ------------------------------------------------------------------------ *
 * Raw OwnTone JSON API response shapes.
 * https://owntone.github.io/owntone-server/json-api/
 * ------------------------------------------------------------------------ */

export type OwnTonePlayState = 'play' | 'pause' | 'stop';
export type OwnToneRepeatMode = 'off' | 'all' | 'single';

/** `GET /api/player` */
export interface OwnTonePlayerResponse {
  state: OwnTonePlayState;
  repeat: OwnToneRepeatMode;
  consume: boolean;
  shuffle: boolean;
  volume: number;
  item_id: number;
  item_length_ms: number;
  item_progress_ms: number;
}

/** An entry of `GET /api/queue` → `items[]`. */
export interface OwnToneQueueItem {
  id: number;
  position?: number;
  track_id?: number;
  title?: string;
  artist?: string;
  album?: string;
  album_artist?: string;
  genre?: string;
  year?: number;
  track_number?: number;
  disc_number?: number;
  length_ms?: number;
  media_kind?: string;
  data_kind?: string;
  path?: string;
  uri?: string;
  artwork_url?: string;
  type?: string;
  bitrate?: number;
  samplerate?: number;
  channels?: number;
}

/** `GET /api/queue` */
export interface OwnToneQueueResponse {
  version: number;
  count: number;
  items: OwnToneQueueItem[];
}

/** An entry of `GET /api/outputs` → `outputs[]`. */
export interface OwnToneOutput {
  id: string;
  name: string;
  type?: string;
  selected: boolean;
  has_password?: boolean;
  requires_auth?: boolean;
  needs_auth_key?: boolean;
  volume: number;
  offset_ms?: number;
  format?: string;
  supported_formats?: string[];
}

/** `GET /api/outputs` */
export interface OwnToneOutputsResponse {
  outputs: OwnToneOutput[];
}

/** `GET /api/config` */
export interface OwnToneConfigResponse {
  version: string;
  websocket_port?: number;
  buildoptions?: string[];
  library_name?: string;
}

/* ------------------------------------------------------------------------ *
 * Normalised internal models. HomeKit mapping only ever touches these, never
 * the raw API shapes above.
 * ------------------------------------------------------------------------ */

/** Normalised player state. */
export interface PlayerSnapshot {
  state: OwnTonePlayState;
  /** 0-100. */
  volume: number;
  repeat: OwnToneRepeatMode;
  shuffle: boolean;
  consume: boolean;
  /** Queue item id of the track currently loaded, or 0 when nothing is loaded. */
  itemId: number;
  progressMs: number;
  lengthMs: number;
}

/** Normalised now-playing metadata. All fields are best-effort. */
export interface TrackSnapshot {
  itemId?: number;
  trackId?: number;
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  /** Raw value straight from the API — may be relative to the server root. */
  artworkUrl?: string;
  durationMs?: number;
  uri?: string;
}

/** Normalised OwnTone output (speaker). */
export interface OutputSnapshot {
  id: string;
  name: string;
  type?: string;
  selected: boolean;
  volume: number;
}

/** Everything one poll cycle produced. */
export interface ServerSnapshot {
  reachable: boolean;
  player?: PlayerSnapshot;
  track?: TrackSnapshot;
  outputs?: OutputSnapshot[];
}

/** Cached artwork metadata for the current track. */
export interface ArtworkSnapshot {
  /** Absolute, fully-resolved URL. */
  url: string;
  contentType?: string;
  byteLength?: number;
}
