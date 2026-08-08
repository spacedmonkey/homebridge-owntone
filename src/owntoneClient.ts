import { DEFAULT_VOLUME_STEP } from './settings';
import type {
  OutputSnapshot,
  OwnToneConfigResponse,
  OwnToneOutput,
  OwnToneOutputsResponse,
  OwnTonePlayerResponse,
  OwnToneQueueItem,
  OwnToneQueueResponse,
  PlayerSnapshot,
  Protocol,
  TrackSnapshot,
} from './types';

/** The subset of `fetch` this client relies on; injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Thrown when the OwnTone server answers with a non-2xx status. */
export class OwnToneApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OwnToneApiError';
  }
}

/** Thrown when a request could not be completed at all (DNS, refused, timeout). */
export class OwnToneNetworkError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OwnToneNetworkError';
  }
}

/**
 * Thrown when OwnTone does not implement the requested feature — either
 * because the endpoint is missing on this server version (HTTP 404) or
 * because the JSON API has no equivalent at all.
 */
export class UnsupportedFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFeatureError';
  }
}

export interface OwnToneClientOptions {
  protocol: Protocol;
  host: string;
  port: number;
  /** Per-request timeout in milliseconds. */
  timeout: number;
  username?: string;
  password?: string;
  bearerToken?: string;
  ignoreCertificateErrors?: boolean;
  /** Override the global `fetch`; used by the test-suite. */
  fetchImpl?: FetchLike;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Parse the response body as JSON. Defaults to `false`. */
  json?: boolean;
}

/**
 * Thin, fully typed wrapper around the OwnTone JSON API.
 *
 * Every method rejects with one of {@link OwnToneApiError},
 * {@link OwnToneNetworkError} or {@link UnsupportedFeatureError}; callers are
 * expected to catch. The client itself never logs and never throws
 * synchronously.
 *
 * @see https://owntone.github.io/owntone-server/json-api/
 */
export class OwnToneClient {
  /** e.g. `http://192.168.1.50:3689` — never contains credentials. */
  readonly baseUrl: string;

  private insecureDispatcher?: unknown;
  private volumeBeforeMute?: number;

  constructor(private readonly options: OwnToneClientOptions) {
    this.baseUrl = `${options.protocol}://${options.host}:${options.port}`;
  }

  /** Safe-to-log description of the target server. */
  get description(): string {
    return this.baseUrl;
  }

  /* -------------------------------------------------------------------- *
   * Reads
   * -------------------------------------------------------------------- */

  /** `GET /api/config` — server version and build options. */
  async getConfig(): Promise<OwnToneConfigResponse> {
    return (await this.request('GET', '/api/config', { json: true })) as OwnToneConfigResponse;
  }

  /** `GET /api/player` — normalised playback state. */
  async getStatus(): Promise<PlayerSnapshot> {
    const raw = (await this.request('GET', '/api/player', { json: true })) as Partial<OwnTonePlayerResponse>;
    return normalisePlayer(raw);
  }

  /**
   * `GET /api/queue?id=now_playing` — metadata of the track currently loaded.
   * Resolves to `undefined` when the queue is empty or the server returns no
   * usable item, rather than throwing.
   */
  async getNowPlaying(): Promise<TrackSnapshot | undefined> {
    const raw = (await this.request('GET', '/api/queue', {
      query: { id: 'now_playing' },
      json: true,
    })) as Partial<OwnToneQueueResponse>;

    const item = Array.isArray(raw?.items) ? raw.items[0] : undefined;
    return item ? normaliseTrack(item) : undefined;
  }

  /** `GET /api/outputs` — the speakers OwnTone knows about. */
  async getOutputs(): Promise<OutputSnapshot[]> {
    const raw = (await this.request('GET', '/api/outputs', { json: true })) as Partial<OwnToneOutputsResponse>;
    const outputs = Array.isArray(raw?.outputs) ? raw.outputs : [];
    return outputs.filter((output): output is OwnToneOutput => !!output && output.id !== undefined).map(normaliseOutput);
  }

  /* -------------------------------------------------------------------- *
   * Playback control
   * -------------------------------------------------------------------- */

  /** `PUT /api/player/play` */
  async play(): Promise<void> {
    await this.request('PUT', '/api/player/play');
  }

  /** `PUT /api/player/pause` */
  async pause(): Promise<void> {
    await this.request('PUT', '/api/player/pause');
  }

  /** `PUT /api/player/stop` */
  async stop(): Promise<void> {
    await this.request('PUT', '/api/player/stop');
  }

  /** `PUT /api/player/toggle` */
  async toggle(): Promise<void> {
    await this.request('PUT', '/api/player/toggle');
  }

  /** `PUT /api/player/next` */
  async next(): Promise<void> {
    await this.request('PUT', '/api/player/next');
  }

  /** `PUT /api/player/previous` */
  async previous(): Promise<void> {
    await this.request('PUT', '/api/player/previous');
  }

