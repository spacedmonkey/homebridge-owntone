import {
  OwnToneApiError,
  OwnToneClient,
  OwnToneNetworkError,
  UnsupportedFeatureError,
  type FetchLike,
} from '../src/owntoneClient';
import { DEFAULT_PORT, DEFAULT_TIMEOUT } from '../src/settings';

interface FakeResponseInit {
  status?: number;
  body?: unknown;
  /** Return a body that fails to parse as JSON. */
  malformed?: boolean;
  contentType?: string;
  bytes?: number;
}

function fakeResponse({ status = 200, body, malformed, contentType, bytes = 0 }: FakeResponseInit = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? (contentType ?? null) : null),
    },
    json: async () => {
      if (malformed) {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      }
      return body;
    },
    arrayBuffer: async () => new ArrayBuffer(bytes),
  } as unknown as Response;
}

function createClient(
  overrides: Partial<ConstructorParameters<typeof OwnToneClient>[0]> = {},
  fetchImpl: jest.MockedFunction<FetchLike> = jest.fn(),
): { client: OwnToneClient; fetchImpl: jest.MockedFunction<FetchLike> } {
  const client = new OwnToneClient({
    protocol: 'http',
    host: '192.168.1.50',
    port: DEFAULT_PORT,
    timeout: DEFAULT_TIMEOUT,
    fetchImpl,
    ...overrides,
  });
  return { client, fetchImpl };
}

/** Convenience: last URL and init the mocked fetch was called with. */
function lastCall(fetchImpl: jest.MockedFunction<FetchLike>): { url: string; init: RequestInit } {
  const call = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1];
  return { url: call[0], init: (call[1] ?? {}) as RequestInit };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe('OwnToneClient — URL building', () => {
  it('builds an http base URL with the default OwnTone port', () => {
    const { client } = createClient();
    expect(client.baseUrl).toBe('http://192.168.1.50:3689');
    expect(client.description).toBe('http://192.168.1.50:3689');
  });

  it('builds an https base URL with a custom port', () => {
    const { client } = createClient({ protocol: 'https', host: 'owntone.local', port: 8443 });
    expect(client.baseUrl).toBe('https://owntone.local:8443');
  });

  it('requests the documented player endpoint', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ body: { state: 'play' } }));

    await client.getStatus();

    expect(lastCall(fetchImpl).url).toBe('http://192.168.1.50:3689/api/player');
    expect(lastCall(fetchImpl).init.method).toBe('GET');
  });

  it('encodes query parameters', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.setVolume(42);

    expect(lastCall(fetchImpl).url).toBe('http://192.168.1.50:3689/api/player/volume?volume=42');
  });
});

describe('OwnToneClient — request options', () => {
  it('attaches an abort signal so every request has a timeout', async () => {
    const { client, fetchImpl } = createClient({ timeout: 1234 });
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.play();

    expect(lastCall(fetchImpl).init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a timeout as an OwnToneNetworkError', async () => {
    const hangingFetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted due to timeout');
          error.name = 'TimeoutError';
          reject(error);
        });
      }),
    );
    const { client } = createClient({ timeout: 20 }, hangingFetch);

    await expect(client.getStatus()).rejects.toBeInstanceOf(OwnToneNetworkError);
  });

  it('sends no Authorization header when no credentials are configured', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.play();

    expect(headerOf(lastCall(fetchImpl).init, 'Authorization')).toBeUndefined();
  });

  it('adds a basic auth header when username and password are set', async () => {
    const { client, fetchImpl } = createClient({ username: 'alice', password: 's3cret' });
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.play();

    const expected = `Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}`;
    expect(headerOf(lastCall(fetchImpl).init, 'Authorization')).toBe(expected);
  });

  it('adds a bearer token header and prefers it over basic auth', async () => {
    const { client, fetchImpl } = createClient({ username: 'alice', password: 's3cret', bearerToken: 'tok123' });
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.play();

    expect(headerOf(lastCall(fetchImpl).init, 'Authorization')).toBe('Bearer tok123');
  });

  it('serialises JSON bodies with a matching content type', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.selectOutputsExclusively(['1', '2']);

    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe('http://192.168.1.50:3689/api/outputs/set');
    expect(init.method).toBe('PUT');
    expect(headerOf(init, 'Content-Type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ outputs: ['1', '2'] }));
  });
});

