const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');

// Deliberately self-contained: this process is spawned from
// `homebridge-ui/server.js` directly, independent of how (or whether) the
// main plugin's `dist/` was built at this install path, so it must not
// require anything from `../dist`.
const DEFAULT_PORT = 3689;
const DEFAULT_TIMEOUT = 5000;

class OwnTonePluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/testConnection', this.testConnection.bind(this));
    this.ready();
  }

  /**
   * Hits `GET /api/config` on the target OwnTone server and reports whether
   * it answered with HTTP 200. Runs server-side (not in the browser) so it
   * can reach LAN hosts regardless of CORS/mixed-content restrictions.
   */
  async testConnection(payload = {}) {
    const host = typeof payload.host === 'string' ? payload.host.trim() : '';
    if (!host) {
      return { ok: false, message: 'Host is required.' };
    }

    const protocol = payload.protocol === 'https' ? 'https' : 'http';
    const port = Number.isInteger(payload.port) ? payload.port : DEFAULT_PORT;
    const timeout = Number.isInteger(payload.timeout) ? payload.timeout : DEFAULT_TIMEOUT;
    const url = `${protocol}://${host}:${port}/api/config`;

    const headers = { Accept: 'application/json' };
    if (payload.bearerToken) {
      headers.Authorization = `Bearer ${payload.bearerToken}`;
    } else if (payload.username || payload.password) {
      const credentials = `${payload.username || ''}:${payload.password || ''}`;
      headers.Authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
    }

    const init = { method: 'GET', headers, signal: AbortSignal.timeout(timeout) };

    if (payload.ignoreCertificateErrors && protocol === 'https') {
      const { Agent } = require('undici');
      init.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }

    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return { ok: false, message: `Request timed out after ${timeout}ms.` };
      }
      return { ok: false, message: `Connection failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (!response.ok) {
      return { ok: false, message: `Server responded with HTTP ${response.status}.` };
    }

    try {
      const body = await response.json();
      return { ok: true, message: body && body.version ? `Connected — OwnTone ${body.version}` : 'Connected.' };
    } catch {
      return { ok: true, message: 'Connected.' };
    }
  }
}

(() => new OwnTonePluginUiServer())();