  /**
   * `PUT /api/player/seek?seek_ms=…` — seek relative to the current position.
   * Negative values rewind.
   */
  async seekRelative(offsetMs: number): Promise<void> {
    await this.request('PUT', '/api/player/seek', { query: { seek_ms: Math.trunc(offsetMs) } });
  }

  /* -------------------------------------------------------------------- *
   * Volume
   * -------------------------------------------------------------------- */

  /**
   * `PUT /api/player/volume?volume=…` — absolute master volume (0-100), or the
   * volume of a single output when `outputId` is given.
   */
  async setVolume(volume: number, outputId?: string): Promise<void> {
    await this.request('PUT', '/api/player/volume', {
      query: { volume: clampVolume(volume), output_id: outputId },
    });
  }

  /** `PUT /api/player/volume?step=…` — relative volume change (-100 to 100). */
  async changeVolume(step: number, outputId?: string): Promise<void> {
    const clamped = Math.max(-100, Math.min(100, Math.trunc(step)));
    await this.request('PUT', '/api/player/volume', {
      query: { step: clamped, output_id: outputId },
    });
  }

  /** Convenience wrapper around {@link changeVolume}. */
  async volumeUp(step: number = DEFAULT_VOLUME_STEP): Promise<void> {
    await this.changeVolume(Math.abs(step));
  }

  /** Convenience wrapper around {@link changeVolume}. */
  async volumeDown(step: number = DEFAULT_VOLUME_STEP): Promise<void> {
    await this.changeVolume(-Math.abs(step));
  }

  /**
   * OwnTone's JSON API has **no mute endpoint**, so muting is emulated: the
   * current volume is remembered and the master volume is set to 0; unmuting
   * restores the remembered value.
   *
   * @param fallbackVolume Volume to restore when nothing was remembered
   *   (for example after a Homebridge restart while muted).
   */
  async setMute(muted: boolean, fallbackVolume = DEFAULT_VOLUME_STEP * 4): Promise<void> {
    if (muted) {
      const status = await this.getStatus();
      if (status.volume > 0) {
        this.volumeBeforeMute = status.volume;
      }
      await this.setVolume(0);
      return;
    }

    await this.setVolume(this.volumeBeforeMute ?? clampVolume(fallbackVolume));
    this.volumeBeforeMute = undefined;
  }

  /** True when muting is emulated rather than natively supported. */
  get muteIsEmulated(): boolean {
    return true;
  }

  /* -------------------------------------------------------------------- *
   * Outputs
   * -------------------------------------------------------------------- */

  /**
   * `PUT /api/outputs/set` — enable exactly the given outputs and disable
   * every other one.
   */
  async selectOutputsExclusively(outputIds: string[]): Promise<void> {
    await this.request('PUT', '/api/outputs/set', { body: { outputs: outputIds } });
  }

  /** `PUT /api/outputs/{id}` — enable/disable a single output or set its volume. */
  async updateOutput(outputId: string, changes: { selected?: boolean; volume?: number }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (changes.selected !== undefined) {
      body.selected = changes.selected;
    }
    if (changes.volume !== undefined) {
      body.volume = clampVolume(changes.volume);
    }
    await this.request('PUT', `/api/outputs/${encodeURIComponent(outputId)}`, { body });
  }

  /* -------------------------------------------------------------------- *
   * Artwork
   * -------------------------------------------------------------------- */

  /**
   * Turn the `artwork_url` reported by OwnTone into an absolute URL.
   *
   * Relative values (e.g. `/artwork/item/1`) are resolved against the server
   * base URL and get `maxwidth`/`maxheight` hints appended; absolute values
   * (external cover art) are returned unchanged. Returns `undefined` for
   * missing or unparsable values.
   */
  resolveArtworkUrl(artworkUrl: string | undefined, maxSize = 512): string | undefined {
    if (!artworkUrl) {
      return undefined;
    }

    try {
      if (/^https?:\/\//i.test(artworkUrl)) {
        return new URL(artworkUrl).toString();
      }
      const url = new URL(artworkUrl, `${this.baseUrl}/`);
      url.searchParams.set('maxwidth', String(maxSize));
      url.searchParams.set('maxheight', String(maxSize));
      return url.toString();
    } catch {
      return undefined;
    }
  }

  /**
   * Download artwork bytes. Only used to confirm the artwork actually exists
   * and to record its size — OwnTone documents that an `artwork_url` "is not
   * guaranteed to exist".
   */
  async fetchArtwork(url: string): Promise<{ contentType?: string; byteLength: number }> {
    const response = await this.send('GET', url, {});
    if (!response.ok) {
      throw new OwnToneApiError(`Artwork request failed with HTTP ${response.status}`, response.status);
    }
    const buffer = await response.arrayBuffer();
    return {
      contentType: response.headers.get('content-type') ?? undefined,
      byteLength: buffer.byteLength,
    };
  }