describe('OwnToneClient — error handling', () => {
  it('rejects with OwnToneNetworkError when the connection is refused', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }));

    await expect(client.getStatus()).rejects.toBeInstanceOf(OwnToneNetworkError);
  });

  it('does not produce an unhandled rejection for a failed request', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockRejectedValue(new Error('getaddrinfo ENOTFOUND owntone.local'));

    const caught = await client.getStatus().then(
      () => 'resolved',
      (error) => error,
    );
    expect(caught).toBeInstanceOf(OwnToneNetworkError);
    expect((caught as Error).message).toContain('ENOTFOUND');
  });

  it('maps HTTP 404 to UnsupportedFeatureError', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 404 }));

    await expect(client.stop()).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it('maps other non-2xx responses to OwnToneApiError with the status code', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 500 }));

    await expect(client.getStatus()).rejects.toMatchObject({ name: 'OwnToneApiError', status: 500 });
  });

  it('maps a malformed JSON body to OwnToneApiError', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ malformed: true }));

    await expect(client.getStatus()).rejects.toBeInstanceOf(OwnToneApiError);
  });

  it('fails clearly when no fetch implementation exists', async () => {
    const client = new OwnToneClient({ protocol: 'http', host: 'h', port: 1, timeout: 10, fetchImpl: undefined });
    const originalFetch = globalThis.fetch;
    // @ts-expect-error deliberately removing fetch to emulate an old runtime
    delete globalThis.fetch;
    try {
      await expect(client.getStatus()).rejects.toBeInstanceOf(OwnToneNetworkError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('OwnToneClient — parsing', () => {
  it('normalises a player status response', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(
      fakeResponse({
        body: {
          state: 'play',
          repeat: 'all',
          consume: false,
          shuffle: true,
          volume: 55,
          item_id: 269,
          item_length_ms: 278093,
          item_progress_ms: 3674,
        },
      }),
    );

    await expect(client.getStatus()).resolves.toEqual({
      state: 'play',
      repeat: 'all',
      consume: false,
      shuffle: true,
      volume: 55,
      itemId: 269,
      progressMs: 3674,
      lengthMs: 278093,
    });
  });

  it('falls back to safe defaults for a partial player response', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ body: {} }));

    await expect(client.getStatus()).resolves.toEqual({
      state: 'stop',
      repeat: 'off',
      consume: false,
      shuffle: false,
      volume: 0,
      itemId: 0,
      progressMs: 0,
      lengthMs: 0,
    });
  });

  it('clamps out-of-range volumes', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ body: { state: 'play', volume: 250 } }));

    await expect(client.getStatus()).resolves.toMatchObject({ volume: 100 });
  });

  it('parses now-playing metadata from the queue endpoint', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(
      fakeResponse({
        body: {
          version: 833,
          count: 1,
          items: [
            {
              id: 12122,
              track_id: 10749,
              title: 'Angels',
              artist: 'The xx',
              album: 'Coexist',
              album_artist: 'The xx',
              length_ms: 171735,
              artwork_url: '/artwork/item/12122',
              uri: 'library:track:10749',
            },
          ],
        },
      }),
    );

    await expect(client.getNowPlaying()).resolves.toEqual({
      itemId: 12122,
      trackId: 10749,
      title: 'Angels',
      artist: 'The xx',
      album: 'Coexist',
      albumArtist: 'The xx',
      genre: undefined,
      artworkUrl: '/artwork/item/12122',
      durationMs: 171735,
      uri: 'library:track:10749',
    });

    expect(lastCall(fetchImpl).url).toBe('http://192.168.1.50:3689/api/queue?id=now_playing');
  });

  it('returns undefined when the queue is empty', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ body: { version: 1, count: 0, items: [] } }));

    await expect(client.getNowPlaying()).resolves.toBeUndefined();
  });

  it('handles a queue response with missing fields without throwing', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ body: { items: [{ id: 5, title: '   ' }] } }));

    await expect(client.getNowPlaying()).resolves.toEqual({
      itemId: 5,
      trackId: undefined,
      title: undefined,
      artist: undefined,
      album: undefined,
      albumArtist: undefined,
      genre: undefined,
      artworkUrl: undefined,
      durationMs: undefined,
      uri: undefined,
    });
  });

  it('tolerates a queue response with no items array at all', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ body: {} }));

    await expect(client.getNowPlaying()).resolves.toBeUndefined();
  });

  it('normalises the outputs list', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(
      fakeResponse({
        body: {
          outputs: [
            { id: '123', name: 'Kitchen', type: 'AirPlay', selected: true, volume: 50 },
            { id: '0', name: '', type: 'ALSA', selected: false, volume: 'bad' },
          ],
        },
      }),
    );

    await expect(client.getOutputs()).resolves.toEqual([
      { id: '123', name: 'Kitchen', type: 'AirPlay', selected: true, volume: 50 },
      { id: '0', name: 'Output 0', type: 'ALSA', selected: false, volume: 0 },
    ]);
  });

  it('returns an empty outputs list when the server sends nothing usable', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ body: {} }));

    await expect(client.getOutputs()).resolves.toEqual([]);
  });

  it('reads the server version from /api/config', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ body: { version: '28.4', websocket_port: 3688 } }));

    await expect(client.getConfig()).resolves.toMatchObject({ version: '28.4' });
    expect(lastCall(fetchImpl).url).toBe('http://192.168.1.50:3689/api/config');
  });
});