  /* -------------------------------------------------------------------- *
   * Internals
   * -------------------------------------------------------------------- */

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }

    if (this.options.bearerToken) {
      headers.Authorization = `Bearer ${this.options.bearerToken}`;
    } else if (this.options.username !== undefined || this.options.password !== undefined) {
      const credentials = `${this.options.username ?? ''}:${this.options.password ?? ''}`;
      headers.Authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
    }

    return headers;
  }

  /**
   * Lazily build an undici dispatcher that accepts self-signed certificates.
   * Only constructed when the user opted in, so the TLS relaxation can never
   * leak into a normally configured server.
   */
  private getDispatcher(): unknown {
    if (!this.options.ignoreCertificateErrors || this.options.protocol !== 'https') {
      return undefined;
    }
    if (!this.insecureDispatcher) {
      // Required lazily: importing undici eagerly costs startup time for the
      // (common) case where certificate checks stay enabled.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Agent } = require('undici') as typeof import('undici');
      this.insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
    return this.insecureDispatcher;
  }

  private async send(method: string, url: string, options: RequestOptions): Promise<Response> {
    const fetchImpl: FetchLike | undefined = this.options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new OwnToneNetworkError('No fetch implementation available in this Node.js runtime');
    }

    const hasBody = options.body !== undefined;
    const init: RequestInit = {
      method,
      headers: this.buildHeaders(hasBody),
      signal: AbortSignal.timeout(this.options.timeout),
    };

    if (hasBody) {
      init.body = JSON.stringify(options.body);
    }

    const dispatcher = this.getDispatcher();
    if (dispatcher) {
      // `dispatcher` is an undici-only extension of RequestInit that Node's
      // global fetch honours; assigning it structurally avoids depending on
      // undici's nominal Dispatcher type, which does not match the copy
      // bundled with @types/node.
      Object.assign(init, { dispatcher });
    }

    try {
      return await fetchImpl(url, init);
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new OwnToneNetworkError(`Request to ${method} ${redact(url)} timed out after ${this.options.timeout}ms`, error);
      }
      throw new OwnToneNetworkError(`Request to ${method} ${redact(url)} failed: ${errorMessage(error)}`, error);
    }
  }

  private async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = this.buildUrl(path, options.query);
    const response = await this.send(method, url, options);

    if (response.status === 404) {
      throw new UnsupportedFeatureError(`${method} ${path} is not supported by the OwnTone server at ${this.baseUrl}`);
    }

    if (!response.ok) {
      throw new OwnToneApiError(`${method} ${path} failed with HTTP ${response.status}`, response.status);
    }

    if (!options.json || response.status === 204) {
      return undefined;
    }

    try {
      return await response.json();
    } catch (error) {
      throw new OwnToneApiError(`${method} ${path} returned a malformed JSON body: ${errorMessage(error)}`);
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Normalisation helpers — exported for the test-suite.
 * ------------------------------------------------------------------------ */

export function normalisePlayer(raw: Partial<OwnTonePlayerResponse> | null | undefined): PlayerSnapshot {
  const state = raw?.state;
  return {
    state: state === 'play' || state === 'pause' || state === 'stop' ? state : 'stop',
    volume: clampVolume(typeof raw?.volume === 'number' ? raw.volume : 0),
    repeat: raw?.repeat === 'all' || raw?.repeat === 'single' ? raw.repeat : 'off',
    shuffle: raw?.shuffle === true,
    consume: raw?.consume === true,
    itemId: typeof raw?.item_id === 'number' ? raw.item_id : 0,
    progressMs: typeof raw?.item_progress_ms === 'number' ? raw.item_progress_ms : 0,
    lengthMs: typeof raw?.item_length_ms === 'number' ? raw.item_length_ms : 0,
  };
}

export function normaliseTrack(raw: OwnToneQueueItem): TrackSnapshot {
  return {
    itemId: typeof raw.id === 'number' ? raw.id : undefined,
    trackId: typeof raw.track_id === 'number' ? raw.track_id : undefined,
    title: nonEmpty(raw.title),
    artist: nonEmpty(raw.artist),
    album: nonEmpty(raw.album),
    albumArtist: nonEmpty(raw.album_artist),
    genre: nonEmpty(raw.genre),
    artworkUrl: nonEmpty(raw.artwork_url),
    durationMs: typeof raw.length_ms === 'number' ? raw.length_ms : undefined,
    uri: nonEmpty(raw.uri),
  };
}

export function normaliseOutput(raw: OwnToneOutput): OutputSnapshot {
  return {
    id: String(raw.id),
    name: nonEmpty(raw.name) ?? `Output ${raw.id}`,
    type: nonEmpty(raw.type),
    selected: raw.selected === true,
    volume: clampVolume(typeof raw.volume === 'number' ? raw.volume : 0),
  };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(volume)));
}

/** Strip any credentials that a redirect or misconfiguration may have put in a URL. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