describe('OwnToneClient — playback commands', () => {
  const commands: Array<[keyof OwnToneClient, string]> = [
    ['play', '/api/player/play'],
    ['pause', '/api/player/pause'],
    ['stop', '/api/player/stop'],
    ['toggle', '/api/player/toggle'],
    ['next', '/api/player/next'],
    ['previous', '/api/player/previous'],
  ];

  it.each(commands)('%s issues PUT %s', async (method, path) => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await (client[method] as () => Promise<void>)();

    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe(`http://192.168.1.50:3689${path}`);
    expect(init.method).toBe('PUT');
  });

  it('seeks relatively via seek_ms', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.seekRelative(-10000);

    expect(lastCall(fetchImpl).url).toBe('http://192.168.1.50:3689/api/player/seek?seek_ms=-10000');
  });
});

describe('OwnToneClient — volume', () => {
  it('clamps absolute volume into 0-100', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.setVolume(140);

    expect(lastCall(fetchImpl).url).toContain('volume=100');
  });

  it('targets a single output when an output id is given', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.setVolume(30, '123');

    expect(lastCall(fetchImpl).url).toBe('http://192.168.1.50:3689/api/player/volume?volume=30&output_id=123');
  });

  it('sends a positive step for volumeUp and a negative one for volumeDown', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.volumeUp(7);
    expect(lastCall(fetchImpl).url).toBe('http://192.168.1.50:3689/api/player/volume?step=7');

    await client.volumeDown(7);
    expect(lastCall(fetchImpl).url).toBe('http://192.168.1.50:3689/api/player/volume?step=-7');
  });

  it('emulates mute by remembering and restoring the volume', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockImplementation(async (url) => {
      if (url.endsWith('/api/player')) {
        return fakeResponse({ body: { state: 'play', volume: 63 } });
      }
      return fakeResponse({ status: 204 });
    });

    expect(client.muteIsEmulated).toBe(true);

    await client.setMute(true);
    expect(lastCall(fetchImpl).url).toContain('volume=0');

    await client.setMute(false);
    expect(lastCall(fetchImpl).url).toContain('volume=63');
  });

  it('unmutes to a fallback volume when nothing was remembered', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.setMute(false, 25);

    expect(lastCall(fetchImpl).url).toContain('volume=25');
  });
});

describe('OwnToneClient — outputs', () => {
  it('updates a single output', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 204 }));

    await client.updateOutput('12 34', { selected: true, volume: 20 });

    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe('http://192.168.1.50:3689/api/outputs/12%2034');
    expect(init.body).toBe(JSON.stringify({ selected: true, volume: 20 }));
  });
});

describe('OwnToneClient — artwork', () => {
  it('resolves a relative artwork url against the server and adds size hints', () => {
    const { client } = createClient();
    const url = client.resolveArtworkUrl('/artwork/item/12122');
    expect(url).toBe('http://192.168.1.50:3689/artwork/item/12122?maxwidth=512&maxheight=512');
  });

  it('passes an absolute artwork url through unchanged', () => {
    const { client } = createClient();
    expect(client.resolveArtworkUrl('https://cdn.example.com/cover.jpg')).toBe('https://cdn.example.com/cover.jpg');
  });

  it('returns undefined for a missing artwork url', () => {
    const { client } = createClient();
    expect(client.resolveArtworkUrl(undefined)).toBeUndefined();
  });

  it('downloads artwork and reports its size', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ contentType: 'image/png', bytes: 2048 }));

    await expect(client.fetchArtwork('http://192.168.1.50:3689/artwork/item/1')).resolves.toEqual({
      contentType: 'image/png',
      byteLength: 2048,
    });
  });

  it('rejects when artwork is missing', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(fakeResponse({ status: 404 }));

    await expect(client.fetchArtwork('http://192.168.1.50:3689/artwork/item/1')).rejects.toBeInstanceOf(OwnToneApiError);
  });
});
